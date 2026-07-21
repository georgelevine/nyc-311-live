'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { createClosureTracker } = require('../closure-tracking');
const { promoteAuditDiscoveries } = require('../audit-discovery');

const OBSERVED_AT = '2026-07-20T18:00:00.000Z';

function harness(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY, suffix INTEGER UNIQUE, portal_id TEXT UNIQUE,
      problem TEXT, address TEXT, latitude REAL, longitude REAL,
      submitted_at TEXT, status TEXT, portal_url TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE live_number_queue (
      suffix INTEGER PRIMARY KEY, srnumber TEXT NOT NULL UNIQUE,
      first_detected_at TEXT NOT NULL, audit_after TEXT NOT NULL,
      map_seen INTEGER NOT NULL DEFAULT 0,
      audit_outcome TEXT NOT NULL DEFAULT 'pending', audited_at TEXT
    );
    CREATE TABLE portal_requests (
      srnumber TEXT PRIMARY KEY, suffix INTEGER NOT NULL UNIQUE,
      portal_id TEXT UNIQUE, status TEXT, problem TEXT,
      problem_details TEXT, additional_details TEXT, address TEXT,
      next_update TEXT, date_reported TEXT, updated_on TEXT,
      date_closed TEXT, fields_json TEXT NOT NULL,
      portal_url TEXT NOT NULL, archived_at TEXT NOT NULL
    );
    CREATE TABLE live_detail_queue (
      srnumber TEXT PRIMARY KEY, portal_id TEXT, status TEXT NOT NULL,
      attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL,
      last_error TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE number_ledger (
      suffix INTEGER PRIMARY KEY, srnumber TEXT NOT NULL UNIQUE,
      outcome TEXT NOT NULL, attempts INTEGER NOT NULL,
      http_status INTEGER, error TEXT, checked_at TEXT NOT NULL
    );
  `);
  return { db, closureTracker: createClosureTracker(db) };
}

function requestNumber(suffix) {
  return `311-${String(suffix).padStart(8, '0')}`;
}

function addAuditedRequest(db, {
  suffix = 12345678,
  status = 'Open',
  dateClosed = null,
  ledgerOutcome = 'found',
  mapSeen = 0,
  auditOutcome = 'found'
} = {}) {
  const srnumber = requestNumber(suffix);
  const portalId = `11111111-2222-3333-4444-${String(suffix).padStart(12, '0')}`;
  db.prepare(`
    INSERT INTO live_number_queue (
      suffix, srnumber, first_detected_at, audit_after,
      map_seen, audit_outcome, audited_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    suffix, srnumber, '2026-07-20T17:00:00.000Z',
    '2026-07-20T17:35:00.000Z', mapSeen, auditOutcome,
    '2026-07-20T17:40:00.000Z'
  );
  db.prepare(`
    INSERT INTO number_ledger (
      suffix, srnumber, outcome, attempts, http_status, error, checked_at
    ) VALUES (?, ?, ?, 1, 200, NULL, ?)
  `).run(suffix, srnumber, ledgerOutcome, '2026-07-20T17:40:00.000Z');
  db.prepare(`
    INSERT INTO portal_requests (
      srnumber, suffix, portal_id, status, problem, problem_details,
      additional_details, address, next_update, date_reported,
      updated_on, date_closed, fields_json, portal_url, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    srnumber, suffix, portalId, status, 'Illegal Parking',
    'Blocked Hydrant', null, '1 CENTRE STREET, NEW YORK, NY, 10007',
    '24 hours', '2026-07-20T16:55:00Z', '2026-07-20T17:30:00Z',
    dateClosed, JSON.stringify({ 'Problem Details': 'Blocked Hydrant' }),
    `https://portal.311.nyc.gov/sr-details/?id=${portalId}`,
    '2026-07-20T17:40:00.000Z'
  );
  return { srnumber, portalId, suffix };
}

function promote(db, closureTracker, overrides = {}) {
  return promoteAuditDiscoveries({
    db,
    closureTracker,
    observedAt: OBSERVED_AT,
    ...overrides
  });
}

test('promotes an audit-only Open request and is idempotent on reconciliation rerun', t => {
  const { db, closureTracker } = harness(t);
  const { srnumber } = addAuditedRequest(db);

  assert.deepEqual(promote(db, closureTracker), {
    candidates: 1,
    promoted: 1,
    open: 1,
    closing: 0,
    closed: 0,
    conflicts: 0,
    invalid: 0
  });
  const live = db.prepare(`
    SELECT status, latitude, longitude, submitted_at, first_seen_at, raw_json
    FROM live_portal_requests WHERE srnumber = ?
  `).get(srnumber);
  assert.equal(live.status, 'Open');
  assert.equal(live.latitude, null);
  assert.equal(live.longitude, null);
  assert.equal(live.submitted_at, '2026-07-20T16:55:00Z');
  assert.equal(live.first_seen_at, '2026-07-20T17:40:00.000Z');
  assert.equal(JSON.parse(live.raw_json).source, 'number_audit');
  assert.equal(JSON.parse(live.raw_json).coordinate_free, true);
  assert.equal(db.prepare(`
    SELECT status FROM live_detail_queue WHERE srnumber = ?
  `).get(srnumber).status, 'found');
  assert.equal(db.prepare(`
    SELECT source FROM request_status_history WHERE srnumber = ?
  `).get(srnumber).source, 'number_audit');
  assert.equal(closureTracker.getFollowUp.get(srnumber).state, 'open');

  assert.deepEqual(promote(db, closureTracker), {
    candidates: 0,
    promoted: 0,
    open: 0,
    closing: 0,
    closed: 0,
    conflicts: 0,
    invalid: 0
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM live_portal_requests').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM request_status_history').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM request_followup_queue').get().count, 1);
});

test('promotes Closed with date as one complete final closure inside a caller transaction', t => {
  const { db, closureTracker } = harness(t);
  const dateClosed = '2026-07-20T17:25:00Z';
  const { srnumber } = addAuditedRequest(db, { status: 'In Progress', dateClosed });

  db.exec('BEGIN');
  const counts = promote(db, closureTracker, { manageTransaction: false });
  db.exec('COMMIT');
  assert.deepEqual(counts, {
    candidates: 1,
    promoted: 1,
    open: 0,
    closing: 0,
    closed: 1,
    conflicts: 0,
    invalid: 0
  });
  assert.equal(db.prepare(`
    SELECT status FROM live_portal_requests WHERE srnumber = ?
  `).get(srnumber).status, 'Closed');
  const final = db.prepare(`
    SELECT status, date_closed, is_final, final_state
    FROM request_closure_snapshots WHERE srnumber = ?
  `).get(srnumber);
  assert.equal(final.status, 'Closed');
  assert.equal(final.date_closed, dateClosed);
  assert.equal(final.is_final, 1);
  assert.equal(final.final_state, 'complete');
});

test('promotes exact Cancel as a closing request when no closure date is available', t => {
  const { db, closureTracker } = harness(t);
  const { srnumber } = addAuditedRequest(db, { status: 'Cancel' });

  const counts = promote(db, closureTracker);
  assert.equal(counts.closing, 1);
  const followUp = closureTracker.getFollowUp.get(srnumber);
  assert.equal(followUp.state, 'closing');
  assert.equal(followUp.closure_cycle, 1);
  assert.equal(followUp.closing_attempts, 1);
  const snapshot = db.prepare(`
    SELECT status, is_final, final_state
    FROM request_closure_snapshots WHERE srnumber = ?
  `).get(srnumber);
  assert.equal(snapshot.status, 'Cancel');
  assert.equal(snapshot.is_final, 0);
  assert.equal(snapshot.final_state, null);
});

test('promotes an unknown-status detail safely and schedules an open recheck without history', t => {
  const { db, closureTracker } = harness(t);
  const { srnumber } = addAuditedRequest(db, { status: null });

  const counts = promote(db, closureTracker);
  assert.equal(counts.open, 1);
  assert.equal(db.prepare(`
    SELECT status FROM live_portal_requests WHERE srnumber = ?
  `).get(srnumber).status, null);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM request_status_history WHERE srnumber = ?
  `).get(srnumber).count, 0);
  assert.equal(closureTracker.getFollowUp.get(srnumber).state, 'open');
});

test('promotion requires the audit queue and ledger to agree on found', t => {
  const { db, closureTracker } = harness(t);
  addAuditedRequest(db, { suffix: 12345670, ledgerOutcome: 'not_found' });
  addAuditedRequest(db, { suffix: 12345671, mapSeen: 1 });
  addAuditedRequest(db, { suffix: 12345672, auditOutcome: 'pending' });
  addAuditedRequest(db, { suffix: 12345673 });

  assert.deepEqual(promote(db, closureTracker, {
    lowSuffix: 12345673,
    highSuffix: 12345673
  }), {
    candidates: 1,
    promoted: 1,
    open: 1,
    closing: 0,
    closed: 0,
    conflicts: 0,
    invalid: 0
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM live_portal_requests').get().count, 1);
});

test('invalid request identities and insert conflicts are counted without partial promotion', t => {
  const { db, closureTracker } = harness(t);
  addAuditedRequest(db, { suffix: 123456789 });
  const conflict = addAuditedRequest(db, { suffix: 12345674 });
  db.prepare(`
    INSERT INTO live_portal_requests (
      srnumber, suffix, portal_id, problem, address, latitude, longitude,
      submitted_at, status, portal_url, first_seen_at, last_seen_at, raw_json
    ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, '{}')
  `).run(
    '311-99999999', 99999999, conflict.portalId,
    '2026-07-20T17:00:00.000Z', '2026-07-20T17:00:00.000Z'
  );

  assert.deepEqual(promote(db, closureTracker), {
    candidates: 2,
    promoted: 0,
    open: 0,
    closing: 0,
    closed: 0,
    conflicts: 1,
    invalid: 1
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM live_detail_queue').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM request_status_history').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM request_followup_queue').get().count, 0);
});

test('a later map pin enriches the promoted row instead of creating a duplicate', t => {
  const { db, closureTracker } = harness(t);
  const { srnumber, suffix, portalId } = addAuditedRequest(db);
  promote(db, closureTracker);
  const mapSeenAt = '2026-07-20T18:05:00.000Z';
  const mapRaw = JSON.stringify({ source: 'map', data: { srnumber } });

  db.prepare(`
    INSERT INTO live_portal_requests (
      srnumber, suffix, portal_id, problem, address, latitude, longitude,
      submitted_at, status, portal_url, first_seen_at, last_seen_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(srnumber) DO UPDATE SET
      portal_id = COALESCE(excluded.portal_id, live_portal_requests.portal_id),
      problem = COALESCE(excluded.problem, live_portal_requests.problem),
      address = COALESCE(excluded.address, live_portal_requests.address),
      latitude = COALESCE(excluded.latitude, live_portal_requests.latitude),
      longitude = COALESCE(excluded.longitude, live_portal_requests.longitude),
      submitted_at = COALESCE(excluded.submitted_at, live_portal_requests.submitted_at),
      status = COALESCE(excluded.status, live_portal_requests.status),
      portal_url = COALESCE(excluded.portal_url, live_portal_requests.portal_url),
      last_seen_at = excluded.last_seen_at,
      raw_json = excluded.raw_json
  `).run(
    srnumber, suffix, portalId, 'Illegal Parking',
    '1 CENTRE STREET, NEW YORK, NY, 10007', 40.7128, -74.006,
    '7/20/2026 4:55:00 PM', 'In Progress',
    `https://portal.311.nyc.gov/sr-details/?id=${portalId}`,
    mapSeenAt, mapSeenAt, mapRaw
  );

  const rows = db.prepare(`
    SELECT latitude, longitude, status, first_seen_at, last_seen_at, raw_json
    FROM live_portal_requests WHERE srnumber = ?
  `).all(srnumber);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].latitude, 40.7128);
  assert.equal(rows[0].longitude, -74.006);
  assert.equal(rows[0].status, 'In Progress');
  assert.equal(rows[0].first_seen_at, '2026-07-20T17:40:00.000Z');
  assert.equal(rows[0].last_seen_at, mapSeenAt);
  assert.equal(JSON.parse(rows[0].raw_json).source, 'map');
  assert.equal(promote(db, closureTracker).promoted, 0);
});
