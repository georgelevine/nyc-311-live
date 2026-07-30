'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { DatabaseSync } = require('node:sqlite');
const { resolveSynchronousMode } = require('./sqlite-runtime');
const { applyMigrations } = require('./sqlite-finalization');
const {
  BusinessImprovementDistrictMatcher,
  ensureSqliteBusinessImprovementDistrictSchema,
  normalizeBusinessImprovementDistrictCollection
} = require('./business-improvement-districts');

const OFFICIAL_GEOJSON_URL = 'https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/BusinessImprovementDistrict_view/FeatureServer/0/query?where=1%3D1&outFields=BIDID%2CBID%2CBOROUGH&returnGeometry=true&outSR=4326&orderByFields=BIDID&f=geojson';
const DEFAULT_VERSION = '2026-04-28';
const DEFAULT_SOURCE_DATE = 'April 28, 2026';
const DEFAULT_SHA256 = 'a6600c7561dbfc0b077d80c1e4bbf981771a074e371952e7882fef8d93169d6b';

function usage() {
  return `Usage: node import-business-improvement-districts.js [options]

Options:
  --db PATH          SQLite archive (defaults to DATABASE_PATH or data/portal-archive.sqlite)
  --file PATH        Read an already-downloaded official GeoJSON file
  --url URL          Boundary URL (defaults to the pinned NYC Maps GeoJSON query)
  --version VERSION  Boundary release label (default: ${DEFAULT_VERSION})
  --source-date TEXT Human-readable data date (default: ${DEFAULT_SOURCE_DATE})
  --sha256 DIGEST    Required source digest (default: pinned release digest)
  --batch-size N     Backfill transaction size (default: 500)
  --help             Show this message`;
}

function parseArgs(argv) {
  const options = {
    databasePath: path.resolve(process.env.DATABASE_PATH || 'data/portal-archive.sqlite'),
    file: null,
    url: OFFICIAL_GEOJSON_URL,
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
  options.version = String(options.version || '').trim();
  options.sourceDate = String(options.sourceDate || '').trim();
  options.sha256 = String(options.sha256 || '').trim().toLowerCase();
  options.batchSize = Number(options.batchSize);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.version)) {
    throw new Error('version must use YYYY-MM-DD');
  }
  if (!/^[0-9a-f]{64}$/.test(options.sha256)) {
    throw new Error('sha256 must be a 64-character hexadecimal digest');
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 5000) {
    throw new Error('batch-size must be an integer from 1 through 5000');
  }
  return options;
}

async function sourceBytes(options) {
  if (options.file) return fs.readFileSync(options.file);
  const response = await fetch(options.url, {
    headers: { Accept: 'application/geo+json,application/json' },
    timeout: 30_000
  });
  if (!response.ok) throw new Error(`Boundary download returned HTTP ${response.status}`);
  return response.buffer();
}

function parseBoundarySource(bytes) {
  let collection;
  try {
    collection = JSON.parse(bytes.toString('utf8'));
  } catch (_) {
    throw new Error('Boundary source must be a GeoJSON FeatureCollection');
  }
  return collection;
}

function installBoundaries(database, options, source, districts, importedAt) {
  const existingVersion = database.prepare(`
    SELECT source_sha256 FROM business_improvement_district_boundary_versions WHERE version=?
  `).get(options.version);
  if (existingVersion && existingVersion.source_sha256 !== source.sha256) {
    throw new Error(
      `Boundary version ${options.version} is immutable and already has a different SHA-256`
    );
  }
  if (existingVersion) {
    const installed = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM business_improvement_districts WHERE boundary_version=?
    `).get(options.version).count || 0);
    if (installed !== districts.length) {
      throw new Error(
        `Boundary version ${options.version} is incomplete: expected ${districts.length}, found ${installed}`
      );
    }
    return { unchanged: true };
  }
  const insertVersion = database.prepare(`
    INSERT INTO business_improvement_district_boundary_versions (
      version,source_url,source_sha256,source_date,imported_at,feature_count,active
    ) VALUES (?,?,?,?,?,?,0)
    ON CONFLICT(version) DO UPDATE SET
      source_url=excluded.source_url,
      source_sha256=excluded.source_sha256,
      source_date=excluded.source_date,
      imported_at=excluded.imported_at,
      feature_count=excluded.feature_count
  `);
  const insertDistrict = database.prepare(`
    INSERT INTO business_improvement_districts (
      boundary_version,bid_id,name,borough_code,borough_name,geometry_json,
      min_longitude,min_latitude,max_longitude,max_latitude
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(boundary_version,bid_id) DO UPDATE SET
      name=excluded.name,
      borough_code=excluded.borough_code,
      borough_name=excluded.borough_name,
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
      districts.length
    );
    database.prepare(`
      DELETE FROM business_improvement_districts WHERE boundary_version=?
    `).run(options.version);
    for (const district of districts) {
      insertDistrict.run(
        options.version,
        district.bidId,
        district.name,
        district.boroughCode,
        district.boroughName,
        JSON.stringify(district.geometry),
        district.minLongitude,
        district.minLatitude,
        district.maxLongitude,
        district.maxLatitude
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
      SELECT feature_count FROM business_improvement_district_boundary_versions WHERE version=?
    `).get(version);
    if (!boundary) throw new Error(`Boundary version ${version} is not installed`);
    const installed = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM business_improvement_districts WHERE boundary_version=?
    `).get(version).count || 0);
    if (installed !== Number(boundary.feature_count)) {
      throw new Error(
        `Boundary version ${version} is incomplete: expected ${boundary.feature_count}, found ${installed}`
      );
    }
    const remaining = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM live_portal_requests
      WHERE live_portal_requests.latitude IS NOT NULL
        AND live_portal_requests.longitude IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM live_request_bid_assignment_versions AS staged
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
      SET business_improvement_district_boundary_version=?,
          business_improvement_district_matched_at=(
            SELECT staged.matched_at
            FROM live_request_bid_assignment_versions AS staged
            WHERE staged.srnumber=live_portal_requests.srnumber
              AND staged.boundary_version=?
          )
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    `).run(version, version);
    database.prepare(`
      UPDATE business_improvement_district_boundary_versions
      SET active=0 WHERE active=1 AND version<>?
    `).run(version);
    database.prepare(`
      UPDATE business_improvement_district_boundary_versions SET active=1 WHERE version=?
    `).run(version);
    // The active-version switch and old-membership cleanup commit together, so
    // readers observe either the complete old release or the complete new one.
    database.prepare(`
      DELETE FROM live_request_bid_memberships WHERE boundary_version<>?
    `).run(version);
    database.prepare(`
      DELETE FROM live_request_bid_assignment_versions WHERE boundary_version<>?
    `).run(version);
    database.prepare(`
      INSERT INTO live_monitor_state(key,value,updated_at)
      VALUES ('business_improvement_district_boundary_active',?,?)
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
        FROM live_request_bid_assignment_versions AS staged
        WHERE staged.srnumber=live_portal_requests.srnumber
          AND staged.boundary_version=?
          AND staged.latitude=live_portal_requests.latitude
          AND staged.longitude=live_portal_requests.longitude
      )
    ORDER BY suffix
    LIMIT ?
  `);
  const clearTargetMemberships = database.prepare(`
    DELETE FROM live_request_bid_memberships
    WHERE srnumber=? AND boundary_version=?
  `);
  const insertMembership = database.prepare(`
    INSERT INTO live_request_bid_memberships(srnumber,boundary_version,bid_id,matched_at)
    VALUES (?,?,?,?)
  `);
  const stageAssignment = database.prepare(`
    INSERT INTO live_request_bid_assignment_versions(
      srnumber,boundary_version,matched_at,latitude,longitude
    )
    VALUES (?,?,?,?,?)
    ON CONFLICT(srnumber,boundary_version) DO UPDATE SET
      matched_at=excluded.matched_at,
      latitude=excluded.latitude,
      longitude=excluded.longitude
  `);
  const saveState = database.prepare(`
    INSERT INTO live_monitor_state(key,value,updated_at)
    VALUES ('business_improvement_district_backfill',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
  `);
  const counts = {
    processed: 0,
    matched: 0,
    unmatched: 0,
    multiple_memberships: 0,
    memberships: 0
  };
  while (true) {
    const rows = selectBatch.all(options.version, options.batchSize);
    if (!rows.length) break;
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const match = matcher.match(row.latitude, row.longitude);
        const districts = match && Array.isArray(match.districts) ? match.districts : [];
        // Keep memberships from the currently active release available until
        // activation commits. This lets live BID filters continue serving one
        // complete release while the replacement is backfilled in batches.
        clearTargetMemberships.run(row.srnumber, options.version);
        for (const district of districts) {
          insertMembership.run(row.srnumber, options.version, district.bidId, importedAt);
          counts.memberships += 1;
        }
        stageAssignment.run(
          row.srnumber,
          options.version,
          importedAt,
          row.latitude,
          row.longitude
        );
        counts.processed += 1;
        if (districts.length) counts.matched += 1;
        else counts.unmatched += 1;
        if (match && match.ambiguous) counts.multiple_memberships += 1;
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
        FROM live_request_bid_assignment_versions AS staged
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
  const collection = parseBoundarySource(bytes);
  const districts = normalizeBusinessImprovementDistrictCollection(collection, { expectedCount: 78 });
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
    ensureSqliteBusinessImprovementDistrictSchema(database);
    installBoundaries(database, options, { sha256 }, districts, importedAt);
    const matcher = new BusinessImprovementDistrictMatcher(
      options.version,
      districts.map(district => ({
        bid_id: district.bidId,
        name: district.name,
        borough_code: district.boroughCode,
        borough_name: district.boroughName,
        geometry: district.geometry,
        min_longitude: district.minLongitude,
        min_latitude: district.minLatitude,
        max_longitude: district.maxLongitude,
        max_latitude: district.maxLatitude
      }))
    );
    const result = backfill(database, options, matcher, importedAt);
    activateBoundaries(database, options.version, result.completedAt);
    console.log(JSON.stringify({
      database: options.databasePath,
      version: options.version,
      source_date: options.sourceDate,
      source_sha256: sha256,
      business_improvement_districts: districts.length,
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
  OFFICIAL_GEOJSON_URL,
  activateBoundaries,
  backfill,
  installBoundaries,
  parseArgs,
  parseBoundarySource,
  sourceBytes
};
