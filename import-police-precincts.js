'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { DatabaseSync } = require('node:sqlite');
const { resolveSynchronousMode } = require('./sqlite-runtime');
const { applyMigrations } = require('./sqlite-finalization');
const {
  PolicePrecinctMatcher,
  ensureSqlitePolicePrecinctSchema,
  normalizePrecinctCollection
} = require('./police-precincts');

const OFFICIAL_ARCHIVE_URL = 'https://s-media.nyc.gov/agencies/dcp/assets/files/zip/data-tools/bytes/police-precincts/nypp_26b.zip';
const DEFAULT_VERSION = '26B';
const DEFAULT_SOURCE_DATE = 'May 2026';
const DEFAULT_SHA256 = 'e9daed368fb5da1fbc8053f37405f658ff0d6d4ecca8245d05b42c3e62fa9727';

function usage() {
  return `Usage: node import-police-precincts.js [options]

Options:
  --db PATH          SQLite archive (defaults to DATABASE_PATH or data/portal-archive.sqlite)
  --file PATH        Read an already-downloaded DCP ZIP or GeoJSON file
  --url URL          Boundary URL (defaults to the versioned official DCP archive)
  --version VERSION  Boundary release label (default: ${DEFAULT_VERSION})
  --source-date TEXT Human-readable release date (default: ${DEFAULT_SOURCE_DATE})
  --sha256 DIGEST    Required source digest (default: pinned ${DEFAULT_VERSION} digest)
  --batch-size N     Backfill transaction size (default: 500)
  --help             Show this message`;
}

function parseArgs(argv) {
  const options = {
    databasePath: path.resolve(process.env.DATABASE_PATH || 'data/portal-archive.sqlite'),
    file: null,
    url: OFFICIAL_ARCHIVE_URL,
    version: DEFAULT_VERSION,
    sourceDate: DEFAULT_SOURCE_DATE,
    sha256: DEFAULT_SHA256,
    batchSize: 500
  };
  const valueOptions = new Map([
    ['--db', 'databasePath'], ['--file', 'file'], ['--url', 'url'],
    ['--version', 'version'], ['--source-date', 'sourceDate'],
    ['--sha256', 'sha256'], ['--batch-size', 'batchSize']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    const key = valueOptions.get(argument);
    if (!key || index + 1 >= argv.length) throw new Error(`Unknown or incomplete option: ${argument}`);
    options[key] = argv[++index];
  }
  options.databasePath = path.resolve(options.databasePath);
  if (options.file) options.file = path.resolve(options.file);
  options.version = String(options.version || '').trim().toUpperCase();
  options.sourceDate = String(options.sourceDate || '').trim();
  options.sha256 = String(options.sha256 || '').trim().toLowerCase();
  options.batchSize = Number(options.batchSize);
  if (!/^\d{2}[A-Z]\d?$/.test(options.version)) throw new Error('version must look like 26B');
  if (!/^[0-9a-f]{64}$/.test(options.sha256)) throw new Error('sha256 must be a 64-character hexadecimal digest');
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 5000) {
    throw new Error('batch-size must be an integer from 1 through 5000');
  }
  return options;
}

async function sourceBytes(options) {
  if (options.file) return fs.readFileSync(options.file);
  const response = await fetch(options.url, {
    headers: { Accept: 'application/zip,application/octet-stream,application/geo+json,application/json' },
    timeout: 30_000
  });
  if (!response.ok) throw new Error(`Boundary download returned HTTP ${response.status}`);
  return response.buffer();
}

async function parseBoundarySource(bytes) {
  const textPrefix = bytes.subarray(0, 32).toString('utf8').trimStart();
  if (textPrefix.startsWith('{')) return JSON.parse(bytes.toString('utf8'));
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('Boundary source must be a DCP ZIP archive or GeoJSON FeatureCollection');
  }
  const shapefile = await import('shpjs');
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const converted = await shapefile.default(arrayBuffer);
  if (Array.isArray(converted)) {
    if (converted.length !== 1) throw new Error('Boundary archive contains multiple shapefile layers');
    return converted[0];
  }
  return converted;
}

function installBoundaries(database, options, source, precincts, importedAt) {
  const existingVersion = database.prepare(`
    SELECT source_sha256 FROM police_precinct_boundary_versions WHERE version=?
  `).get(options.version);
  if (existingVersion && existingVersion.source_sha256 !== source.sha256) {
    throw new Error(
      `Boundary version ${options.version} is immutable and already has a different SHA-256`
    );
  }
  if (existingVersion) {
    const installed = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM police_precincts WHERE boundary_version=?
    `).get(options.version).count || 0);
    if (installed !== precincts.length) {
      throw new Error(
        `Boundary version ${options.version} is incomplete: expected ${precincts.length}, found ${installed}`
      );
    }
    return { unchanged: true };
  }
  const insertVersion = database.prepare(`
    INSERT INTO police_precinct_boundary_versions (
      version,source_url,source_sha256,source_date,imported_at,feature_count,active
    ) VALUES (?,?,?,?,?,?,0)
    ON CONFLICT(version) DO UPDATE SET
      source_url=excluded.source_url,
      source_sha256=excluded.source_sha256,
      source_date=excluded.source_date,
      imported_at=excluded.imported_at,
      feature_count=excluded.feature_count
  `);
  const insertPrecinct = database.prepare(`
    INSERT INTO police_precincts (
      boundary_version,precinct_number,label,geometry_json,
      min_longitude,min_latitude,max_longitude,max_latitude
    ) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(boundary_version,precinct_number) DO UPDATE SET
      label=excluded.label,
      geometry_json=excluded.geometry_json,
      min_longitude=excluded.min_longitude,
      min_latitude=excluded.min_latitude,
      max_longitude=excluded.max_longitude,
      max_latitude=excluded.max_latitude
  `);

  database.exec('BEGIN IMMEDIATE');
  try {
    insertVersion.run(
      options.version,
      options.file ? `file://${options.file}` : options.url,
      source.sha256,
      options.sourceDate || null,
      importedAt,
      precincts.length
    );
    database.prepare(`DELETE FROM police_precincts WHERE boundary_version=?`).run(options.version);
    for (const precinct of precincts) {
      insertPrecinct.run(
        options.version,
        precinct.precinctNumber,
        precinct.label,
        JSON.stringify(precinct.geometry),
        precinct.minLongitude,
        precinct.minLatitude,
        precinct.maxLongitude,
        precinct.maxLatitude
      );
    }
    database.exec('COMMIT');
    return { unchanged: false };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function activateBoundaries(database, version, activatedAt = new Date().toISOString()) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const boundary = database.prepare(`
      SELECT feature_count FROM police_precinct_boundary_versions WHERE version=?
    `).get(version);
    if (!boundary) throw new Error(`Boundary version ${version} is not installed`);
    const installed = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM police_precincts WHERE boundary_version=?
    `).get(version).count || 0);
    if (installed !== Number(boundary.feature_count)) {
      throw new Error(`Boundary version ${version} is incomplete: expected ${boundary.feature_count}, found ${installed}`);
    }
    const remaining = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM live_portal_requests
      WHERE live_portal_requests.latitude IS NOT NULL
        AND live_portal_requests.longitude IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM live_request_police_precinct_assignments AS staged
          WHERE staged.srnumber=live_portal_requests.srnumber
            AND staged.boundary_version=?
            AND staged.latitude=live_portal_requests.latitude
            AND staged.longitude=live_portal_requests.longitude
        )
    `).get(version).count || 0);
    if (remaining) {
      throw new Error(`Cannot activate boundary version ${version}; ${remaining} coordinate records remain`);
    }
    database.prepare(`
      UPDATE live_portal_requests
      SET police_precinct=(
            SELECT staged.precinct_number
            FROM live_request_police_precinct_assignments AS staged
            WHERE staged.srnumber=live_portal_requests.srnumber
              AND staged.boundary_version=?
          ),
          police_precinct_boundary_version=?,
          police_precinct_matched_at=(
            SELECT staged.matched_at
            FROM live_request_police_precinct_assignments AS staged
            WHERE staged.srnumber=live_portal_requests.srnumber
              AND staged.boundary_version=?
          )
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    `).run(version, version, version);
    database.prepare(`
      UPDATE police_precinct_boundary_versions SET active=0 WHERE active=1 AND version<>?
    `).run(version);
    database.prepare(`
      UPDATE police_precinct_boundary_versions SET active=1 WHERE version=?
    `).run(version);
    database.prepare(`
      DELETE FROM live_request_police_precinct_assignments
      WHERE boundary_version<>?
    `).run(version);
    database.prepare(`
      INSERT INTO live_monitor_state(key,value,updated_at)
      VALUES ('police_precinct_boundary_active',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).run(version, activatedAt);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function backfill(database, options, matcher, importedAt) {
  const selectBatch = database.prepare(`
    SELECT srnumber,latitude,longitude
    FROM live_portal_requests
    WHERE live_portal_requests.latitude IS NOT NULL
      AND live_portal_requests.longitude IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM live_request_police_precinct_assignments AS staged
        WHERE staged.srnumber=live_portal_requests.srnumber
          AND staged.boundary_version=?
          AND staged.latitude=live_portal_requests.latitude
          AND staged.longitude=live_portal_requests.longitude
      )
    ORDER BY suffix
    LIMIT ?
  `);
  const stageAssignment = database.prepare(`
    INSERT INTO live_request_police_precinct_assignments (
      srnumber,boundary_version,precinct_number,matched_at,latitude,longitude
    ) VALUES (?,?,?,?,?,?)
    ON CONFLICT(srnumber,boundary_version) DO UPDATE SET
      precinct_number=excluded.precinct_number,
      matched_at=excluded.matched_at,
      latitude=excluded.latitude,
      longitude=excluded.longitude
  `);
  const saveState = database.prepare(`
    INSERT INTO live_monitor_state(key,value,updated_at)
    VALUES ('police_precinct_backfill',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
  `);
  const counts = { processed: 0, matched: 0, unmatched: 0, ambiguous: 0 };
  while (true) {
    const rows = selectBatch.all(options.version, options.batchSize);
    if (!rows.length) break;
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const match = matcher.match(row.latitude, row.longitude);
        stageAssignment.run(
          row.srnumber,
          options.version,
          match ? match.precinctNumber : null,
          importedAt,
          row.latitude,
          row.longitude
        );
        counts.processed += 1;
        if (match) counts.matched += 1;
        else counts.unmatched += 1;
        if (match && match.ambiguous) counts.ambiguous += 1;
      }
      saveState.run(JSON.stringify({
        status: 'running', version: options.version, ...counts, updated_at: importedAt
      }), importedAt);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  const remaining = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM live_portal_requests
    WHERE live_portal_requests.latitude IS NOT NULL
      AND live_portal_requests.longitude IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM live_request_police_precinct_assignments AS staged
        WHERE staged.srnumber=live_portal_requests.srnumber
          AND staged.boundary_version=?
          AND staged.latitude=live_portal_requests.latitude
          AND staged.longitude=live_portal_requests.longitude
      )
  `).get(options.version).count || 0);
  const completedAt = new Date().toISOString();
  saveState.run(JSON.stringify({
    status: remaining ? 'incomplete' : 'complete', version: options.version,
    ...counts, remaining, started_at: importedAt, completed_at: completedAt
  }), completedAt);
  return { ...counts, remaining, completedAt };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const bytes = await sourceBytes(options);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== options.sha256) {
    throw new Error(`Boundary SHA-256 mismatch: expected ${options.sha256}, received ${sha256}`);
  }
  const collection = await parseBoundarySource(bytes);
  const precincts = normalizePrecinctCollection(collection, { expectedCount: 78 });
  const database = new DatabaseSync(options.databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=${resolveSynchronousMode(process.env.SQLITE_SYNCHRONOUS)};
      PRAGMA busy_timeout=10000;
      PRAGMA foreign_keys=ON;
    `);
    const importedAt = new Date().toISOString();
    applyMigrations(database, importedAt);
    ensureSqlitePolicePrecinctSchema(database);
    installBoundaries(database, options, { sha256 }, precincts, importedAt);
    const matcher = new PolicePrecinctMatcher(options.version, precincts.map(precinct => ({
      precinct_number: precinct.precinctNumber,
      geometry: precinct.geometry,
      min_longitude: precinct.minLongitude,
      min_latitude: precinct.minLatitude,
      max_longitude: precinct.maxLongitude,
      max_latitude: precinct.maxLatitude
    })));
    const result = backfill(database, options, matcher, importedAt);
    activateBoundaries(database, options.version, result.completedAt);
    console.log(JSON.stringify({
      database: options.databasePath,
      version: options.version,
      source_date: options.sourceDate,
      source_sha256: sha256,
      precincts: precincts.length,
      active: true,
      ...result
    }));
  } finally {
    database.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_SHA256,
  DEFAULT_SOURCE_DATE,
  DEFAULT_VERSION,
  OFFICIAL_ARCHIVE_URL,
  activateBoundaries,
  backfill,
  installBoundaries,
  parseArgs,
  parseBoundarySource,
  sourceBytes
};
