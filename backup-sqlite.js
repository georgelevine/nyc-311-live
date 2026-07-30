#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  APPLICATION_ID,
  createBackup,
  healthCheck,
  inspectMigrationState,
  openDatabase,
  resolveDatabasePath,
  timestampedBackupPath
} = require('./sqlite-finalization');
const { verifySnapshot } = require('./sqlite-snapshot');

const STALE_PARTIAL_AGE_MS = 24 * 60 * 60 * 1000;
// 64 ordinary 4 KiB pages is a roughly 256 KiB backup step. This keeps each
// asynchronous SQLite backup burst short enough for the live writer and web
// reads to run between steps on the small Lightsail disk.
const DEFAULT_BACKUP_PAGE_RATE = 64;

function usage() {
  return `Usage: node backup-sqlite.js [database.sqlite] [options]

Options:
  --db PATH          Explicit source database
  --directory PATH   Backup directory (default BACKUP_DIRECTORY or source/backups)
  --retain COUNT     Number of verified local backups to retain (default 3)
  --page-rate COUNT  SQLite pages per backup step (default ${DEFAULT_BACKUP_PAGE_RATE})
  --help             Show this help`;
}

function parseArguments(argv) {
  const options = {
    cliPath: null,
    directory: null,
    retain: 3,
    pageRate: null,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
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

async function pruneBackups(directory, databasePath, retain) {
  const removed = [];
  const inspected = await verifiedManagedBackups(directory, databasePath);
  const retained = inspected.verified.slice(0, retain);
  for (const item of inspected.verified.slice(retain)) {
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
  pageRate = DEFAULT_BACKUP_PAGE_RATE,
  now = new Date(),
  stalePartialAgeMs = STALE_PARTIAL_AGE_MS
}) {
  if (!Number.isInteger(pageRate) || pageRate < 1 || pageRate > 10000) {
    throw new TypeError('Backup page rate must be an integer from 1 through 10000');
  }
  const resolvedDatabase = path.resolve(databasePath);
  if (!fs.existsSync(resolvedDatabase)) throw new Error(`SQLite database does not exist: ${resolvedDatabase}`);
  const resolvedDirectory = path.resolve(directory || path.join(path.dirname(resolvedDatabase), 'backups'));
  fs.mkdirSync(resolvedDirectory, { recursive: true, mode: 0o700 });
  const removedStalePartials = removeStaleManagedPartials(resolvedDirectory, resolvedDatabase, {
    now,
    stalePartialAgeMs
  });
  const artifactsBeforeBackup = inspectManagedArtifacts(resolvedDirectory, resolvedDatabase, {
    now,
    stalePartialAgeMs
  });
  const sourceBytes = fs.statSync(resolvedDatabase).size;
  const filesystem = fs.statfsSync(resolvedDirectory);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const requiredFreeBytes = Math.max(sourceBytes * 3, 256 * 1024 * 1024);
  if (!Number.isFinite(availableBytes) || availableBytes < requiredFreeBytes) {
    throw new Error(
      `Insufficient free space for a verified backup: require ${requiredFreeBytes} bytes, `
      + `have ${availableBytes}; ${artifactsBeforeBackup.orphans.length} orphaned managed artifact(s) require review`
    );
  }
  const proposed = timestampedBackupPath(resolvedDatabase, now);
  const destination = path.join(resolvedDirectory, path.basename(proposed));
  const database = openDatabase(resolvedDatabase, { readOnly: true });
  let created;
  try {
    const health = healthCheck(database);
    if (!health.ok) throw new Error('Source database failed health checks; backup was not created');
    const migrations = inspectMigrationState(database);
    if (migrations.application_id !== APPLICATION_ID || migrations.pending.length) {
      throw new Error('Source database must be finalized before routine cloud backups begin');
    }
    created = await createBackup(
      database,
      resolvedDatabase,
      destination,
      now.toISOString(),
      { rate: pageRate }
    );
  } finally {
    database.close();
  }
  try {
    await verifySnapshot({ databasePath: created.path, manifestPath: created.manifest_path });
  } catch (error) {
    if (fs.existsSync(created.manifest_path)) fs.unlinkSync(created.manifest_path);
    if (fs.existsSync(created.path)) fs.unlinkSync(created.path);
    throw new Error(`New backup failed archive verification: ${error.message}`);
  }
  const pruned = await pruneBackups(resolvedDirectory, resolvedDatabase, retain);
  const remainingArtifacts = inspectManagedArtifacts(resolvedDirectory, resolvedDatabase, {
    now,
    stalePartialAgeMs
  });
  return {
    ...created,
    backup_page_rate: pageRate,
    retained: pruned.retained.length,
    removed: pruned.removed,
    invalid_backups: pruned.invalid,
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
    pageRate: options.pageRate == null
      ? DEFAULT_BACKUP_PAGE_RATE
      : options.pageRate
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
  STALE_PARTIAL_AGE_MS,
  createRoutineBackup,
  inspectManagedArtifacts,
  main,
  managedArtifactPatterns,
  managedBackupManifests,
  parseArguments,
  pruneBackups,
  removeStaleManagedPartials,
  verifiedManagedBackups,
  usage
};
