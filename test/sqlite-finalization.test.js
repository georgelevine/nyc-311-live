'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { parseArguments } = require('../finalize-sqlite');
const {
  APPLICATION_ID,
  MIGRATIONS,
  applyDataChanges,
  applyMigrations,
  defaultLiveDatabasePath,
  finalizeDatabase,
  inspectDataChanges,
  migrationChecksum,
  normalizeSubmittedTimestamp,
  resolveDatabasePath,
  timestampedBackupPath
} = require('../sqlite-finalization');

const NOW = new Date('2026-07-20T22:15:30.000Z');

function requestNumber(suffix) {
  return `311-${String(suffix).padStart(8, '0')}`;
}

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc-311-finalize-'));
  const databasePath = path.join(directory, 'portal-archive.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY,
      suffix INTEGER UNIQUE,
      portal_id TEXT UNIQUE,
      problem TEXT,
      address TEXT,
      latitude REAL,
      longitude REAL,
      submitted_at TEXT,
      status TEXT,
      portal_url TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE live_number_queue (
      suffix INTEGER PRIMARY KEY,
      srnumber TEXT NOT NULL UNIQUE,
      first_detected_at TEXT NOT NULL,
      audit_after TEXT NOT NULL,
      map_seen INTEGER NOT NULL DEFAULT 0,
      audit_outcome TEXT NOT NULL DEFAULT 'pending',
      audited_at TEXT
    );

    CREATE TABLE number_ledger (
      suffix INTEGER PRIMARY KEY,
      srnumber TEXT NOT NULL UNIQUE,
      outcome TEXT NOT NULL CHECK (outcome IN ('found', 'not_found', 'retry')),
      attempts INTEGER NOT NULL,
      http_status INTEGER,
      error TEXT,
      checked_at TEXT NOT NULL
    );
  `);

  const insertLive = database.prepare(`
    INSERT INTO live_portal_requests (
      srnumber, suffix, portal_id, problem, address, latitude, longitude,
      submitted_at, status, portal_url, first_seen_at, last_seen_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertQueue = database.prepare(`
    INSERT INTO live_number_queue (
      suffix, srnumber, first_detected_at, audit_after,
      map_seen, audit_outcome, audited_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLedger = database.prepare(`
    INSERT INTO number_ledger (
      suffix, srnumber, outcome, attempts, http_status, error, checked_at
    ) VALUES (?, ?, ?, 1, 200, NULL, ?)
  `);

  function addRecord({
    suffix,
    latitude,
    longitude,
    submittedAt,
    raw,
    mapSeen = 0,
    auditOutcome = 'found',
    ledgerOutcome = 'found'
  }) {
    const srnumber = requestNumber(suffix);
    insertLive.run(
      srnumber,
      suffix,
      `portal-${suffix}`,
      'Illegal Parking',
      `${suffix} TEST STREET, NEW YORK, NY`,
      latitude,
      longitude,
      submittedAt,
      'Open',
      `https://portal.311.nyc.gov/sr-details/?id=portal-${suffix}`,
      '2026-07-20T21:00:00.000Z',
      '2026-07-20T22:00:00.000Z',
      JSON.stringify(raw)
    );
    insertQueue.run(
      suffix,
      srnumber,
      '2026-07-20T21:00:00.000Z',
      '2026-07-20T21:35:00.000Z',
      mapSeen,
      auditOutcome,
      '2026-07-20T21:40:00.000Z'
    );
    insertLedger.run(
      suffix,
      srnumber,
      ledgerOutcome,
      '2026-07-20T21:40:00.000Z'
    );
    return srnumber;
  }

  const mapSuffix = 12345670;
  const mapRaw = {
    id: 'map-pin-1',
    latitude: '40.7000100',
    longitude: '-74.0000100',
    data: {
      srnumber: requestNumber(mapSuffix),
      submitteddate: '7/20/2026 8:43:46 PM'
    }
  };
  const mapSrnumber = addRecord({
    suffix: mapSuffix,
    latitude: 40.70001,
    longitude: -74.00001,
    submittedAt: '7/20/2026 8:43:46 PM',
    raw: mapRaw
  });

  const auditSuffix = 12345671;
  addRecord({
    suffix: auditSuffix,
    latitude: 40.71,
    longitude: -74.01,
    submittedAt: '2026-07-20T16:55:00.000Z',
    raw: {
      source: 'number_audit',
      coordinate_free: true,
      latitude: 40.71,
      longitude: -74.01,
      data: {
        srnumber: requestNumber(auditSuffix),
        submitteddate: '2026-07-20T16:55:00.000Z'
      }
    }
  });

  const mismatchedSuffix = 12345672;
  addRecord({
    suffix: mismatchedSuffix,
    latitude: 40.72,
    longitude: -74.02,
    submittedAt: '2026-07-20 18:00:00',
    raw: {
      source: 'map',
      latitude: 40.99,
      longitude: -74.02,
      data: {
        srnumber: requestNumber(mismatchedSuffix),
        submitteddate: '2026-07-20 18:00:00'
      }
    }
  });

  database.close();
  return {
    directory,
    databasePath,
    mapSuffix,
    mapSrnumber,
    mapRawText: JSON.stringify(mapRaw),
    auditSuffix,
    mismatchedSuffix
  };
}

function inspectDatabase(databasePath) {
  return new DatabaseSync(databasePath, { readOnly: true });
}

test('normalizes only strict timestamps with an unambiguous UTC interpretation', () => {
  assert.equal(
    normalizeSubmittedTimestamp('7/20/2026 8:43:46 PM'),
    '2026-07-20T20:43:46.000Z'
  );
  assert.equal(
    normalizeSubmittedTimestamp('7/20/2026 12:00:00 AM'),
    '2026-07-20T00:00:00.000Z'
  );
  assert.equal(
    normalizeSubmittedTimestamp('2026-07-20T20:43:46-04:00'),
    '2026-07-21T00:43:46.000Z'
  );
  assert.equal(normalizeSubmittedTimestamp('2/29/2025 1:00:00 PM'), null);
  assert.equal(normalizeSubmittedTimestamp('7/20/2026 13:00:00 PM'), null);
  assert.equal(normalizeSubmittedTimestamp('7/20/2026 1:60:00 PM'), null);
  assert.equal(normalizeSubmittedTimestamp('2026-07-20 20:43:46'), null);
  assert.equal(normalizeSubmittedTimestamp('2025-02-29T20:43:46Z'), null);
  assert.equal(normalizeSubmittedTimestamp('2026-07-20T24:00:00Z'), null);
  assert.equal(normalizeSubmittedTimestamp('2026-07-20T20:43:46+24:00'), null);
});

test('resolves an explicit path, SQLITE_PATH, and platform-safe defaults', () => {
  assert.equal(
    defaultLiveDatabasePath({ platform: 'darwin', home: '/Users/tester' }),
    '/Users/tester/Library/Application Support/nyc-bid-311/portal-archive.sqlite'
  );
  assert.equal(
    defaultLiveDatabasePath({ platform: 'linux', home: '/home/tester' }),
    '/home/tester/.local/share/nyc-bid-311/portal-archive.sqlite'
  );
  assert.equal(
    resolveDatabasePath({ cliPath: './explicit.sqlite', env: { SQLITE_PATH: './environment.sqlite' } }),
    path.resolve('./explicit.sqlite')
  );
  assert.equal(
    resolveDatabasePath({ env: { SQLITE_PATH: './environment.sqlite' } }),
    path.resolve('./environment.sqlite')
  );
  assert.equal(
    timestampedBackupPath('/tmp/portal-archive.sqlite', NOW),
    '/tmp/backups/portal-archive-20260720T221530Z.sqlite'
  );
});

test('CLI parsing keeps the database precedence and rejects unsafe ambiguity', () => {
  assert.deepEqual(parseArguments([
    '--db', '/tmp/source.sqlite',
    '--backup', '/tmp/backup.sqlite',
    '--busy-timeout', '7500',
    '--dry-run'
  ]), {
    cliPath: '/tmp/source.sqlite',
    backupPath: '/tmp/backup.sqlite',
    verifyOnly: false,
    dryRun: true,
    busyTimeoutMs: 7500,
    help: false
  });
  assert.throws(() => parseArguments(['one.sqlite', 'two.sqlite']), /only one database path/);
  assert.throws(() => parseArguments(['--busy-timeout', '-1']), /nonnegative integer/);
  assert.throws(() => parseArguments(['--unknown']), /Unknown option/);
});

test('finalizes, repairs only map-proven rows, and creates a verified backup manifest', async t => {
  const fixture = createFixture(t);
  const backupPath = path.join(fixture.directory, 'backups', 'first.sqlite');
  const result = await finalizeDatabase({
    databasePath: fixture.databasePath,
    backupPath,
    now: NOW
  });

  assert.equal(result.mode, 'finalize');
  assert.equal(result.health_before.ok, true);
  assert.equal(result.health_after.ok, true);
  assert.equal(result.planned.map_seen_repairs, 1);
  assert.equal(result.planned.submitted_at_normalizations, 1);
  assert.equal(result.planned.submitted_at_unparseable, 1);
  assert.deepEqual(result.changes, {
    map_seen_repaired: 1,
    submitted_at_normalized: 1,
    submitted_at_unparseable: 1
  });

  const database = inspectDatabase(fixture.databasePath);
  t.after(() => database.close());
  assert.equal(database.prepare('PRAGMA application_id').get().application_id, APPLICATION_ID);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
  const migration = database.prepare(
    'SELECT version, name, checksum, applied_at FROM schema_migrations'
  ).get();
  assert.equal(migration.version, 1);
  assert.equal(migration.name, MIGRATIONS[0].name);
  assert.equal(migration.checksum, migrationChecksum(MIGRATIONS[0]));
  assert.equal(migration.applied_at, NOW.toISOString());
  assert.deepEqual(
    database.prepare('PRAGMA index_info(live_number_queue_audit_due_idx)').all().map(row => row.name),
    ['audit_outcome', 'audit_after', 'suffix']
  );

  const queueRows = database.prepare(
    'SELECT suffix, map_seen FROM live_number_queue ORDER BY suffix'
  ).all();
  assert.deepEqual(queueRows.map(row => [Number(row.suffix), Number(row.map_seen)]), [
    [fixture.mapSuffix, 1],
    [fixture.auditSuffix, 0],
    [fixture.mismatchedSuffix, 0]
  ]);
  const normalized = database.prepare(
    'SELECT submitted_at, raw_json FROM live_portal_requests WHERE srnumber=?'
  ).get(fixture.mapSrnumber);
  assert.equal(normalized.submitted_at, '2026-07-20T20:43:46.000Z');
  assert.equal(normalized.raw_json, fixture.mapRawText);

  assert.equal(fs.existsSync(backupPath), true);
  assert.equal(fs.existsSync(`${backupPath}.manifest.json`), true);
  const manifest = JSON.parse(fs.readFileSync(`${backupPath}.manifest.json`, 'utf8'));
  assert.equal(
    manifest.sha256,
    crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex')
  );
  assert.equal(manifest.application_id, APPLICATION_ID);
  assert.equal(manifest.user_version, 1);
  assert.equal(manifest.health.ok, true);
  assert.deepEqual(manifest.tables.live_portal_requests, {
    count: 3,
    min_suffix: fixture.mapSuffix,
    max_suffix: fixture.mismatchedSuffix
  });
  assert.deepEqual(manifest.tables.live_number_queue, {
    count: 3,
    min_suffix: fixture.mapSuffix,
    max_suffix: fixture.mismatchedSuffix
  });
  assert.deepEqual(manifest.tables.number_ledger, {
    count: 3,
    min_suffix: fixture.mapSuffix,
    max_suffix: fixture.mismatchedSuffix
  });
  assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${backupPath}.manifest.json`).mode & 0o777, 0o600);

  const backup = inspectDatabase(backupPath);
  try {
    assert.equal(
      backup.prepare('SELECT map_seen FROM live_number_queue WHERE suffix=?').get(fixture.mapSuffix).map_seen,
      1
    );
    assert.equal(
      backup.prepare('SELECT submitted_at FROM live_portal_requests WHERE srnumber=?').get(fixture.mapSrnumber).submitted_at,
      '2026-07-20T20:43:46.000Z'
    );
  } finally {
    backup.close();
  }

  const secondBackupPath = path.join(fixture.directory, 'backups', 'second.sqlite');
  const second = await finalizeDatabase({
    databasePath: fixture.databasePath,
    backupPath: secondBackupPath,
    now: new Date('2026-07-20T22:16:30.000Z')
  });
  assert.equal(second.migrations_before.pending.length, 0);
  assert.equal(second.planned.map_seen_repairs, 0);
  assert.equal(second.planned.submitted_at_normalizations, 0);
  assert.equal(second.changes.map_seen_repaired, 0);
  assert.equal(second.changes.submitted_at_normalized, 0);
  assert.equal(fs.existsSync(secondBackupPath), true);
});

for (const mode of ['dryRun', 'verifyOnly']) {
  test(`${mode === 'dryRun' ? 'dry-run' : 'verify-only'} reports work without mutating or backing up`, async t => {
    const fixture = createFixture(t);
    const backupPath = path.join(fixture.directory, `${mode}.sqlite`);
    const result = await finalizeDatabase({
      databasePath: fixture.databasePath,
      backupPath,
      [mode]: true,
      now: NOW
    });
    assert.equal(result.mode, mode === 'dryRun' ? 'dry-run' : 'verify-only');
    assert.equal(result.planned.map_seen_repairs, 1);
    assert.equal(result.planned.submitted_at_normalizations, 1);
    assert.equal(result.migrations_before.pending.length, 1);
    assert.equal(result.backup, null);
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.existsSync(`${backupPath}.manifest.json`), false);

    const database = inspectDatabase(fixture.databasePath);
    try {
      assert.equal(database.prepare('PRAGMA application_id').get().application_id, 0);
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 0);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='schema_migrations'").get().count,
        0
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='live_number_queue_audit_due_idx'").get().count,
        0
      );
      assert.equal(
        database.prepare('SELECT map_seen FROM live_number_queue WHERE suffix=?').get(fixture.mapSuffix).map_seen,
        0
      );
      assert.equal(
        database.prepare('SELECT submitted_at FROM live_portal_requests WHERE srnumber=?').get(fixture.mapSrnumber).submitted_at,
        '7/20/2026 8:43:46 PM'
      );
    } finally {
      database.close();
    }
  });
}

test('refuses a database owned by another application id', async t => {
  const fixture = createFixture(t);
  const database = new DatabaseSync(fixture.databasePath);
  database.exec('PRAGMA application_id = 12345');
  database.close();
  await assert.rejects(
    finalizeDatabase({ databasePath: fixture.databasePath, dryRun: true, now: NOW }),
    /Unexpected SQLite application_id/
  );
});

test('refuses a tampered migration checksum', async t => {
  const fixture = createFixture(t);
  const database = new DatabaseSync(fixture.databasePath);
  applyMigrations(database, NOW.toISOString());
  database.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run('tampered');
  database.close();
  await assert.rejects(
    finalizeDatabase({ databasePath: fixture.databasePath, dryRun: true, now: NOW }),
    /checksum\/name mismatch/
  );
});

test('revalidates map provenance inside the repair transaction', t => {
  const fixture = createFixture(t);
  const database = new DatabaseSync(fixture.databasePath);
  try {
    const inspected = inspectDataChanges(database);
    assert.deepEqual(inspected.stale_map_seen_candidates, [fixture.mapSuffix]);
    inspected.submitted_at_changes = [];
    database.prepare('UPDATE live_portal_requests SET raw_json=? WHERE srnumber=?').run(
      JSON.stringify({
        source: 'number_audit',
        coordinate_free: true,
        data: { srnumber: fixture.mapSrnumber }
      }),
      fixture.mapSrnumber
    );
    assert.equal(applyDataChanges(database, inspected).map_seen_repaired, 0);
    assert.equal(
      database.prepare('SELECT map_seen FROM live_number_queue WHERE suffix=?').get(fixture.mapSuffix).map_seen,
      0
    );
  } finally {
    database.close();
  }
});

test('rejects an occupied backup destination before mutating the source', async t => {
  const fixture = createFixture(t);
  const backupPath = path.join(fixture.directory, 'occupied.sqlite');
  fs.writeFileSync(backupPath, 'existing file');
  await assert.rejects(
    finalizeDatabase({ databasePath: fixture.databasePath, backupPath, now: NOW }),
    /Refusing to overwrite/
  );

  const database = inspectDatabase(fixture.databasePath);
  try {
    assert.equal(database.prepare('PRAGMA application_id').get().application_id, 0);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(
      database.prepare('SELECT map_seen FROM live_number_queue WHERE suffix=?').get(fixture.mapSuffix).map_seen,
      0
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='schema_migrations'").get().count,
      0
    );
  } finally {
    database.close();
  }
});
