'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIRECTORY = path.join(__dirname, 'migrations');
const MIGRATION_FILENAME_PATTERN = /^(\d{3,})_([a-z][a-z0-9_]*)\.sql$/;
const MIGRATION_LOCK_ID = '3112026072001';

let poolInstance = null;

function databaseConfig(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for cloud services');
  let parsedUrl;
  try {
    parsedUrl = new URL(connectionString);
  } catch (_) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  }
  const hostname = parsedUrl.hostname;
  const isRds = /\.rds\.amazonaws\.com$/i.test(hostname);
  const legacyTlsProvider = /render\.com|neon\.tech|supabase\.(?:co|com)$/i.test(hostname);
  const legacyMode = env.PGSSLMODE;
  const sslMode = String(env.PG_SSL_MODE || legacyMode
    || (isRds ? 'verify-full' : legacyTlsProvider ? 'require' : 'disable')).toLowerCase();
  if (!['disable', 'require', 'verify-ca', 'verify-full'].includes(sslMode)) {
    throw new Error('PG_SSL_MODE must be disable, require, verify-ca, or verify-full');
  }
  if (env.PG_SSL_MODE && /[?&](?:sslmode|sslrootcert)=/i.test(connectionString)) {
    throw new Error('Put TLS settings in PG_SSL_MODE/PG_SSL_CA_PATH, not in DATABASE_URL');
  }
  let ssl;
  if (sslMode === 'require') {
    ssl = { rejectUnauthorized: false };
  } else if (sslMode === 'verify-ca' || sslMode === 'verify-full') {
    if (!env.PG_SSL_CA_PATH) {
      throw new Error(`${sslMode} requires PG_SSL_CA_PATH (use the AWS RDS CA bundle on RDS)`);
    }
    ssl = {
      ca: fs.readFileSync(path.resolve(env.PG_SSL_CA_PATH), 'utf8'),
      rejectUnauthorized: true
    };
  }
  const positiveInteger = (name, fallback, minimum = 1) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`${name} must be an integer of at least ${minimum}`);
    }
    return value;
  };
  return {
    connectionString,
    application_name: env.APP_NAME || 'nyc-311-cloud',
    max: positiveInteger('PG_POOL_SIZE', 10, 2),
    idleTimeoutMillis: positiveInteger('PG_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMillis: positiveInteger('PG_CONNECT_TIMEOUT_MS', 10_000),
    query_timeout: positiveInteger('PG_QUERY_TIMEOUT_MS', 30_000),
    statement_timeout: positiveInteger('PG_STATEMENT_TIMEOUT_MS', 30_000),
    idle_in_transaction_session_timeout: positiveInteger('PG_IDLE_TRANSACTION_TIMEOUT_MS', 120_000),
    keepAlive: true,
    options: '-c timezone=UTC',
    ssl
  };
}

function getPool() {
  if (poolInstance) return poolInstance;
  poolInstance = new Pool(databaseConfig());
  poolInstance.on('error', error => {
    console.error(JSON.stringify({ database_pool_error: error.message }));
  });
  return poolInstance;
}

// Keep the existing worker contract without constructing a real Pool during
// module loading. This lets migration helpers be imported in offline tests.
const pool = Object.freeze({
  connect: (...args) => getPool().connect(...args),
  query: (...args) => getPool().query(...args)
});

function migrationChecksum(sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

function parseMigrationFilename(filename) {
  const match = String(filename || '').match(MIGRATION_FILENAME_PATTERN);
  if (!match) {
    throw new Error(
      `Invalid migration filename "${filename}"; expected NNN_lowercase_name.sql`
    );
  }
  const numericVersion = BigInt(match[1]);
  if (numericVersion <= 0n) throw new Error(`Migration version must be positive: ${filename}`);
  return {
    version: numericVersion.toString(),
    numericVersion,
    description: match[2],
    filename
  };
}

function prepareMigrations(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('At least one SQL migration is required');
  }
  const migrations = entries.map(entry => {
    if (!entry || typeof entry.sql !== 'string' || !entry.sql.trim()) {
      throw new Error(`Migration ${entry && entry.filename || '<unknown>'} is empty`);
    }
    const parsed = parseMigrationFilename(entry.filename);
    return Object.freeze({
      ...parsed,
      sql: entry.sql,
      checksum: migrationChecksum(entry.sql)
    });
  }).sort((first, second) => (
    first.numericVersion < second.numericVersion ? -1
      : first.numericVersion > second.numericVersion ? 1 : 0
  ));

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].version === migrations[index].version) {
      throw new Error(
        `Duplicate migration version ${migrations[index].version}: `
        + `${migrations[index - 1].filename}, ${migrations[index].filename}`
      );
    }
  }
  return migrations;
}

function loadMigrations(directory = MIGRATIONS_DIRECTORY) {
  const filenames = fs.readdirSync(directory)
    .filter(filename => filename.endsWith('.sql'));
  return prepareMigrations(filenames.map(filename => ({
    filename,
    sql: fs.readFileSync(path.join(directory, filename), 'utf8')
  })));
}

function planMigrations(migrations, appliedRows) {
  const appliedByVersion = new Map();
  for (const row of appliedRows || []) {
    const version = BigInt(row.version).toString();
    if (appliedByVersion.has(version)) {
      throw new Error(`Duplicate applied migration version ${version}`);
    }
    appliedByVersion.set(version, row);
  }

  const migrationByVersion = new Map(migrations.map(migration => [migration.version, migration]));
  for (const [version, row] of appliedByVersion) {
    const migration = migrationByVersion.get(version);
    if (!migration) {
      throw new Error(
        `Database contains migration version ${version} (${row.name}) that is absent from this release`
      );
    }
    if (row.name !== migration.filename) {
      throw new Error(
        `Migration ${version} name mismatch: database has ${row.name}, release has ${migration.filename}`
      );
    }
    if (row.checksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.filename} checksum mismatch; applied migrations are immutable`
      );
    }
  }

  const pending = [];
  let foundPending = false;
  for (const migration of migrations) {
    if (appliedByVersion.has(migration.version)) {
      if (foundPending) {
        throw new Error(
          `Migration ${migration.filename} was applied after an earlier migration was skipped`
        );
      }
    } else {
      foundPending = true;
      pending.push(migration);
    }
  }
  return pending;
}

async function query(text, values = []) {
  return getPool().query(text, values);
}

async function transaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function postgisPreflightError(error) {
  const reason = error && error.message ? ` ${error.message}` : '';
  const wrapped = new Error(
    'PostGIS preflight failed. Ensure the PostgreSQL service supports PostGIS '
    + 'and the migration role may run CREATE EXTENSION postgis.' + reason
  );
  wrapped.code = 'POSTGIS_PREFLIGHT_FAILED';
  wrapped.cause = error;
  return wrapped;
}

async function ensurePostgis(client) {
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
    const result = await client.query('SELECT postgis_version() AS version');
    if (!result.rows || !result.rows[0] || !result.rows[0].version) {
      throw new Error('postgis_version() returned no version');
    }
    return result.rows[0].version;
  } catch (error) {
    throw postgisPreflightError(error);
  }
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version BIGINT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function applyMigration(client, migration) {
  await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    await client.query(`
      INSERT INTO schema_migrations (version, name, checksum)
      VALUES ($1::bigint, $2, $3)
    `, [migration.version, migration.filename, migration.checksum]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    const wrapped = new Error(`Migration ${migration.filename} failed: ${error.message}`);
    wrapped.code = 'MIGRATION_FAILED';
    wrapped.migration = migration.filename;
    wrapped.cause = error;
    throw wrapped;
  }
}

async function runMigrations(client, migrations) {
  await client.query("SET TIME ZONE 'UTC'");
  await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_ID]);
  let runError = null;
  try {
    const postgisVersion = await ensurePostgis(client);
    await ensureMigrationTable(client);
    const appliedResult = await client.query(`
      SELECT version::text AS version, name, checksum
      FROM schema_migrations
      ORDER BY version
    `);
    const pending = planMigrations(migrations, appliedResult.rows);
    for (const migration of pending) await applyMigration(client, migration);
    return {
      applied: pending.map(migration => migration.filename),
      currentVersion: migrations[migrations.length - 1].version,
      postgisVersion
    };
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_ID]);
    } catch (unlockError) {
      if (!runError) throw unlockError;
    }
  }
}

async function migrate({ client: suppliedClient = null, migrations = null,
  migrationsDirectory = MIGRATIONS_DIRECTORY } = {}) {
  const orderedMigrations = migrations || loadMigrations(migrationsDirectory);
  if (suppliedClient) return runMigrations(suppliedClient, orderedMigrations);

  const client = await getPool().connect();
  try {
    return await runMigrations(client, orderedMigrations);
  } finally {
    client.release();
  }
}

async function close() {
  if (!poolInstance) return;
  const activePool = poolInstance;
  poolInstance = null;
  await activePool.end();
}

module.exports = {
  MIGRATION_LOCK_ID,
  MIGRATIONS_DIRECTORY,
  applyMigration,
  close,
  databaseConfig,
  ensureMigrationTable,
  ensurePostgis,
  loadMigrations,
  migrate,
  migrationChecksum,
  parseMigrationFilename,
  planMigrations,
  pool,
  postgisPreflightError,
  prepareMigrations,
  query,
  runMigrations,
  transaction
};
