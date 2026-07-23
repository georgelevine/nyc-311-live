'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MIGRATIONS, applyMigrations, finalizeDatabase } = require('../sqlite-finalization');
const { verifySnapshot } = require('../sqlite-snapshot');
const { createArchiveFixture } = require('../test-support/archive-fixture');
const { DatabaseSync } = require('node:sqlite');

async function finalizedMutatedSnapshot(prefix, mutate) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const source = createArchiveFixture(directory);
  const database = new DatabaseSync(source);
  try {
    mutate(database);
  } finally {
    database.close();
  }
  const backup = path.join(directory, 'transfer.sqlite');
  const finalized = await finalizeDatabase({ databasePath: source, backupPath: backup });
  return { backup, manifestPath: finalized.backup.manifest_path };
}

test('verifies the finalized file, digest, schema version, and table manifest', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-snapshot-'));
  const source = createArchiveFixture(directory);
  const backup = path.join(directory, 'transfer.sqlite');
  const finalized = await finalizeDatabase({ databasePath: source, backupPath: backup });
  const result = await verifySnapshot({
    databasePath: finalized.backup.path,
    manifestPath: finalized.backup.manifest_path
  });
  assert.equal(result.ok, true);
  assert.equal(result.application_id, finalized.backup.manifest.application_id);
  assert.equal(result.user_version, MIGRATIONS.at(-1).version);
  assert.equal(finalized.backup.manifest.journal_mode, 'delete');
  assert.equal(fs.existsSync(`${backup}-wal`), false);
  assert.equal(fs.existsSync(`${backup}-shm`), false);
  assert.deepEqual(result.tables, finalized.backup.manifest.tables);
  assert.deepEqual(result.tables.police_precinct_boundary_versions, { count: 0 });
  assert.deepEqual(result.tables.police_precincts, { count: 0 });
  assert.deepEqual(result.tables.business_improvement_district_boundary_versions, { count: 0 });
  assert.deepEqual(result.tables.business_improvement_districts, { count: 0 });
  assert.deepEqual(result.tables.live_request_bid_memberships, { count: 0 });

  fs.chmodSync(directory, 0o500);
  try {
    const readOnlyResult = await verifySnapshot({
      databasePath: finalized.backup.path,
      manifestPath: finalized.backup.manifest_path
    });
    assert.equal(readOnlyResult.ok, true);
  } finally {
    fs.chmodSync(directory, 0o700);
  }
});

test('rejects a manifest whose digest was changed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-snapshot-bad-'));
  const source = createArchiveFixture(directory);
  const backup = path.join(directory, 'transfer.sqlite');
  const finalized = await finalizeDatabase({ databasePath: source, backupPath: backup });
  const manifest = JSON.parse(fs.readFileSync(finalized.backup.manifest_path, 'utf8'));
  manifest.sha256 = '0'.repeat(64);
  fs.writeFileSync(finalized.backup.manifest_path, JSON.stringify(manifest));
  await assert.rejects(
    verifySnapshot({ databasePath: backup, manifestPath: finalized.backup.manifest_path }),
    /SHA-256 mismatch/
  );
});

test('rejects a matching manifest when a required table has the wrong schema', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-snapshot-schema-'));
  const source = createArchiveFixture(directory);
  const database = new DatabaseSync(source);
  database.exec(`
    DROP TABLE portal_requests;
    CREATE TABLE portal_requests (srnumber TEXT PRIMARY KEY, fields_json TEXT NOT NULL);
    INSERT INTO portal_requests VALUES ('311-00000001', '{}');
  `);
  database.close();
  const backup = path.join(directory, 'transfer.sqlite');
  const finalized = await finalizeDatabase({ databasePath: source, backupPath: backup });
  await assert.rejects(
    verifySnapshot({ databasePath: backup, manifestPath: finalized.backup.manifest_path }),
    /missing required archive column/
  );
});

test('rejects a required table whose declared primary key is missing', async () => {
  const snapshot = await finalizedMutatedSnapshot('nyc311-snapshot-primary-key-', database => {
    database.exec(`
      ALTER TABLE live_monitor_state RENAME TO old_live_monitor_state;
      CREATE TABLE live_monitor_state (
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO live_monitor_state SELECT * FROM old_live_monitor_state;
      DROP TABLE old_live_monitor_state;
    `);
  });
  await assert.rejects(
    verifySnapshot({ databasePath: snapshot.backup, manifestPath: snapshot.manifestPath }),
    /live_monitor_state primary key expected \(key\), found \(none\)/
  );
});

test('rejects a required UNIQUE constraint replaced by an ordinary column', async () => {
  const snapshot = await finalizedMutatedSnapshot('nyc311-snapshot-unique-', database => {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
  });
  await assert.rejects(
    verifySnapshot({ databasePath: snapshot.backup, manifestPath: snapshot.manifestPath }),
    /schema_migrations missing UNIQUE constraint \(name\)/
  );
});

test('rejects a non-unique closure-final index with the required name', async () => {
  const snapshot = await finalizedMutatedSnapshot('nyc311-snapshot-index-unique-', database => {
    database.exec(`
      DROP INDEX request_closure_snapshots_final_idx;
      CREATE INDEX request_closure_snapshots_final_idx
        ON request_closure_snapshots(srnumber, closure_cycle)
        WHERE is_final = 1;
    `);
  });
  await assert.rejects(
    verifySnapshot({ databasePath: snapshot.backup, manifestPath: snapshot.manifestPath }),
    /request_closure_snapshots_final_idx uniqueness expected unique, found non-unique/
  );
});

test('rejects required index keys with the wrong sort direction', async () => {
  const snapshot = await finalizedMutatedSnapshot('nyc311-snapshot-index-order-', database => {
    database.exec(`
      DROP INDEX request_closure_snapshots_request_idx;
      CREATE INDEX request_closure_snapshots_request_idx
        ON request_closure_snapshots(srnumber, closure_cycle, fetched_at DESC);
    `);
  });
  await assert.rejects(
    verifySnapshot({ databasePath: snapshot.backup, manifestPath: snapshot.manifestPath }),
    /request_closure_snapshots_request_idx keys expected .*closure_cycle DESC.*found .*closure_cycle ASC/
  );
});

test('rejects a closure-final index with the wrong partial predicate', async () => {
  const snapshot = await finalizedMutatedSnapshot('nyc311-snapshot-index-predicate-', database => {
    database.exec(`
      DROP INDEX request_closure_snapshots_final_idx;
      CREATE UNIQUE INDEX request_closure_snapshots_final_idx
        ON request_closure_snapshots(srnumber, closure_cycle)
        WHERE is_final = 0;
    `);
  });
  await assert.rejects(
    verifySnapshot({ databasePath: snapshot.backup, manifestPath: snapshot.manifestPath }),
    /request_closure_snapshots_final_idx predicate expected is_final = 1, found is_final = 0/
  );
});

test('rejects a precinct request index with the wrong suffix direction', async () => {
  const snapshot = await finalizedMutatedSnapshot('nyc311-snapshot-precinct-index-', database => {
    database.exec(`
      ALTER TABLE live_portal_requests ADD COLUMN police_precinct INTEGER;
      CREATE INDEX live_portal_requests_police_precinct_idx
        ON live_portal_requests(police_precinct, suffix);
    `);
  });
  await assert.rejects(
    verifySnapshot({ databasePath: snapshot.backup, manifestPath: snapshot.manifestPath }),
    /live_portal_requests_police_precinct_idx keys expected .*suffix DESC.*found .*suffix ASC/
  );
});

test('rejects a precinct polygon table without its boundary-version relationship', async () => {
  const snapshot = await finalizedMutatedSnapshot('nyc311-snapshot-precinct-foreign-key-', database => {
    database.exec(`
      CREATE TABLE police_precincts (
        boundary_version TEXT NOT NULL,
        precinct_number INTEGER NOT NULL,
        label TEXT NOT NULL,
        geometry_json TEXT NOT NULL CHECK(json_valid(geometry_json)),
        min_longitude REAL NOT NULL,
        min_latitude REAL NOT NULL,
        max_longitude REAL NOT NULL,
        max_latitude REAL NOT NULL,
        PRIMARY KEY(boundary_version,precinct_number)
      );
    `);
  });
  await assert.rejects(
    verifySnapshot({ databasePath: snapshot.backup, manifestPath: snapshot.manifestPath }),
    /police_precincts missing FOREIGN KEY \(boundary_version\) REFERENCES police_precinct_boundary_versions\(version\) ON DELETE CASCADE/
  );
});

test('rejects a BID membership lookup index with the wrong key order', async () => {
  const snapshot = await finalizedMutatedSnapshot('nyc311-snapshot-bid-index-', database => {
    applyMigrations(database);
    database.exec(`
      DROP INDEX live_request_bid_memberships_district_idx;
      CREATE INDEX live_request_bid_memberships_district_idx
        ON live_request_bid_memberships(bid_id,boundary_version,srnumber);
    `);
  });
  await assert.rejects(
    verifySnapshot({ databasePath: snapshot.backup, manifestPath: snapshot.manifestPath }),
    /live_request_bid_memberships_district_idx keys expected .*boundary_version.*bid_id.*found .*bid_id.*boundary_version/
  );
});

test('rejects a BID membership table without its request relationship', async () => {
  const snapshot = await finalizedMutatedSnapshot('nyc311-snapshot-bid-foreign-key-', database => {
    applyMigrations(database);
    database.exec(`
      DROP TABLE live_request_bid_memberships;
      CREATE TABLE live_request_bid_memberships (
        srnumber TEXT NOT NULL,
        boundary_version TEXT NOT NULL,
        bid_id INTEGER NOT NULL,
        matched_at TEXT NOT NULL,
        PRIMARY KEY(srnumber,boundary_version,bid_id),
        FOREIGN KEY(boundary_version,bid_id)
          REFERENCES business_improvement_districts(boundary_version,bid_id) ON DELETE CASCADE
      );
      CREATE INDEX live_request_bid_memberships_district_idx
        ON live_request_bid_memberships(boundary_version,bid_id,srnumber);
    `);
  });
  await assert.rejects(
    verifySnapshot({ databasePath: snapshot.backup, manifestPath: snapshot.manifestPath }),
    /live_request_bid_memberships missing FOREIGN KEY \(srnumber\) REFERENCES live_portal_requests\(srnumber\) ON DELETE CASCADE/
  );
});
