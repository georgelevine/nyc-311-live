'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync, backup: sqliteBackup } = require('node:sqlite');
const { normalizePortalTimestamp } = require('./portal-timestamp');

const APPLICATION_ID = 0x4e594333; // "NYC3"
const BUSY_TIMEOUT_MS = 5000;

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'add_live_number_queue_audit_due_index',
    sql: `CREATE INDEX IF NOT EXISTS live_number_queue_audit_due_idx
          ON live_number_queue (audit_outcome, audit_after, suffix)`
  }),
  Object.freeze({
    version: 2,
    name: 'add_police_precinct_geography',
    sql: `CREATE TABLE IF NOT EXISTS police_precinct_boundary_versions (
      version TEXT PRIMARY KEY,
      source_url TEXT NOT NULL,
      source_sha256 TEXT NOT NULL UNIQUE CHECK(length(source_sha256)=64),
      source_date TEXT,
      imported_at TEXT NOT NULL,
      feature_count INTEGER NOT NULL CHECK(feature_count>0),
      active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS police_precinct_one_active_version_idx
      ON police_precinct_boundary_versions(active) WHERE active=1;

    CREATE TABLE IF NOT EXISTS police_precincts (
      boundary_version TEXT NOT NULL,
      precinct_number INTEGER NOT NULL,
      label TEXT NOT NULL,
      geometry_json TEXT NOT NULL CHECK(json_valid(geometry_json)),
      min_longitude REAL NOT NULL,
      min_latitude REAL NOT NULL,
      max_longitude REAL NOT NULL,
      max_latitude REAL NOT NULL,
      PRIMARY KEY(boundary_version,precinct_number),
      FOREIGN KEY(boundary_version)
        REFERENCES police_precinct_boundary_versions(version) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS police_precinct_bbox_idx
      ON police_precincts(boundary_version,min_longitude,max_longitude,min_latitude,max_latitude);
    CREATE INDEX IF NOT EXISTS live_portal_requests_police_precinct_idx
      ON live_portal_requests(police_precinct,suffix DESC);`
  }),
  Object.freeze({
    version: 3,
    name: 'add_business_improvement_district_geography',
    sql: `CREATE TABLE IF NOT EXISTS business_improvement_district_boundary_versions (
      version TEXT PRIMARY KEY,
      source_url TEXT NOT NULL,
      source_sha256 TEXT NOT NULL UNIQUE CHECK(length(source_sha256)=64),
      source_date TEXT,
      imported_at TEXT NOT NULL,
      feature_count INTEGER NOT NULL CHECK(feature_count>0),
      active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS business_improvement_district_one_active_version_idx
      ON business_improvement_district_boundary_versions(active) WHERE active=1;

    CREATE TABLE IF NOT EXISTS business_improvement_districts (
      boundary_version TEXT NOT NULL,
      bid_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      borough_code INTEGER NOT NULL CHECK(borough_code BETWEEN 1 AND 5),
      borough_name TEXT NOT NULL,
      geometry_json TEXT NOT NULL CHECK(json_valid(geometry_json)),
      min_longitude REAL NOT NULL,
      min_latitude REAL NOT NULL,
      max_longitude REAL NOT NULL,
      max_latitude REAL NOT NULL,
      PRIMARY KEY(boundary_version,bid_id),
      FOREIGN KEY(boundary_version)
        REFERENCES business_improvement_district_boundary_versions(version) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS live_request_bid_memberships (
      srnumber TEXT NOT NULL,
      boundary_version TEXT NOT NULL,
      bid_id INTEGER NOT NULL,
      matched_at TEXT NOT NULL,
      PRIMARY KEY(srnumber,boundary_version,bid_id),
      FOREIGN KEY(srnumber)
        REFERENCES live_portal_requests(srnumber) ON DELETE CASCADE,
      FOREIGN KEY(boundary_version,bid_id)
        REFERENCES business_improvement_districts(boundary_version,bid_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS business_improvement_district_bbox_idx
      ON business_improvement_districts(
        boundary_version,min_longitude,max_longitude,min_latitude,max_latitude
      );
    CREATE INDEX IF NOT EXISTS live_request_bid_memberships_district_idx
      ON live_request_bid_memberships(boundary_version,bid_id,srnumber);`
  })
]);

function migrationChecksum(migration) {
  return crypto.createHash('sha256')
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest('hex');
}

function defaultLiveDatabasePath({ platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'nyc-bid-311', 'portal-archive.sqlite');
  }
  return path.join(home, '.local', 'share', 'nyc-bid-311', 'portal-archive.sqlite');
}

function resolveDatabasePath({ cliPath = null, env = process.env } = {}) {
  const selected = cliPath || env.SQLITE_PATH || defaultLiveDatabasePath();
  return path.resolve(String(selected));
}

function timestampedBackupPath(databasePath, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const parsed = path.parse(databasePath);
  return path.join(parsed.dir, 'backups', `${parsed.name}-${stamp}${parsed.ext || '.sqlite'}`);
}

function openDatabase(databasePath, { readOnly = false, busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
  const parsedBusyTimeout = Number(busyTimeoutMs);
  if (!Number.isInteger(parsedBusyTimeout) || parsedBusyTimeout < 0) {
    throw new TypeError('busyTimeoutMs must be a nonnegative integer');
  }
  const database = new DatabaseSync(databasePath, { readOnly });
  database.exec(`PRAGMA busy_timeout = ${parsedBusyTimeout}`);
  database.exec('PRAGMA foreign_keys = ON');
  const enabled = database.prepare('PRAGMA foreign_keys').get().foreign_keys;
  if (Number(enabled) !== 1) {
    database.close();
    throw new Error('Could not enable SQLite foreign-key enforcement');
  }
  return database;
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name));
}

function columnExists(database, table, column) {
  const identifier = `"${String(table).replace(/"/g, '""')}"`;
  return database.prepare(`PRAGMA table_info(${identifier})`).all()
    .some(row => row.name === column);
}

function addPolicePrecinctColumns(database) {
  const columns = [
    ['police_precinct', 'INTEGER'],
    ['police_precinct_boundary_version', 'TEXT'],
    ['police_precinct_matched_at', 'TEXT']
  ];
  for (const [name, type] of columns) {
    if (!columnExists(database, 'live_portal_requests', name)) {
      database.exec(`ALTER TABLE live_portal_requests ADD COLUMN ${name} ${type}`);
    }
  }
}

function addBusinessImprovementDistrictColumns(database) {
  const columns = [
    ['business_improvement_district_boundary_version', 'TEXT'],
    ['business_improvement_district_matched_at', 'TEXT']
  ];
  for (const [name, type] of columns) {
    if (!columnExists(database, 'live_portal_requests', name)) {
      database.exec(`ALTER TABLE live_portal_requests ADD COLUMN ${name} ${type}`);
    }
  }
}

function pragmaNumber(database, name) {
  const row = database.prepare(`PRAGMA ${name}`).get();
  return Number(row && Object.values(row)[0]);
}

function healthCheck(database) {
  const quick = database.prepare('PRAGMA quick_check').all().map(row => String(Object.values(row)[0]));
  const integrity = database.prepare('PRAGMA integrity_check').all().map(row => String(Object.values(row)[0]));
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all().map(row => ({ ...row }));
  return {
    ok: quick.length === 1 && quick[0] === 'ok'
      && integrity.length === 1 && integrity[0] === 'ok'
      && foreignKeys.length === 0,
    quick_check: quick,
    integrity_check: integrity,
    foreign_key_violations: foreignKeys
  };
}

function inspectMigrationState(database) {
  for (let index = 0; index < MIGRATIONS.length; index += 1) {
    const migration = MIGRATIONS[index];
    const previous = MIGRATIONS[index - 1];
    if (!Number.isInteger(migration.version) || migration.version < 1
        || (previous && migration.version <= previous.version)) {
      throw new Error('Migration catalog versions must be positive and strictly increasing');
    }
  }
  const applicationId = pragmaNumber(database, 'application_id');
  const userVersion = pragmaNumber(database, 'user_version');
  const latestVersion = MIGRATIONS[MIGRATIONS.length - 1].version;
  if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
    throw new Error(`Unexpected SQLite application_id ${applicationId}; refusing to finalize another database`);
  }
  if (userVersion > latestVersion) {
    throw new Error(`Database schema version ${userVersion} is newer than this tool (${latestVersion})`);
  }

  const appliedRows = tableExists(database, 'schema_migrations')
    ? database.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all()
    : [];
  const appliedByVersion = new Map(appliedRows.map(row => [Number(row.version), row]));
  for (const migration of MIGRATIONS) {
    const applied = appliedByVersion.get(migration.version);
    if (!applied) continue;
    const checksum = migrationChecksum(migration);
    if (applied.name !== migration.name || applied.checksum !== checksum) {
      throw new Error(`Migration ${migration.version} checksum/name mismatch`);
    }
  }
  const unknown = appliedRows.filter(row => !MIGRATIONS.some(item => item.version === Number(row.version)));
  if (unknown.length) throw new Error(`Unknown recorded migration ${unknown[0].version}`);
  for (let index = 0; index < appliedRows.length; index += 1) {
    if (Number(appliedRows[index].version) !== MIGRATIONS[index].version) {
      throw new Error('Recorded migrations are not a contiguous catalog prefix');
    }
  }
  if (appliedRows.length && userVersion !== Number(appliedRows[appliedRows.length - 1].version)) {
    throw new Error(`PRAGMA user_version ${userVersion} disagrees with schema_migrations`);
  }
  if (!appliedRows.length && userVersion !== 0) {
    throw new Error('PRAGMA user_version is set but schema_migrations is absent or empty');
  }

  return {
    application_id: applicationId,
    expected_application_id: APPLICATION_ID,
    user_version: userVersion,
    latest_version: latestVersion,
    applied: appliedRows.map(row => ({ ...row })),
    pending: MIGRATIONS.filter(item => !appliedByVersion.has(item.version)).map(item => ({
      version: item.version,
      name: item.name,
      checksum: migrationChecksum(item)
    }))
  };
}

function applyMigrations(database, appliedAt = new Date().toISOString()) {
  let state = inspectMigrationState(database);
  if (!state.pending.length && state.application_id === APPLICATION_ID) return state;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    database.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    for (const migration of MIGRATIONS) {
      const exists = database.prepare(
        'SELECT version, name, checksum FROM schema_migrations WHERE version=?'
      ).get(migration.version);
      if (exists) continue;
      // SQLite does not support ADD COLUMN IF NOT EXISTS. Keep this conditional
      // so databases already initialized by the live collector migrate cleanly.
      if (migration.version === 2) addPolicePrecinctColumns(database);
      if (migration.version === 3) addBusinessImprovementDistrictColumns(database);
      database.exec(migration.sql);
      database.prepare(`
        INSERT INTO schema_migrations (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, migrationChecksum(migration), appliedAt);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  state = inspectMigrationState(database);
  return state;
}

const normalizeSubmittedTimestamp = normalizePortalTimestamp;

const STALE_MAP_CANDIDATES_SQL = `
  SELECT queue.suffix
  FROM live_number_queue AS queue
  JOIN live_portal_requests AS live
    ON live.srnumber = queue.srnumber AND live.suffix = queue.suffix
  JOIN number_ledger AS ledger
    ON ledger.srnumber = queue.srnumber AND ledger.suffix = queue.suffix
  WHERE queue.map_seen = 0
    AND queue.audit_outcome = 'found'
    AND ledger.outcome = 'found'
    AND live.latitude IS NOT NULL AND live.longitude IS NOT NULL
    AND json_valid(live.raw_json) = 1
    AND COALESCE(json_extract(live.raw_json, '$.source'), 'map') = 'map'
    AND COALESCE(json_extract(live.raw_json, '$.coordinate_free'), 0) <> 1
    AND json_extract(live.raw_json, '$.data.srnumber') = live.srnumber
    AND json_extract(live.raw_json, '$.latitude') IS NOT NULL
    AND json_extract(live.raw_json, '$.longitude') IS NOT NULL
    AND ABS(CAST(json_extract(live.raw_json, '$.latitude') AS REAL) - live.latitude) < 0.0000001
    AND ABS(CAST(json_extract(live.raw_json, '$.longitude') AS REAL) - live.longitude) < 0.0000001
  ORDER BY queue.suffix
`;

function inspectDataChanges(database) {
  const staleMapSuffixes = database.prepare(STALE_MAP_CANDIDATES_SQL).all()
    .map(row => Number(row.suffix));
  const timestampRows = database.prepare(`
    SELECT srnumber, submitted_at FROM live_portal_requests
    WHERE submitted_at IS NOT NULL AND TRIM(submitted_at) <> ''
  `).all();
  const timestampChanges = [];
  let unparseableTimestamps = 0;
  for (const row of timestampRows) {
    const normalized = normalizeSubmittedTimestamp(row.submitted_at);
    if (!normalized) {
      unparseableTimestamps += 1;
      continue;
    }
    if (normalized !== row.submitted_at) {
      timestampChanges.push({ srnumber: row.srnumber, from: row.submitted_at, to: normalized });
    }
  }
  return {
    stale_map_seen_candidates: staleMapSuffixes,
    submitted_at_changes: timestampChanges,
    submitted_at_unparseable: unparseableTimestamps
  };
}

function applyDataChanges(database, inspected) {
  const updateMapSeen = database.prepare(`
    UPDATE live_number_queue SET map_seen = 1
    WHERE suffix = ?
      AND suffix IN (${STALE_MAP_CANDIDATES_SQL})
  `);
  const updateSubmittedAt = database.prepare(`
    UPDATE live_portal_requests SET submitted_at = ?
    WHERE srnumber = ? AND submitted_at = ?
  `);
  let repairedMapSeen = 0;
  let normalizedSubmittedAt = 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const suffix of inspected.stale_map_seen_candidates) {
      repairedMapSeen += Number(updateMapSeen.run(suffix).changes || 0);
    }
    for (const change of inspected.submitted_at_changes) {
      normalizedSubmittedAt += Number(
        updateSubmittedAt.run(change.to, change.srnumber, change.from).changes || 0
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return {
    map_seen_repaired: repairedMapSeen,
    submitted_at_normalized: normalizedSubmittedAt,
    submitted_at_unparseable: inspected.submitted_at_unparseable
  };
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function tableManifest(database) {
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(row => row.name);
  const manifest = {};
  for (const table of tables) {
    const identifier = quoteIdentifier(table);
    const columns = database.prepare(`PRAGMA table_info(${identifier})`).all().map(row => row.name);
    const row = database.prepare(
      columns.includes('suffix')
        ? `SELECT COUNT(*) AS count, MIN(suffix) AS min_suffix, MAX(suffix) AS max_suffix FROM ${identifier}`
        : `SELECT COUNT(*) AS count FROM ${identifier}`
    ).get();
    manifest[table] = Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key, typeof value === 'bigint' ? value.toString() : value
    ]));
  }
  return manifest;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function removeFileIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function linkFileWithoutOverwrite(partialPath, finalPath) {
  // A same-directory hard link is an atomic, no-overwrite promotion. Unlike
  // rename(), link() fails if finalPath appeared after our initial validation.
  fs.linkSync(partialPath, finalPath);
}

function validateBackupDestination(sourcePath, backupPath) {
  const resolvedBackup = path.resolve(backupPath);
  const manifestPath = `${resolvedBackup}.manifest.json`;
  const partialBackupPath = `${resolvedBackup}.partial`;
  const partialManifestPath = `${manifestPath}.partial`;
  if (resolvedBackup === path.resolve(sourcePath)) {
    throw new Error('Backup path must differ from source database');
  }
  const occupied = [resolvedBackup, manifestPath, partialBackupPath, partialManifestPath]
    .find(pathExists);
  if (occupied) {
    throw new Error(`Refusing to overwrite existing backup artifact: ${occupied}`);
  }
  return {
    resolvedBackup,
    manifestPath,
    partialBackupPath,
    partialManifestPath
  };
}

async function createBackup(
  database,
  sourcePath,
  backupPath,
  createdAt = new Date().toISOString(),
  { prepareDatabase = null } = {}
) {
  if (prepareDatabase != null && typeof prepareDatabase !== 'function') {
    throw new TypeError('prepareDatabase must be a function');
  }
  const {
    resolvedBackup,
    manifestPath,
    partialBackupPath,
    partialManifestPath
  } = validateBackupDestination(sourcePath, backupPath);
  fs.mkdirSync(path.dirname(resolvedBackup), { recursive: true });
  let promotedBackup = false;
  let promotedManifest = false;
  let preparation = null;
  try {
    const backupStartedAt = Date.now();
    // A larger page batch reduces restart/starvation risk while the collector is
    // writing. Routine duration remains visible in every verified manifest.
    await sqliteBackup(database, partialBackupPath, { rate: 10000 });
    const backupDurationMs = Date.now() - backupStartedAt;
    fs.chmodSync(partialBackupPath, 0o600);

    const backup = openDatabase(partialBackupPath);
    let backupHealth;
    let tables;
    let applicationId;
    let userVersion;
    let journalMode;
    try {
      if (prepareDatabase) preparation = await prepareDatabase(backup);
      const journalRow = backup.prepare('PRAGMA journal_mode = DELETE').get();
      journalMode = String(journalRow && Object.values(journalRow)[0] || '').toLowerCase();
      if (journalMode !== 'delete') {
        throw new Error(`Could not make backup self-contained; journal_mode is ${journalMode || 'unknown'}`);
      }
      backupHealth = healthCheck(backup);
      tables = tableManifest(backup);
      applicationId = pragmaNumber(backup, 'application_id');
      userVersion = pragmaNumber(backup, 'user_version');
    } finally {
      backup.close();
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (pathExists(`${partialBackupPath}${suffix}`)) {
        throw new Error(`Self-contained backup unexpectedly retained ${suffix}`);
      }
    }
    if (!backupHealth.ok) throw new Error('Backup failed SQLite health verification');
    const stat = fs.statSync(partialBackupPath);
    const manifest = {
      format: 'nyc-311-sqlite-backup-manifest-v1',
      created_at: createdAt,
      source_database: path.resolve(sourcePath),
      backup_database: resolvedBackup,
      backup_duration_ms: backupDurationMs,
      bytes: stat.size,
      sha256: await sha256File(partialBackupPath),
      application_id: applicationId,
      user_version: userVersion,
      journal_mode: journalMode,
      health: backupHealth,
      tables
    };
    fs.writeFileSync(partialManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600
    });
    linkFileWithoutOverwrite(partialBackupPath, resolvedBackup);
    promotedBackup = true;
    removeFileIfPresent(partialBackupPath);
    linkFileWithoutOverwrite(partialManifestPath, manifestPath);
    promotedManifest = true;
    removeFileIfPresent(partialManifestPath);
    const result = {
      path: resolvedBackup,
      manifest_path: manifestPath,
      backup_duration_ms: backupDurationMs,
      manifest
    };
    if (prepareDatabase) result.preparation = preparation;
    return result;
  } catch (error) {
    removeFileIfPresent(partialManifestPath);
    removeFileIfPresent(partialBackupPath);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      removeFileIfPresent(`${partialBackupPath}${suffix}`);
    }
    if (promotedManifest) removeFileIfPresent(manifestPath);
    if (promotedBackup) removeFileIfPresent(resolvedBackup);
    throw error;
  }
}

async function finalizeDatabase({
  databasePath,
  backupPath = null,
  verifyOnly = false,
  dryRun = false,
  busyTimeoutMs = BUSY_TIMEOUT_MS,
  now = new Date()
}) {
  if (verifyOnly && dryRun) throw new Error('--verify-only and --dry-run are mutually exclusive');
  const resolvedPath = path.resolve(databasePath);
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new Error(`SQLite path is not a regular file: ${resolvedPath}`);
  const readOnly = verifyOnly || dryRun;
  const proposedBackupPath = path.resolve(backupPath || timestampedBackupPath(resolvedPath, now));
  // Fail on deterministic destination problems before copying the source.
  if (!readOnly) validateBackupDestination(resolvedPath, proposedBackupPath);
  // The supplied database is never opened writable. Mutating work is performed
  // on a private partial copy and promoted only after it passes verification.
  const database = openDatabase(resolvedPath, { readOnly: true, busyTimeoutMs });
  try {
    const before = healthCheck(database);
    if (!before.ok) throw new Error('Source database failed pre-finalization health checks');
    const migrationsBefore = inspectMigrationState(database);
    const inspected = inspectDataChanges(database);
    let migrationsAfter = migrationsBefore;
    let changes = {
      map_seen_repaired: 0,
      submitted_at_normalized: 0,
      submitted_at_unparseable: inspected.submitted_at_unparseable
    };
    let after = before;
    const result = {
      database: resolvedPath,
      source_database: resolvedPath,
      finalized_database: null,
      mode: verifyOnly ? 'verify-only' : dryRun ? 'dry-run' : 'finalize',
      health_before: before,
      health_after: after,
      migrations_before: migrationsBefore,
      migrations_after: migrationsAfter,
      planned: {
        map_seen_repairs: inspected.stale_map_seen_candidates.length,
        submitted_at_normalizations: inspected.submitted_at_changes.length,
        submitted_at_unparseable: inspected.submitted_at_unparseable,
        backup_path: proposedBackupPath
      },
      changes,
      backup: null
    };
    if (!readOnly) {
      const created = await createBackup(
        database,
        resolvedPath,
        proposedBackupPath,
        now.toISOString(),
        {
          prepareDatabase(copy) {
            const copyBefore = healthCheck(copy);
            if (!copyBefore.ok) throw new Error('Copied database failed pre-finalization health checks');
            const copyMigrationsBefore = inspectMigrationState(copy);
            const copyInspected = inspectDataChanges(copy);
            const copyMigrationsAfter = applyMigrations(copy, now.toISOString());
            const copyChanges = applyDataChanges(copy, copyInspected);
            const copyAfter = healthCheck(copy);
            if (!copyAfter.ok) throw new Error('Finalized copy failed post-finalization health checks');
            return {
              health_before: copyBefore,
              health_after: copyAfter,
              migrations_before: copyMigrationsBefore,
              migrations_after: copyMigrationsAfter,
              inspected: copyInspected,
              changes: copyChanges
            };
          }
        }
      );
      const preparation = created.preparation;
      after = preparation.health_after;
      migrationsAfter = preparation.migrations_after;
      changes = preparation.changes;
      result.health_after = after;
      result.migrations_before = preparation.migrations_before;
      result.migrations_after = migrationsAfter;
      result.planned = {
        map_seen_repairs: preparation.inspected.stale_map_seen_candidates.length,
        submitted_at_normalizations: preparation.inspected.submitted_at_changes.length,
        submitted_at_unparseable: preparation.inspected.submitted_at_unparseable,
        backup_path: proposedBackupPath
      };
      result.changes = changes;
      result.finalized_database = created.path;
      const { preparation: _privatePreparation, ...publicBackup } = created;
      result.backup = publicBackup;
    }
    return result;
  } finally {
    database.close();
  }
}

module.exports = {
  APPLICATION_ID,
  BUSY_TIMEOUT_MS,
  MIGRATIONS,
  applyDataChanges,
  applyMigrations,
  createBackup,
  defaultLiveDatabasePath,
  finalizeDatabase,
  healthCheck,
  inspectDataChanges,
  inspectMigrationState,
  migrationChecksum,
  normalizeSubmittedTimestamp,
  openDatabase,
  resolveDatabasePath,
  sha256File,
  tableManifest,
  timestampedBackupPath,
  validateBackupDestination
};
