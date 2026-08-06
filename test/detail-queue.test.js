'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { reconcileStoredDetails } = require('../detail-queue');

function harness(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE portal_requests (srnumber TEXT PRIMARY KEY);
    CREATE TABLE live_detail_queue (
      srnumber TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE business_improvement_district_boundary_versions (
      version TEXT PRIMARY KEY,
      active INTEGER NOT NULL
    );
    CREATE TABLE live_request_bid_memberships (
      srnumber TEXT NOT NULL,
      boundary_version TEXT NOT NULL,
      bid_id INTEGER NOT NULL
    );
  `);
  return database;
}

function queue(database, srnumber, status, lastError = null) {
  database.prepare(`
    INSERT INTO live_detail_queue (
      srnumber, status, attempts, next_attempt_at, last_error, updated_at
    ) VALUES (?, ?, 3, '2026-07-22T00:00:00.000Z', ?, '2026-07-21T00:00:00.000Z')
  `).run(srnumber, status, lastError);
}

test('reconciles stale detail queue rows only when details are already stored', t => {
  const database = harness(t);
  queue(database, '311-28000001', 'pending', 'old error');
  queue(database, '311-28000002', 'retry', 'still missing');
  queue(database, '311-28000003', 'found');
  database.prepare('INSERT INTO portal_requests (srnumber) VALUES (?), (?)')
    .run('311-28000001', '311-28000003');

  assert.equal(reconcileStoredDetails(database, {
    updatedAt: '2026-07-21T12:00:00.000Z'
  }), 1);

  const repaired = database.prepare('SELECT * FROM live_detail_queue WHERE srnumber=?')
    .get('311-28000001');
  assert.equal(repaired.status, 'found');
  assert.equal(repaired.attempts, 3);
  assert.equal(repaired.next_attempt_at, '2026-07-22T00:00:00.000Z');
  assert.equal(repaired.last_error, null);
  assert.equal(repaired.updated_at, '2026-07-21T12:00:00.000Z');
  assert.equal(database.prepare('SELECT status FROM live_detail_queue WHERE srnumber=?')
    .get('311-28000002').status, 'retry');
});

test('can reconcile one freshly persisted detail without touching other rows', t => {
  const database = harness(t);
  queue(database, '311-28000011', 'pending');
  queue(database, '311-28000012', 'pending');
  database.prepare('INSERT INTO portal_requests (srnumber) VALUES (?), (?)')
    .run('311-28000011', '311-28000012');

  assert.equal(reconcileStoredDetails(database, {
    srnumber: '311-28000012',
    updatedAt: '2026-07-21T13:00:00.000Z'
  }), 1);
  assert.equal(database.prepare('SELECT status FROM live_detail_queue WHERE srnumber=?')
    .get('311-28000011').status, 'pending');
  assert.equal(database.prepare('SELECT status FROM live_detail_queue WHERE srnumber=?')
    .get('311-28000012').status, 'found');
});

test('BID-only reconciliation ignores retained citywide queue rows', t => {
  const database = harness(t);
  queue(database, '311-28000021', 'pending');
  queue(database, '311-28000022', 'pending');
  database.prepare('INSERT INTO portal_requests (srnumber) VALUES (?), (?)')
    .run('311-28000021', '311-28000022');
  database.prepare(`
    INSERT INTO business_improvement_district_boundary_versions(version,active)
    VALUES ('bids-v1',1)
  `).run();
  database.prepare(`
    INSERT INTO live_request_bid_memberships(srnumber,boundary_version,bid_id)
    VALUES ('311-28000022','bids-v1',7)
  `).run();

  assert.equal(reconcileStoredDetails(database, {
    updatedAt: '2026-07-21T14:00:00.000Z',
    requireBidMembership: true
  }), 1);
  assert.equal(database.prepare(`
    SELECT status FROM live_detail_queue WHERE srnumber='311-28000021'
  `).get().status, 'pending');
  assert.equal(database.prepare(`
    SELECT status FROM live_detail_queue WHERE srnumber='311-28000022'
  `).get().status, 'found');
});
