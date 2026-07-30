'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_BACKUP_PAGE_RATE,
  createRoutineBackup,
  parseArguments,
  verifiedManagedBackups
} = require('../backup-sqlite');
const { finalizeDatabase } = require('../sqlite-finalization');
const { verifySnapshot } = require('../sqlite-snapshot');
const { createArchiveFixture } = require('../test-support/archive-fixture');

test('creates verified online backups and prunes only the managed oldest pair', async t => {
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

test('routine backups use a small configurable SQLite page batch', async t => {
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
  assert.equal((await verifySnapshot({
    databasePath: result.path,
    manifestPath: result.manifest_path
  })).ok, true);
  assert.equal(DEFAULT_BACKUP_PAGE_RATE, 64);
});

test('backup CLI validates its page batch size', () => {
  assert.equal(parseArguments(['--page-rate', '32']).pageRate, 32);
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
    stalePartialAgeMs: 60 * 60 * 1000
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
