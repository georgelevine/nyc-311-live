#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  APPLICATION_ID,
  MIGRATIONS,
  createBackup,
  inspectMigrationState,
  openDatabase,
  resolveDatabasePath,
  timestampedBackupPath,
  validateBackupCopyStrategy
} = require('./sqlite-finalization');
const {
  REQUIRED_ARCHIVE_TABLES,
  verifySnapshot,
  verifySnapshotDatabase
} = require('./sqlite-snapshot');

const STALE_PARTIAL_AGE_MS = 24 * 60 * 60 * 1000;
const MINIMUM_BACKUP_FREE_BYTES = 256 * 1024 * 1024;
// Small online-backup batches release SQLite's source read lock frequently so
// the collector and dashboard can keep using the live archive during a copy.
const DEFAULT_BACKUP_PAGE_RATE = 64;

function usage() {
  return `Usage: node backup-sqlite.js [database.sqlite] [options]

Options:
  --db PATH          Explicit source database
  --directory PATH   Backup directory (default BACKUP_DIRECTORY or source/backups)
  --retain COUNT     Number of verified local backups to retain (default 3)
  --exclusive        Confirm an external lock excludes every other backup run
  --page-rate COUNT  SQLite pages copied per online-backup step (default 64)
  --help             Show this help`;
}

function parseArguments(argv) {
  const options = {
    cliPath: null,
    directory: null,
    retain: 3,
    pageRate: null,
    exclusive: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--exclusive') options.exclusive = true;
    else if (argument === '--db' || argument === '--directory'
        || argument === '--retain' || argument === '--page-rate') {
      const value = argv[++index];
      if (value == null) throw new Error(`${argument} requires a value`);
      if (argument === '--db') options.cliPath = value;
      else if (argument === '--directory') options.directory = value;
      else if (argument === '--retain') {
        options.retain = Number(value);
        if (!Number.isInteger(options.retain) || options.retain < 1 || options.retain > 365) {
          throw new Error('--retain must be an integer from 1 through 365');
        }
      } else {
        options.pageRate = Number(value);
        if (!Number.isInteger(options.pageRate) || options.pageRate < 1
            || options.pageRate > 10000) {
          throw new Error('--page-rate must be an integer from 1 through 10000');
        }
      }
    } else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    else if (options.cliPath) throw new Error('Provide only one database path');
    else options.cliPath = argument;
  }
  return options;
}

function managedArtifactPatterns(databasePath) {
  const parsed = path.parse(databasePath);
  const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stem = `${escape(parsed.name)}-\\d{8}T\\d{6}Z${escape(parsed.ext || '.sqlite')}`;
  return {
    database: new RegExp(`^${stem}$`),
    manifest: new RegExp(`^${stem}\\.manifest\\.json$`),
    partialDatabase: new RegExp(`^${stem}\\.partial$`),
    partialSidecar: new RegExp(`^${stem}\\.partial-(?:wal|shm|journal)$`),
    partialManifest: new RegExp(`^${stem}\\.manifest\\.json\\.partial$`)
  };
}

function inspectManagedArtifacts(directory, databasePath, {
  now = new Date(),
  stalePartialAgeMs = STALE_PARTIAL_AGE_MS
} = {}) {
  if (!Number.isFinite(stalePartialAgeMs) || stalePartialAgeMs < 0) {
    throw new TypeError('stalePartialAgeMs must be a nonnegative finite number');
  }
  if (!fs.existsSync(directory)) return { partials: [], stale_partials: [], orphans: [] };
  const patterns = managedArtifactPatterns(databasePath);
  const names = fs.readdirSync(directory);
  const nameSet = new Set(names);
  const partials = [];
  const orphans = [];
  for (const name of names) {
    const artifactPath = path.join(directory, name);
    if (patterns.partialDatabase.test(name)
        || patterns.partialSidecar.test(name)
        || patterns.partialManifest.test(name)) {
      const stat = fs.lstatSync(artifactPath);
      partials.push({
        path: artifactPath,
        modified_at: stat.mtime.toISOString(),
        age_ms: Math.max(0, now.getTime() - stat.mtimeMs)
      });
      continue;
    }
    if (patterns.database.test(name) && !nameSet.has(`${name}.manifest.json`)) {
      orphans.push({ path: artifactPath, kind: 'database_without_manifest' });
      continue;
    }
    if (patterns.manifest.test(name)) {
      const databaseName = name.slice(0, -'.manifest.json'.length);
      if (!nameSet.has(databaseName)) {
        orphans.push({ path: artifactPath, kind: 'manifest_without_database' });
      }
    }
  }
  return {
    partials,
    stale_partials: partials.filter(item => item.age_ms >= stalePartialAgeMs),
    orphans
  };
}

function removeStaleManagedPartials(directory, databasePath, options = {}) {
  const inspected = inspectManagedArtifacts(directory, databasePath, options);
  const removed = [];
  for (const item of inspected.stale_partials) {
    try {
      fs.unlinkSync(item.path);
      removed.push(item.path);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

function removeAbandonedManagedPartials(directory, databasePath, {
  preservePaths = []
} = {}) {
  if (!Array.isArray(preservePaths)) {
    throw new TypeError('preservePaths must be an array');
  }
  const preserved = new Set(preservePaths.map(item => path.resolve(item)));
  const removed = [];
  const inspected = inspectManagedArtifacts(directory, databasePath);
  for (const item of inspected.partials) {
    if (preserved.has(path.resolve(item.path))) continue;
    try {
      fs.unlinkSync(item.path);
      removed.push(item.path);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

function fileSizeIfPresent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
}

function calculateBackupCapacity({
  sourceDatabaseBytes,
  sourceLogicalBytes,
  sourceWalBytes = 0,
  availableBytes
}) {
  const values = {
    sourceDatabaseBytes,
    sourceLogicalBytes,
    sourceWalBytes,
    availableBytes
  };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a nonnegative safe integer`);
    }
  }
  if (sourceLogicalBytes < 1) {
    throw new TypeError('sourceLogicalBytes must be positive');
  }
  // The backup output can be as large as the logical database even when most
  // committed pages still live only in the WAL. Keep two additional logical
  // database sizes plus the current WAL size available for writer growth,
  // validation I/O, and an interrupted partial awaiting cleanup.
  const requiredFreeBytes = Math.max(
    sourceLogicalBytes * 3 + sourceWalBytes,
    MINIMUM_BACKUP_FREE_BYTES
  );
  if (!Number.isSafeInteger(requiredFreeBytes)) {
    throw new Error('Calculated backup capacity exceeds the safe integer range');
  }
  return {
    source_database_bytes: sourceDatabaseBytes,
    source_logical_bytes: sourceLogicalBytes,
    source_wal_bytes: sourceWalBytes,
    available_bytes: availableBytes,
    required_free_bytes: requiredFreeBytes,
    safety_headroom_bytes: requiredFreeBytes - sourceLogicalBytes,
    ok: availableBytes >= requiredFreeBytes
  };
}

function managedBackupManifests(directory, databasePath) {
  const pattern = managedArtifactPatterns(databasePath).manifest;
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => pattern.test(name))
    .map(name => {
      const manifestPath = path.join(directory, name);
      let createdAt = fs.statSync(manifestPath).mtimeMs;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const parsedTime = Date.parse(manifest.created_at);
        if (Number.isFinite(parsedTime)) createdAt = parsedTime;
      } catch (_) {}
      return {
        manifestPath,
        databasePath: manifestPath.slice(0, -'.manifest.json'.length),
        createdAt
      };
    })
    .sort((left, right) => right.createdAt - left.createdAt);
}

async function verifiedManagedBackups(directory, databasePath) {
  const verified = [];
  const invalid = [];
  for (const item of managedBackupManifests(directory, databasePath)) {
    try {
      await verifySnapshot({ databasePath: item.databasePath, manifestPath: item.manifestPath });
      verified.push(item);
    } catch (error) {
      invalid.push({ ...item, error: error.message });
    }
  }
  return { verified, invalid };
}

function inspectTrustedManagedBackup(item, sourceDatabasePath) {
  let manifest;
  try {
    const databaseStat = fs.lstatSync(item.databasePath);
    const manifestStat = fs.lstatSync(item.manifestPath);
    if (!databaseStat.isFile()) throw new Error('backup database is not a regular file');
    if (!manifestStat.isFile()) throw new Error('backup manifest is not a regular file');
    manifest = JSON.parse(fs.readFileSync(item.manifestPath, 'utf8'));
    if (manifest.format !== 'nyc-311-sqlite-backup-manifest-v1') {
      throw new Error(`unsupported manifest format ${manifest.format || 'missing'}`);
    }
    try {
      validateBackupCopyStrategy(manifest.copy_strategy, { allowMissing: true });
    } catch (error) {
      throw new Error(`unsupported copy strategy: ${error.message}`);
    }
    if (path.resolve(manifest.source_database || '') !== path.resolve(sourceDatabasePath)) {
      throw new Error('manifest source database does not match this backup set');
    }
    if (path.resolve(manifest.backup_database || '') !== path.resolve(item.databasePath)) {
      throw new Error('manifest backup path does not match its database');
    }
    if (!Number.isFinite(Date.parse(manifest.created_at))) {
      throw new Error('manifest creation timestamp is invalid');
    }
    if (Number(manifest.bytes) !== databaseStat.size) {
      throw new Error('backup byte count no longer matches its manifest');
    }
    if (databaseStat.mtimeMs > manifestStat.mtimeMs + 1) {
      throw new Error('backup database changed after its manifest was written');
    }
    if (!/^[a-f0-9]{64}$/.test(String(manifest.sha256 || ''))) {
      throw new Error('manifest does not contain a valid SHA-256 digest');
    }
    const latestVersion = MIGRATIONS[MIGRATIONS.length - 1].version;
    if (Number(manifest.application_id) !== APPLICATION_ID
        || Number(manifest.user_version) !== latestVersion) {
      throw new Error('manifest does not describe the current NYC 311 archive schema');
    }
    if (String(manifest.journal_mode || '').toLowerCase() !== 'delete') {
      throw new Error('manifest is not for a self-contained DELETE-journal backup');
    }
    const health = manifest.health;
    if (!health || health.ok !== true
        || !Array.isArray(health.integrity_check)
        || health.integrity_check.length !== 1
        || health.integrity_check[0] !== 'ok'
        || !Array.isArray(health.foreign_key_violations)
        || health.foreign_key_violations.length !== 0) {
      throw new Error('manifest does not record successful integrity and foreign-key checks');
    }
    if (health.quick_check !== null
        && (!Array.isArray(health.quick_check)
          || health.quick_check.length !== 1
          || health.quick_check[0] !== 'ok')) {
      throw new Error('manifest quick-check result is invalid');
    }
    if (!manifest.tables || typeof manifest.tables !== 'object') {
      throw new Error('manifest table catalog is missing');
    }
    const missingTables = REQUIRED_ARCHIVE_TABLES
      .filter(name => !Object.hasOwn(manifest.tables, name));
    if (missingTables.length) {
      throw new Error(`manifest is missing archive table(s): ${missingTables.join(', ')}`);
    }
    const manifestMode = manifest.table_manifest_mode || 'row_counts';
    if (!['schema', 'row_counts'].includes(manifestMode)) {
      throw new Error(`manifest table catalog mode is unsupported: ${manifestMode}`);
    }
    if (manifestMode === 'schema') {
      const invalidSchemaTables = REQUIRED_ARCHIVE_TABLES.filter(name => {
        const entry = manifest.tables[name];
        return !entry || !Array.isArray(entry.columns) || entry.columns.length === 0;
      });
      if (invalidSchemaTables.length) {
        throw new Error(`manifest schema catalog is incomplete: ${invalidSchemaTables.join(', ')}`);
      }
      if (!manifest.verification) {
        throw new Error('schema-only manifest is missing its archive verification receipt');
      }
    } else {
      const invalidCountTables = REQUIRED_ARCHIVE_TABLES.filter(name => {
        const count = manifest.tables[name] && manifest.tables[name].count;
        return !Number.isInteger(Number(count)) || Number(count) < 0;
      });
      if (invalidCountTables.length) {
        throw new Error(`legacy table-count catalog is incomplete: ${invalidCountTables.join(', ')}`);
      }
    }
    if (manifest.verification != null) {
      const verification = manifest.verification;
      const valid = verification.status === 'verified'
        && Number.isFinite(Date.parse(verification.verified_at))
        && verification.integrity_check === 'ok'
        && verification.foreign_key_check === 'ok'
        && verification.migration_catalog === 'ok'
        && verification.archive_contract === 'ok'
        && verification.sha256 === 'recorded';
      if (!valid) throw new Error('manifest verification receipt is incomplete');
    }
    return {
      ...item,
      trust_basis: manifest.verification
        ? 'atomic_verified_manifest'
        : 'legacy_atomic_verified_manifest'
    };
  } catch (error) {
    return { ...item, error: error.message };
  }
}

async function trustedManagedBackups(directory, databasePath) {
  const trusted = [];
  const invalid = [];
  for (const item of managedBackupManifests(directory, databasePath)) {
    const inspected = inspectTrustedManagedBackup(item, databasePath);
    if (inspected.error) invalid.push(inspected);
    else trusted.push(inspected);
  }
  return { trusted, invalid };
}

async function pruneBackups(directory, databasePath, retain) {
  const removed = [];
  const inspected = await trustedManagedBackups(directory, databasePath);
  const retained = inspected.trusted.slice(0, retain);
  for (const item of inspected.trusted.slice(retain)) {
    if (fs.existsSync(item.databasePath)) fs.unlinkSync(item.databasePath);
    if (fs.existsSync(item.manifestPath)) fs.unlinkSync(item.manifestPath);
    removed.push(item.databasePath);
  }
  return { removed, invalid: inspected.invalid, retained };
}

async function createRoutineBackup({
  databasePath,
  directory,
  retain = 3,
  pageRate = null,
  exclusiveRun = false,
  now = new Date(),
  stalePartialAgeMs = STALE_PARTIAL_AGE_MS,
  onIoPass = null
}) {
  if (pageRate != null
      && (!Number.isInteger(pageRate) || pageRate < 1 || pageRate > 10000)) {
    throw new TypeError('Backup page rate must be an integer from 1 through 10000');
  }
  if (typeof exclusiveRun !== 'boolean') {
    throw new TypeError('exclusiveRun must be a boolean');
  }
  if (onIoPass != null && typeof onIoPass !== 'function') {
    throw new TypeError('onIoPass must be a function');
  }
  const ioOperations = [];
  const observeIo = operation => {
    ioOperations.push(operation);
    if (onIoPass) onIoPass(operation);
  };
  const resolvedDatabase = path.resolve(databasePath);
  if (!fs.existsSync(resolvedDatabase)) throw new Error(`SQLite database does not exist: ${resolvedDatabase}`);
  const resolvedDirectory = path.resolve(directory || path.join(path.dirname(resolvedDatabase), 'backups'));
  fs.mkdirSync(resolvedDirectory, { recursive: true, mode: 0o700 });
  const partialsBeforeCleanup = inspectManagedArtifacts(resolvedDirectory, resolvedDatabase, {
    now,
    stalePartialAgeMs
  });
  const stalePartialPaths = new Set(
    partialsBeforeCleanup.stale_partials.map(item => path.resolve(item.path))
  );
  // Removing every pre-existing partial is safe only while an external lock
  // proves that no other backup process can own one. Without that proof, retain
  // all partials (including old ones) so a legitimately long active copy is
  // never unlinked by a concurrent invocation.
  const removedAbandonedPartials = exclusiveRun
    ? removeAbandonedManagedPartials(resolvedDirectory, resolvedDatabase)
    : [];
  const removedStalePartials = removedAbandonedPartials
    .filter(item => stalePartialPaths.has(path.resolve(item)));
  const artifactsBeforeBackup = inspectManagedArtifacts(resolvedDirectory, resolvedDatabase, {
    now,
    stalePartialAgeMs
  });
  const proposed = timestampedBackupPath(resolvedDatabase, now);
  const destination = path.join(resolvedDirectory, path.basename(proposed));
  const database = openDatabase(resolvedDatabase, { readOnly: true });
  let created;
  let capacityPreflight;
  try {
    const migrations = inspectMigrationState(database);
    if (migrations.application_id !== APPLICATION_ID || migrations.pending.length) {
      throw new Error('Source database must be finalized before routine cloud backups begin');
    }
    const pageSize = Number(database.prepare('PRAGMA page_size').get().page_size);
    const pageCount = Number(database.prepare('PRAGMA page_count').get().page_count);
    const filesystem = fs.statfsSync(resolvedDirectory);
    capacityPreflight = calculateBackupCapacity({
      sourceDatabaseBytes: fs.statSync(resolvedDatabase).size,
      sourceLogicalBytes: pageSize * pageCount,
      sourceWalBytes: fileSizeIfPresent(`${resolvedDatabase}-wal`),
      availableBytes: Number(filesystem.bavail) * Number(filesystem.bsize)
    });
    if (!capacityPreflight.ok) {
      throw new Error(
        'Insufficient free space for a verified backup: '
        + `require ${capacityPreflight.required_free_bytes} bytes, `
        + `have ${capacityPreflight.available_bytes}; logical database `
        + `${capacityPreflight.source_logical_bytes} bytes, WAL `
        + `${capacityPreflight.source_wal_bytes} bytes; `
        + `${artifactsBeforeBackup.orphans.length} orphaned managed artifact(s) require review`
      );
    }
    created = await createBackup(
      database,
      resolvedDatabase,
      destination,
      now.toISOString(),
      {
        copyStrategy: 'online_backup',
        rate: pageRate || DEFAULT_BACKUP_PAGE_RATE,
        healthCheckOptions: { runQuickCheck: false },
        tableManifestOptions: { includeRowCounts: false },
        onIoPass: observeIo,
        validateDatabase({
          database: backup,
          health,
          tables,
          applicationId,
          userVersion,
          journalMode
        }) {
          observeIo('backup_archive_contract');
          return verifySnapshotDatabase({
            database: backup,
            health,
            tables,
            manifest: {
              application_id: applicationId,
              user_version: userVersion,
              journal_mode: journalMode,
              tables
            }
          });
        }
      }
    );
  } finally {
    database.close();
  }
  const pruned = await pruneBackups(resolvedDirectory, resolvedDatabase, retain);
  const remainingArtifacts = inspectManagedArtifacts(resolvedDirectory, resolvedDatabase, {
    now,
    stalePartialAgeMs
  });
  return {
    ...created,
    backup_page_rate: pageRate || DEFAULT_BACKUP_PAGE_RATE,
    capacity_preflight: capacityPreflight,
    io_operations: ioOperations,
    io_operation_counts: Object.fromEntries(
      [...new Set(ioOperations)].map(operation => [
        operation,
        ioOperations.filter(item => item === operation).length
      ])
    ),
    full_file_passes: [
      'source_online_copy',
      'backup_integrity_check',
      'backup_sha256'
    ],
    retained: pruned.retained.length,
    removed: pruned.removed,
    invalid_backups: pruned.invalid,
    exclusive_run: exclusiveRun,
    removed_abandoned_partials: removedAbandonedPartials,
    removed_stale_partials: removedStalePartials,
    pending_partials: remainingArtifacts.partials,
    orphaned_artifacts: remainingArtifacts.orphans
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const databasePath = resolveDatabasePath({ cliPath: options.cliPath, env });
  const result = await createRoutineBackup({
    databasePath,
    directory: options.directory || env.BACKUP_DIRECTORY,
    retain: options.retain,
    pageRate: options.pageRate,
    exclusiveRun: options.exclusive
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_BACKUP_PAGE_RATE,
  MINIMUM_BACKUP_FREE_BYTES,
  STALE_PARTIAL_AGE_MS,
  calculateBackupCapacity,
  createRoutineBackup,
  inspectManagedArtifacts,
  main,
  managedArtifactPatterns,
  managedBackupManifests,
  parseArguments,
  pruneBackups,
  removeAbandonedManagedPartials,
  removeStaleManagedPartials,
  trustedManagedBackups,
  verifiedManagedBackups,
  usage
};
