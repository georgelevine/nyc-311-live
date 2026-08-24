'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_BACKUP_PAGE_RATE,
  MINIMUM_BACKUP_FREE_BYTES,
  calculateBackupCapacity,
  createRoutineBackup,
  parseArguments,
  trustedManagedBackups,
  verifiedManagedBackups
} = require('../backup-sqlite');
const { createBackup, finalizeDatabase, openDatabase } = require('../sqlite-finalization');
const { verifySnapshot } = require('../sqlite-snapshot');
const { createArchiveFixture } = require('../test-support/archive-fixture');

test('creates verified online snapshots and prunes only the managed oldest pair', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-routine-backup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unfinalizedSource = createArchiveFixture(directory, 'source.sqlite');
  const finalized = await finalizeDatabase({
    databasePath: unfinalizedSource,
    backupPath: path.join(directory, 'portal-archive.sqlite')
  });
  const source = finalized.backup.path;
  const backups = path.join(directory, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  fs.writeFileSync(path.join(backups, 'unrelated.txt'), 'preserve me');
  for (const timestamp of [
    '2026-07-19T04:15:00.000Z',
    '2026-07-20T04:15:00.000Z',
    '2026-07-21T04:15:00.000Z'
  ]) {
    await createRoutineBackup({
      databasePath: source,
      directory: backups,
      retain: 2,
      now: new Date(timestamp)
    });
  }
  const invalidDatabase = path.join(backups, 'portal-archive-20260722T041500Z.sqlite');
  const invalidManifest = `${invalidDatabase}.manifest.json`;
  fs.writeFileSync(invalidDatabase, 'not sqlite');
  fs.writeFileSync(invalidManifest, 'not json');
  await createRoutineBackup({
    databasePath: source,
    directory: backups,
    retain: 2,
    now: new Date('2026-07-23T04:15:00.000Z')
  });

  const inspected = await verifiedManagedBackups(backups, source);
  assert.equal(inspected.verified.length, 2);
  assert.equal(inspected.invalid.length, 1);
  assert.equal(inspected.verified.some(item => item.databasePath.includes('20260719')), false);
  assert.equal(inspected.verified.some(item => item.databasePath.includes('20260720')), false);
  assert.equal(fs.existsSync(invalidDatabase), true);
  assert.equal(fs.existsSync(invalidManifest), true);
  assert.equal(fs.readFileSync(path.join(backups, 'unrelated.txt'), 'utf8'), 'preserve me');
  for (const item of inspected.verified) {
    const verified = await verifySnapshot({
      databasePath: item.databasePath,
      manifestPath: item.manifestPath
    });
    assert.equal(verified.ok, true);
  }
  assert.equal(fs.readdirSync(backups).some(name => name.endsWith('.partial')), false);
});

test('page-rate controls the online backup batch size', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-routine-rate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unfinalizedSource = createArchiveFixture(directory, 'source.sqlite');
  const finalized = await finalizeDatabase({
    databasePath: unfinalizedSource,
    backupPath: path.join(directory, 'portal-archive.sqlite')
  });
  const result = await createRoutineBackup({
    databasePath: finalized.backup.path,
    directory: path.join(directory, 'backups'),
    pageRate: 7,
    now: new Date('2026-07-24T04:15:00.000Z')
  });

  assert.equal(result.backup_page_rate, 7);
  assert.equal(Object.hasOwn(result, 'deprecated_options'), false);
  assert.equal((await verifySnapshot({
    databasePath: result.path,
    manifestPath: result.manifest_path
  })).ok, true);
  assert.equal(DEFAULT_BACKUP_PAGE_RATE, 64);
});

test('BID-only backups allow captured suffixes beyond the retained citywide frontier', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-routine-bid-scope-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unfinalizedSource = createArchiveFixture(directory, 'source.sqlite');
  const finalized = await finalizeDatabase({
    databasePath: unfinalizedSource,
    backupPath: path.join(directory, 'portal-archive.sqlite')
  });
  const source = finalized.backup.path;
  const database = openDatabase(source);
  const observedAt = '2026-08-24T12:00:00.000Z';
  try {
    database.prepare(`
      INSERT INTO live_monitor_state(key,value,updated_at)
      VALUES ('collector_scope','bid_only',?)
    `).run(observedAt);
    database.prepare(`
      INSERT INTO live_portal_requests(
        srnumber,suffix,problem,address,latitude,longitude,submitted_at,status,
        portal_url,first_seen_at,last_seen_at,raw_json
      ) VALUES (
        '311-00000002',2,'BID request','2 Test Plaza',40.75,-73.98,?,
        'In Progress','https://portal.311.nyc.gov/sr-details/?srnum=311-00000002',
        ?,?,'{"source":"bid_map"}'
      )
    `).run(observedAt, observedAt, observedAt);
    database.prepare(`
      INSERT INTO live_detail_queue(
        srnumber,status,attempts,next_attempt_at,updated_at
      ) VALUES ('311-00000002','pending',0,?,?)
    `).run(observedAt, observedAt);
    database.prepare(`
      INSERT INTO request_followup_queue(
        srnumber,state,attempts,closing_attempts,closure_cycle,updated_at
      ) VALUES ('311-00000002','open',0,0,0,?)
    `).run(observedAt);
  } finally {
    database.close();
  }

  const result = await createRoutineBackup({
    databasePath: source,
    directory: path.join(directory, 'backups'),
    now: new Date('2026-08-24T12:05:00.000Z')
  });
  const verified = await verifySnapshot({
    databasePath: result.path,
    manifestPath: result.manifest_path
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.archive.collector_scope, 'bid_only');
  assert.equal(verified.archive.frontier, 1);
  assert.equal(verified.archive.latest_captured_suffix, 2);
});

test('capacity preflight sizes the snapshot from logical pages and reserves WAL headroom', () => {
  const result = calculateBackupCapacity({
    sourceDatabaseBytes: 4_096,
    sourceLogicalBytes: 304_689_152,
    sourceWalBytes: 306_482_712,
    availableBytes: 2_000_000_000
  });

  assert.equal(result.source_database_bytes, 4_096);
  assert.equal(result.source_logical_bytes, 304_689_152);
  assert.equal(result.source_wal_bytes, 306_482_712);
  assert.equal(
    result.required_free_bytes,
    304_689_152 * 3 + 306_482_712
  );
  assert.ok(result.required_free_bytes > result.source_logical_bytes);
  assert.equal(result.ok, true);

  const insufficient = calculateBackupCapacity({
    sourceDatabaseBytes: 4_096,
    sourceLogicalBytes: 304_689_152,
    sourceWalBytes: 306_482_712,
    availableBytes: MINIMUM_BACKUP_FREE_BYTES
  });
  assert.equal(insufficient.ok, false);
});

test('routine online snapshots include committed WAL pages while the writer remains open', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-routine-wal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unfinalizedSource = createArchiveFixture(directory, 'source.sqlite');
  const finalized = await finalizeDatabase({
    databasePath: unfinalizedSource,
    backupPath: path.join(directory, 'portal-archive.sqlite')
  });
  const source = finalized.backup.path;
  const writer = openDatabase(source);
  try {
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE capacity_probe(id INTEGER PRIMARY KEY, payload BLOB);
      BEGIN;
    `);
    const insert = writer.prepare('INSERT INTO capacity_probe(payload) VALUES(?)');
    const payload = Buffer.alloc(8 * 1024, 1);
    for (let index = 0; index < 256; index += 1) insert.run(payload);
    writer.exec('COMMIT');

    const result = await createRoutineBackup({
      databasePath: source,
      directory: path.join(directory, 'backups'),
      now: new Date('2026-07-24T04:45:00.000Z')
    });
    assert.ok(result.capacity_preflight.source_wal_bytes > 0);
    assert.ok(
      result.capacity_preflight.source_logical_bytes
        > result.capacity_preflight.source_database_bytes
    );
    const snapshot = openDatabase(result.path, { readOnly: true });
    try {
      assert.equal(
        Number(snapshot.prepare('SELECT COUNT(*) AS count FROM capacity_probe').get().count),
        256
      );
    } finally {
      snapshot.close();
    }
  } finally {
    writer.close();
  }
});

test('routine backup performs each expensive new-backup operation once', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-routine-io-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unfinalizedSource = createArchiveFixture(directory, 'source.sqlite');
  const finalized = await finalizeDatabase({
    databasePath: unfinalizedSource,
    backupPath: path.join(directory, 'portal-archive.sqlite')
  });
  const observed = [];
  const result = await createRoutineBackup({
    databasePath: finalized.backup.path,
    directory: path.join(directory, 'backups'),
    now: new Date('2026-07-24T05:15:00.000Z'),
    onIoPass: operation => observed.push(operation)
  });

  assert.deepEqual(observed, [
    'source_online_copy',
    'backup_integrity_check',
    'backup_foreign_key_check',
    'backup_table_manifest',
    'backup_archive_contract',
    'backup_sha256'
  ]);
  assert.deepEqual(result.io_operations, observed);
  assert.deepEqual(result.full_file_passes, [
    'source_online_copy',
    'backup_integrity_check',
    'backup_sha256'
  ]);
  assert.deepEqual(result.io_operation_counts, {
    source_online_copy: 1,
    backup_integrity_check: 1,
    backup_foreign_key_check: 1,
    backup_table_manifest: 1,
    backup_archive_contract: 1,
    backup_sha256: 1
  });
  assert.equal(result.io_operations.includes('backup_quick_check'), false);
  assert.equal(result.manifest.health.quick_check, null);
  assert.equal(result.copy_strategy, 'online_backup');
  assert.equal(result.manifest.copy_strategy, 'online_backup');
  assert.equal(result.capacity_preflight.ok, true);
  assert.ok(result.capacity_preflight.source_logical_bytes > 0);
  assert.ok(
    result.capacity_preflight.required_free_bytes
      >= result.capacity_preflight.source_logical_bytes
  );
  assert.equal(result.manifest.table_manifest_mode, 'schema');
  assert.equal(result.manifest.verification.status, 'verified');
});

test('nightly retention does not reread an unchanged retained database', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-routine-trust-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unfinalizedSource = createArchiveFixture(directory, 'source.sqlite');
  const finalized = await finalizeDatabase({
    databasePath: unfinalizedSource,
    backupPath: path.join(directory, 'portal-archive.sqlite')
  });
  const backups = path.join(directory, 'backups');
  const first = await createRoutineBackup({
    databasePath: finalized.backup.path,
    directory: backups,
    retain: 3,
    now: new Date('2026-07-24T06:15:00.000Z')
  });
  fs.chmodSync(first.path, 0o000);
  t.after(() => {
    if (fs.existsSync(first.path)) fs.chmodSync(first.path, 0o600);
  });

  const second = await createRoutineBackup({
    databasePath: finalized.backup.path,
    directory: backups,
    retain: 3,
    now: new Date('2026-07-25T06:15:00.000Z')
  });
  const inspected = await trustedManagedBackups(backups, finalized.backup.path);

  assert.equal(second.retained, 2);
  assert.equal(inspected.trusted.length, 2);
  assert.equal(inspected.invalid.length, 0);
  assert.equal(
    inspected.trusted.find(item => item.databasePath === first.path).trust_basis,
    'atomic_verified_manifest'
  );
});

test('manifest retention quarantines a backup changed after verification', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-routine-changed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unfinalizedSource = createArchiveFixture(directory, 'source.sqlite');
  const finalized = await finalizeDatabase({
    databasePath: unfinalizedSource,
    backupPath: path.join(directory, 'portal-archive.sqlite')
  });
  const backups = path.join(directory, 'backups');
  const created = await createRoutineBackup({
    databasePath: finalized.backup.path,
    directory: backups,
    now: new Date('2026-07-24T07:15:00.000Z')
  });

  const descriptor = fs.openSync(created.path, 'r+');
  try {
    fs.writeSync(descriptor, Buffer.from([0]), 0, 1, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const manifestTime = fs.statSync(created.manifest_path).mtimeMs;
  const changedTime = new Date(manifestTime + 1_000);
  fs.utimesSync(created.path, changedTime, changedTime);

  const inspected = await trustedManagedBackups(backups, finalized.backup.path);
  assert.equal(inspected.trusted.length, 0);
  assert.equal(inspected.invalid.length, 1);
  assert.match(inspected.invalid[0].error, /changed after its manifest/);
  assert.equal(fs.existsSync(created.path), true);
  assert.equal(fs.existsSync(created.manifest_path), true);
});

test('retention accepts a legacy backup that the prior routine fully verified', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-routine-legacy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unfinalizedSource = createArchiveFixture(directory, 'source.sqlite');
  const finalized = await finalizeDatabase({
    databasePath: unfinalizedSource,
    backupPath: path.join(directory, 'portal-archive.sqlite')
  });
  const source = finalized.backup.path;
  const backups = path.join(directory, 'backups');
  const destination = path.join(backups, 'portal-archive-20260723T061500Z.sqlite');
  const database = openDatabase(source, { readOnly: true });
  let legacy;
  try {
    legacy = await createBackup(
      database,
      source,
      destination,
      '2026-07-23T06:15:00.000Z'
    );
  } finally {
    database.close();
  }
  assert.equal((await verifySnapshot({
    databasePath: legacy.path,
    manifestPath: legacy.manifest_path
  })).ok, true);
  const oldManifest = JSON.parse(fs.readFileSync(legacy.manifest_path, 'utf8'));
  delete oldManifest.table_manifest_mode;
  delete oldManifest.copy_strategy;
  fs.writeFileSync(legacy.manifest_path, `${JSON.stringify(oldManifest, null, 2)}\n`);
  assert.equal((await verifySnapshot({
    databasePath: legacy.path,
    manifestPath: legacy.manifest_path
  })).ok, true);

  const inspected = await trustedManagedBackups(backups, source);
  assert.equal(inspected.trusted.length, 1);
  assert.equal(inspected.invalid.length, 0);
  assert.equal(inspected.trusted[0].trust_basis, 'legacy_atomic_verified_manifest');
});

test('snapshot verification and retention reject an unknown declared copy strategy', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-routine-strategy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unfinalizedSource = createArchiveFixture(directory, 'source.sqlite');
  const finalized = await finalizeDatabase({
    databasePath: unfinalizedSource,
    backupPath: path.join(directory, 'portal-archive.sqlite')
  });
  const backups = path.join(directory, 'backups');
  const created = await createRoutineBackup({
    databasePath: finalized.backup.path,
    directory: backups,
    now: new Date('2026-07-24T08:15:00.000Z')
  });
  const manifest = JSON.parse(fs.readFileSync(created.manifest_path, 'utf8'));
  manifest.copy_strategy = 'untrusted_copy';
  fs.writeFileSync(created.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    verifySnapshot({
      databasePath: created.path,
      manifestPath: created.manifest_path
    }),
    /Unsupported snapshot copy strategy/
  );
  const inspected = await trustedManagedBackups(backups, finalized.backup.path);
  assert.equal(inspected.trusted.length, 0);
  assert.equal(inspected.invalid.length, 1);
  assert.match(inspected.invalid[0].error, /unsupported copy strategy/);
});

test('archive-contract failure removes the new partial backup safely', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-routine-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unfinalizedSource = createArchiveFixture(directory, 'source.sqlite');
  const finalized = await finalizeDatabase({
    databasePath: unfinalizedSource,
    backupPath: path.join(directory, 'portal-archive.sqlite')
  });
  const source = finalized.backup.path;
  const database = openDatabase(source);
  try {
    database.prepare(`
      DELETE FROM request_followup_queue
      WHERE srnumber = (SELECT srnumber FROM request_followup_queue LIMIT 1)
    `).run();
  } finally {
    database.close();
  }
  const backups = path.join(directory, 'backups');

  await assert.rejects(
    createRoutineBackup({
      databasePath: source,
      directory: backups,
      now: new Date('2026-07-26T06:15:00.000Z')
    }),
    /Snapshot archive parity failed: missing_followup_queue=1/
  );
  assert.deepEqual(fs.readdirSync(backups), []);
});

test('backup CLI validates page-rate and parses exclusive mode', () => {
  assert.equal(parseArguments(['--page-rate', '32']).pageRate, 32);
  assert.equal(parseArguments(['--exclusive']).exclusive, true);
  assert.throws(
    () => parseArguments(['--page-rate', '0']),
    /--page-rate must be an integer from 1 through 10000/
  );
  assert.throws(
    () => parseArguments(['--page-rate', '10001']),
    /--page-rate must be an integer from 1 through 10000/
  );
});

test('removes stale managed partials and reports recoverable orphan artifacts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-routine-artifacts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unfinalizedSource = createArchiveFixture(directory, 'source.sqlite');
  const finalized = await finalizeDatabase({
    databasePath: unfinalizedSource,
    backupPath: path.join(directory, 'portal-archive.sqlite')
  });
  const source = finalized.backup.path;
  const backups = path.join(directory, 'backups');
  fs.mkdirSync(backups, { recursive: true });

  const staleDatabasePartial = path.join(
    backups,
    'portal-archive-20260718T041500Z.sqlite.partial'
  );
  const staleManifestPartial = path.join(
    backups,
    'portal-archive-20260718T041500Z.sqlite.manifest.json.partial'
  );
  const staleWalPartial = `${staleDatabasePartial}-wal`;
  fs.writeFileSync(staleDatabasePartial, 'incomplete');
  fs.writeFileSync(staleManifestPartial, 'incomplete');
  fs.writeFileSync(staleWalPartial, 'incomplete');
  const oldTime = new Date('2026-07-18T04:15:00.000Z');
  fs.utimesSync(staleDatabasePartial, oldTime, oldTime);
  fs.utimesSync(staleManifestPartial, oldTime, oldTime);
  fs.utimesSync(staleWalPartial, oldTime, oldTime);

  const orphanDatabase = path.join(backups, 'portal-archive-20260719T041500Z.sqlite');
  const orphanManifest = path.join(
    backups,
    'portal-archive-20260720T041500Z.sqlite.manifest.json'
  );
  fs.writeFileSync(orphanDatabase, 'preserve for recovery');
  fs.writeFileSync(orphanManifest, '{}');

  const result = await createRoutineBackup({
    databasePath: source,
    directory: backups,
    retain: 2,
    now: new Date('2026-07-21T04:15:00.000Z'),
    stalePartialAgeMs: 60 * 60 * 1000,
    exclusiveRun: true
  });

  assert.deepEqual(new Set(result.removed_stale_partials), new Set([
    staleDatabasePartial,
    staleManifestPartial,
    staleWalPartial
  ]));
  assert.equal(fs.existsSync(staleDatabasePartial), false);
  assert.equal(fs.existsSync(staleManifestPartial), false);
  assert.equal(fs.existsSync(staleWalPartial), false);
  assert.equal(result.pending_partials.length, 0);
  assert.deepEqual(
    new Set(result.orphaned_artifacts.map(item => item.path)),
    new Set([orphanDatabase, orphanManifest])
  );
  assert.equal(fs.readFileSync(orphanDatabase, 'utf8'), 'preserve for recovery');
  assert.equal(fs.readFileSync(orphanManifest, 'utf8'), '{}');
});

test('only an explicitly exclusive run removes a recent abandoned partial', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-routine-exclusive-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const unfinalizedSource = createArchiveFixture(directory, 'source.sqlite');
  const finalized = await finalizeDatabase({
    databasePath: unfinalizedSource,
    backupPath: path.join(directory, 'portal-archive.sqlite')
  });
  const source = finalized.backup.path;
  const backups = path.join(directory, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const recentPartial = path.join(
    backups,
    'portal-archive-20260728T041500Z.sqlite.partial'
  );
  fs.writeFileSync(recentPartial, 'interrupted snapshot');

  const nonexclusive = await createRoutineBackup({
    databasePath: source,
    directory: backups,
    now: new Date('2026-07-28T05:15:00.000Z')
  });
  assert.equal(fs.existsSync(recentPartial), true);
  assert.deepEqual(nonexclusive.removed_abandoned_partials, []);
  assert.equal(
    nonexclusive.pending_partials.some(item => item.path === recentPartial),
    true
  );

  const exclusive = await createRoutineBackup({
    databasePath: source,
    directory: backups,
    now: new Date('2026-07-28T06:15:00.000Z'),
    exclusiveRun: true
  });
  assert.equal(fs.existsSync(recentPartial), false);
  assert.deepEqual(exclusive.removed_abandoned_partials, [recentPartial]);
  assert.deepEqual(exclusive.removed_stale_partials, []);
  assert.equal(exclusive.pending_partials.length, 0);
});
