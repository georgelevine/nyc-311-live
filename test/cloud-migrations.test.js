'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIGRATION_LOCK_ID,
  databaseConfig,
  loadMigrations,
  migrationChecksum,
  parseMigrationFilename,
  planMigrations,
  pool,
  prepareMigrations,
  runMigrations
} = require('../cloud/db');

function fixtureMigrations() {
  return prepareMigrations([
    { filename: '002_second.sql', sql: 'SELECT 2;\n' },
    { filename: '001_first.sql', sql: 'SELECT 1;\n' },
    { filename: '003_third.sql', sql: 'SELECT 3;\n' }
  ]);
}

class FakeMigrationClient {
  constructor({ appliedRows = [], failSql = null, failPostgis = false } = {}) {
    this.appliedRows = appliedRows;
    this.failSql = failSql;
    this.failPostgis = failPostgis;
    this.calls = [];
  }

  async query(text, values = []) {
    const sql = String(text).trim();
    this.calls.push({ sql, values });
    if (this.failPostgis && sql === 'CREATE EXTENSION IF NOT EXISTS postgis') {
      throw new Error('extension postgis is not available');
    }
    if (sql === 'SELECT postgis_version() AS version') {
      return { rows: [{ version: '3.4.2' }] };
    }
    if (/FROM schema_migrations\s+ORDER BY version/.test(sql)) {
      return { rows: this.appliedRows };
    }
    if (this.failSql && sql === this.failSql) throw new Error('synthetic SQL failure');
    if (sql.startsWith('SELECT pg_advisory_unlock')) {
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    return { rows: [] };
  }
}

test('migration filenames, ordering, and SHA-256 checksums are deterministic', () => {
  assert.equal(typeof pool.connect, 'function');
  assert.equal(
    migrationChecksum('SELECT 1;\n'),
    'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd'
  );
  assert.deepEqual(
    fixtureMigrations().map(migration => [migration.version, migration.filename]),
    [
      ['1', '001_first.sql'],
      ['2', '002_second.sql'],
      ['3', '003_third.sql']
    ]
  );
  assert.equal(parseMigrationFilename('0007_add_queue.sql').version, '7');
  assert.throws(
    () => parseMigrationFilename('7-AddQueue.sql'),
    /expected NNN_lowercase_name\.sql/
  );
  assert.throws(
    () => prepareMigrations([
      { filename: '001_first.sql', sql: 'SELECT 1' },
      { filename: '0001_duplicate.sql', sql: 'SELECT 2' }
    ]),
    /Duplicate migration version 1/
  );
});

test('database config requires verified CA trust for Amazon RDS', () => {
  const base = { DATABASE_URL: 'postgresql://user:pass@db.example.us-east-1.rds.amazonaws.com:5432/nyc311' };
  assert.throws(() => databaseConfig(base), /verify-full requires PG_SSL_CA_PATH/);
  const directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nyc311-ca-'));
  const caPath = path.join(directory, 'rds-ca.pem');
  fs.writeFileSync(caPath, 'test-ca');
  const config = databaseConfig({ ...base, PG_SSL_CA_PATH: caPath, PG_POOL_SIZE: '5' });
  assert.equal(config.max, 5);
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.ca, 'test-ca');
  assert.equal(config.options, '-c timezone=UTC');
  fs.rmSync(directory, { recursive: true });
});

test('migration planning accepts only an unmodified ordered prefix', () => {
  const migrations = fixtureMigrations();
  const appliedFirst = [{
    version: '1',
    name: migrations[0].filename,
    checksum: migrations[0].checksum
  }];
  assert.deepEqual(
    planMigrations(migrations, appliedFirst).map(migration => migration.version),
    ['2', '3']
  );
  assert.throws(
    () => planMigrations(migrations, [{ ...appliedFirst[0], checksum: '0'.repeat(64) }]),
    /checksum mismatch; applied migrations are immutable/
  );
  assert.throws(
    () => planMigrations(migrations, [{
      version: '2', name: migrations[1].filename, checksum: migrations[1].checksum
    }]),
    /applied after an earlier migration was skipped/
  );
  assert.throws(
    () => planMigrations(migrations, [{
      version: '99', name: '099_future.sql', checksum: 'f'.repeat(64)
    }]),
    /absent from this release/
  );
});

test('the checked-in migrations contain closure parity and import-run audit schema', () => {
  const migrations = loadMigrations();
  assert.deepEqual(migrations.map(migration => migration.filename), [
    '001_initial_cloud_schema.sql',
    '002_closure_tracking_parity.sql',
    '003_sqlite_import_runs.sql',
    '004_request_borough_zip.sql'
  ]);
  const closureSql = migrations[1].sql;
  for (const token of [
    'previous_status', 'effective_at', 'snapshot_json',
    'request_closure_snapshots', 'request_followup_queue',
    'last_success_at', 'request_closure_snapshots_final_idx',
    'DROP CONSTRAINT IF EXISTS request_status_history_srnumber_status_observed_at_key'
  ]) assert.match(closureSql, new RegExp(`\\b${token}\\b`));

  const auditSql = migrations[2].sql;
  for (const token of [
    'run_id', 'source_sha256', 'source_name', 'source_manifest',
    'target_manifest', 'started_at', 'completed_at', 'status', 'error'
  ]) assert.match(auditSql, new RegExp(`\\b${token}\\b`));

  const geographySql = migrations[3].sql;
  for (const token of ['borough', 'incident_zip']) {
    assert.match(geographySql, new RegExp(`\\b${token}\\b`));
  }

  const canonicalSchema = fs.readFileSync(
    path.join(__dirname, '..', 'cloud', 'schema.sql'),
    'utf8'
  );
  for (const table of [
    'schema_migrations', 'request_status_history', 'request_closure_snapshots',
    'request_followup_queue', 'sqlite_import_runs'
  ]) assert.match(canonicalSchema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
});

test('runner sets UTC, takes one advisory lock, and applies each migration transactionally', async () => {
  const migrations = fixtureMigrations().slice(0, 2);
  const client = new FakeMigrationClient();
  const result = await runMigrations(client, migrations);
  assert.deepEqual(result, {
    applied: ['001_first.sql', '002_second.sql'],
    currentVersion: '2',
    postgisVersion: '3.4.2'
  });

  assert.equal(client.calls[0].sql, "SET TIME ZONE 'UTC'");
  assert.deepEqual(client.calls[1], {
    sql: 'SELECT pg_advisory_lock($1::bigint)',
    values: [MIGRATION_LOCK_ID]
  });
  assert.equal(client.calls.filter(call => call.sql === 'BEGIN').length, 2);
  assert.equal(client.calls.filter(call => call.sql === 'COMMIT').length, 2);
  assert.equal(client.calls.filter(call => call.sql.startsWith('INSERT INTO schema_migrations')).length, 2);
  assert.equal(client.calls.at(-1).sql, 'SELECT pg_advisory_unlock($1::bigint)');
});

test('runner rolls a failed migration back and still releases its lock', async () => {
  const migrations = fixtureMigrations().slice(0, 1);
  const client = new FakeMigrationClient({ failSql: migrations[0].sql.trim() });
  await assert.rejects(
    runMigrations(client, migrations),
    error => error.code === 'MIGRATION_FAILED' && error.migration === '001_first.sql'
  );
  assert.ok(client.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(client.calls.at(-1).sql, 'SELECT pg_advisory_unlock($1::bigint)');
});

test('PostGIS preflight failures are actionable and release the migration lock', async () => {
  const client = new FakeMigrationClient({ failPostgis: true });
  await assert.rejects(
    runMigrations(client, fixtureMigrations().slice(0, 1)),
    error => error.code === 'POSTGIS_PREFLIGHT_FAILED'
      && /migration role may run CREATE EXTENSION postgis/.test(error.message)
  );
  assert.equal(client.calls.at(-1).sql, 'SELECT pg_advisory_unlock($1::bigint)');
});
