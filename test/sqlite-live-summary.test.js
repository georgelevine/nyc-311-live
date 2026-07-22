'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  collectorFreshness,
  detailSql,
  loadSqliteLiveSummary,
  summaryRows,
  summaryRowsQuery
} = require('../sqlite-live-summary');

function harness(t, { withDetails = true, withState = true } = {}) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY,
      suffix INTEGER NOT NULL UNIQUE,
      submitted_at TEXT,
      problem TEXT,
      address TEXT,
      police_precinct INTEGER,
      police_precinct_boundary_version TEXT,
      business_improvement_district_boundary_version TEXT,
      latitude REAL,
      longitude REAL,
      raw_json TEXT NOT NULL
    );
    CREATE INDEX live_portal_requests_submitted_at_idx
      ON live_portal_requests(submitted_at) WHERE submitted_at IS NOT NULL;
    CREATE TABLE live_request_bid_memberships (
      srnumber TEXT NOT NULL,
      boundary_version TEXT NOT NULL,
      bid_id INTEGER NOT NULL,
      matched_at TEXT NOT NULL,
      PRIMARY KEY(srnumber,boundary_version,bid_id)
    );
  `);
  if (withDetails) {
    database.exec(`
      CREATE TABLE portal_requests (
        srnumber TEXT PRIMARY KEY,
        date_reported TEXT,
        problem TEXT,
        address TEXT
      );
      CREATE INDEX portal_requests_date_reported_idx
        ON portal_requests(date_reported) WHERE date_reported IS NOT NULL;
    `);
  }
  if (withState) {
    database.exec(`
      CREATE TABLE live_monitor_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
  return database;
}

function insertLive(database, suffix, submittedAt, overrides = {}) {
  const record = {
    problem: 'Noise',
    address: '1 CENTRE STREET, MANHATTAN (NEW YORK), NY, 10007',
    latitude: 40.7128,
    longitude: -74.006,
    policePrecinct: null,
    policePrecinctBoundaryVersion: null,
    rawJson: '{}',
    ...overrides
  };
  const srnumber = `311-${String(suffix).padStart(8, '0')}`;
  database.prepare(`
    INSERT INTO live_portal_requests (
      srnumber,suffix,submitted_at,problem,address,police_precinct,
      police_precinct_boundary_version,latitude,longitude,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    srnumber,
    suffix,
    submittedAt,
    record.problem,
    record.address,
    record.policePrecinct,
    record.policePrecinctBoundaryVersion,
    record.latitude,
    record.longitude,
    record.rawJson
  );
  return srnumber;
}

function insertBidMembership(database, srnumber, bidId, boundaryVersion = '2026-04-28') {
  database.prepare(`
    INSERT INTO live_request_bid_memberships(srnumber,boundary_version,bid_id,matched_at)
    VALUES (?,?,?,'2026-07-21T12:00:00.000Z')
  `).run(srnumber, boundaryVersion, bidId);
}

test('scopes current, previous, delayed, and archive quality to one police precinct', t => {
  const database = harness(t, { withState: false });
  const currentVersion = { policePrecinctBoundaryVersion: '26B' };
  insertLive(database, 1, '2026-07-21T12:20:00.000Z', { policePrecinct: 1, ...currentVersion });
  insertLive(database, 2, '2026-07-21T12:21:00.000Z', { policePrecinct: 5, ...currentVersion });
  insertLive(database, 3, '2026-07-21T12:05:00.000Z', { policePrecinct: 1, ...currentVersion });
  insertLive(database, 4, '2026-07-21T11:35:00.000Z', { policePrecinct: 1, ...currentVersion });
  insertLive(database, 5, '2026-07-21T11:36:00.000Z', { policePrecinct: 5, ...currentVersion });
  insertLive(database, 6, '2026-07-21T12:22:00.000Z', {
    policePrecinct: 1,
    policePrecinctBoundaryVersion: '25D'
  });

  const result = loadSqliteLiveSummary(database, {
    asOf: '2026-07-21T12:30:00.000Z',
    policePrecinct: 1,
    policePrecinctBoundaryVersion: '26B'
  });

  assert.deepEqual(result.scope, {
    police_precinct: 1,
    police_precinct_boundary_version: '26B',
    bid_id: null,
    business_improvement_district_boundary_version: null
  });
  assert.equal(result.current.requests, 1);
  assert.equal(result.previous.requests, 1);
  assert.equal(result.delayed.requests, 1);
  assert.equal(result.data_quality.archive_requests, 3);
});

test('scopes summaries to all BID memberships and intersects with a precinct', t => {
  const database = harness(t, { withState: false });
  const first = insertLive(database, 11, '2026-07-21T12:20:00.000Z', {
    policePrecinct: 1,
    policePrecinctBoundaryVersion: '26B'
  });
  const second = insertLive(database, 12, '2026-07-21T12:21:00.000Z', {
    policePrecinct: 5,
    policePrecinctBoundaryVersion: '26B'
  });
  const third = insertLive(database, 13, '2026-07-21T12:22:00.000Z', {
    policePrecinct: 1,
    policePrecinctBoundaryVersion: '26B'
  });
  insertBidMembership(database, first, 8);
  insertBidMembership(database, first, 10);
  insertBidMembership(database, second, 8);
  insertBidMembership(database, third, 8, '2025-01-01');

  const bid = loadSqliteLiveSummary(database, {
    asOf: '2026-07-21T12:30:00.000Z',
    businessImprovementDistrictId: 8,
    businessImprovementDistrictBoundaryVersion: '2026-04-28'
  });
  assert.equal(bid.current.requests, 2);
  assert.equal(bid.data_quality.archive_requests, 2);
  assert.deepEqual(bid.scope, {
    police_precinct: null,
    police_precinct_boundary_version: null,
    bid_id: 8,
    business_improvement_district_boundary_version: '2026-04-28'
  });

  const intersection = loadSqliteLiveSummary(database, {
    asOf: '2026-07-21T12:30:00.000Z',
    policePrecinct: 1,
    policePrecinctBoundaryVersion: '26B',
    businessImprovementDistrictId: 8,
    businessImprovementDistrictBoundaryVersion: '2026-04-28'
  });
  assert.equal(intersection.current.requests, 1);
  assert.equal(intersection.data_quality.archive_requests, 1);
});

function insertDetail(database, srnumber, overrides = {}) {
  const detail = {
    dateReported: null,
    problem: null,
    address: null,
    ...overrides
  };
  database.prepare(`
    INSERT INTO portal_requests (srnumber,date_reported,problem,address)
    VALUES (?,?,?,?)
  `).run(srnumber, detail.dateReported, detail.problem, detail.address);
}

test('anchors rolling windows to the collector poll instead of the web-server clock', t => {
  const database = harness(t);
  database.prepare(`
    INSERT INTO live_monitor_state (key,value,updated_at)
    VALUES ('last_successful_poll_at',?,?)
  `).run('2026-07-21T12:30:00.000Z', '2026-07-21T12:30:01.000Z');
  insertLive(database, 1, '2026-07-21T12:20:00.000Z');
  insertLive(database, 2, '2026-07-21T12:40:00.000Z');

  const result = loadSqliteLiveSummary(database, {
    now: new Date('2026-07-21T14:00:00.000Z')
  });

  assert.equal(result.as_of, '2026-07-21T12:30:00.000Z');
  assert.equal(result.as_of_source, 'collector');
  assert.equal(result.current.start, '2026-07-21T12:15:00.000Z');
  assert.equal(result.current.end, '2026-07-21T12:30:00.000Z');
  assert.equal(result.current.requests, 1);
});

test('keeps recent windows map-only while the delayed window includes both discovery sources', t => {
  const database = harness(t, { withState: false });
  insertLive(database, 10, '2026-07-21T12:20:00.000Z');
  insertLive(database, 11, '2026-07-21T12:21:00.000Z', {
    rawJson: JSON.stringify({ source: 'number_audit' })
  });
  insertLive(database, 12, '2026-07-21T12:10:00.000Z');
  insertLive(database, 13, '2026-07-21T12:11:00.000Z', {
    rawJson: JSON.stringify({ source: 'number_audit' })
  });
  insertLive(database, 14, '2026-07-21T11:30:00.000Z');
  insertLive(database, 15, '2026-07-21T11:44:59.999Z', {
    rawJson: JSON.stringify({ source: 'number_audit' })
  });
  insertLive(database, 16, '2026-07-21T11:45:00.000Z', {
    rawJson: JSON.stringify({ source: 'number_audit' })
  });

  const result = loadSqliteLiveSummary(database, { asOf: '2026-07-21T12:30:00.000Z' });

  assert.equal(result.current.requests, 1);
  assert.equal(result.previous.requests, 1);
  assert.equal(result.delayed.start, '2026-07-21T11:30:00.000Z');
  assert.equal(result.delayed.end, '2026-07-21T11:45:00.000Z');
  assert.equal(result.delayed.requests, 2);
  assert.equal(result.current.source_scope, 'portal_map_feed');
  assert.equal(result.delayed.source_scope, 'portal_map_and_number_audit');
  assert.deepEqual(result.delayed.audit_queue, {
    state: 'unavailable', overdue_suffixes: null, verified_complete: false
  });
});

test('uses stored detail fields when the map row omitted its submitted time, problem, and address', t => {
  const database = harness(t, { withState: false });
  const srnumber = insertLive(database, 20, '   ', {
    problem: null,
    address: null,
    latitude: null,
    longitude: null
  });
  insertDetail(database, srnumber, {
    dateReported: '2026-07-21T12:20:00.000Z',
    problem: 'Illegal Parking',
    address: '1 MAIN STREET, BROOKLYN, NY, 11201'
  });

  const result = loadSqliteLiveSummary(database, { asOf: '2026-07-21T12:30:00.000Z' });

  assert.equal(result.current.requests, 1);
  assert.deepEqual(result.categories.top, [{ name: 'Illegal Parking', count: 1 }]);
  assert.deepEqual(result.boroughs.top, [{ name: 'Brooklyn', count: 1 }]);
  assert.deepEqual(result.coverage.details, { loaded: 1, pending: 0, rate: 1 });
  assert.deepEqual(result.coverage.map, { mapped: 0, unmapped: 1, rate: 0 });
});

test('classifies only explicit number-audit provenance as audit source', t => {
  const database = harness(t, { withDetails: false, withState: false });
  insertLive(database, 30, '2026-07-21T12:20:00.000Z', {
    rawJson: JSON.stringify({ source: 'number_audit' })
  });
  insertLive(database, 31, '2026-07-21T12:21:00.000Z', {
    rawJson: JSON.stringify({ source: 'map' })
  });
  insertLive(database, 32, '2026-07-21T12:22:00.000Z', {
    rawJson: JSON.stringify({ id: 'ordinary-portal-pin' })
  });
  insertLive(database, 33, '2026-07-21T12:23:00.000Z', { rawJson: 'not-json' });

  const rows = summaryRows(
    database,
    detailSql(false),
    '2026-07-21T12:15:00.000Z',
    '2026-07-21T12:30:00.000Z'
  );

  assert.deepEqual(rows.map(record => [record.srnumber, record.source]), [
    ['311-00000030', 'number_audit'],
    ['311-00000031', 'map'],
    ['311-00000032', 'map'],
    ['311-00000033', 'map']
  ]);
  assert.equal(loadSqliteLiveSummary(database, {
    asOf: '2026-07-21T12:30:00.000Z'
  }).current.requests, 3);
});

test('reports archive-wide missing and invalid timestamp quality without putting them in a window', t => {
  const database = harness(t, { withState: false });
  insertLive(database, 40, '2026-07-21T12:20:00.000Z');
  insertLive(database, 41, null);
  insertLive(database, 42, 'July 21 at noon');
  const fallback = insertLive(database, 43, null, { problem: null, address: null });
  insertDetail(database, fallback, {
    dateReported: '2026-07-20T11:00:00.000Z',
    problem: 'Street Condition',
    address: '1 MAIN STREET, QUEENS, NY, 11368'
  });

  const result = loadSqliteLiveSummary(database, { asOf: '2026-07-21T12:30:00.000Z' });

  assert.deepEqual(result.data_quality, {
    archive_requests: 4,
    missing_submitted_time: 1,
    invalid_submitted_time: 1,
    excluded_from_time_statistics: 2,
    oldest_submitted_at: '2026-07-20T11:00:00.000Z'
  });
  assert.equal(result.current.requests, 1);
  assert.deepEqual(result.history, {
    span_days: 1,
    target_days: 14,
    target_reached: false,
    continuity_verified: false
  });
});

test('reports stale and invalid collector anchors instead of presenting them as current', t => {
  const database = harness(t);
  const save = database.prepare(`
    INSERT INTO live_monitor_state (key,value,updated_at) VALUES (?,?,?)
  `);
  save.run('last_successful_poll_at', '2026-07-21T12:00:00.000Z', '2026-07-21T12:00:00.000Z');

  assert.deepEqual(collectorFreshness(database, '2026-07-21T12:10:00.000Z'), {
    state: 'stale',
    last_successful_poll_at: '2026-07-21T12:00:00.000Z',
    poll_age_seconds: 600,
    stale_after_seconds: 300
  });

  database.prepare(`UPDATE live_monitor_state SET value=? WHERE key='last_successful_poll_at'`)
    .run('2026-07-21T12:11:01.000Z');
  const result = loadSqliteLiveSummary(database, { now: '2026-07-21T12:10:00.000Z' });
  assert.equal(result.capture.state, 'invalid');
  assert.equal(result.as_of, '2026-07-21T12:10:00.000Z');
  assert.equal(result.as_of_source, 'clock');
});

test('uses the collector audit delay and exposes overdue audit backlog without claiming completion', t => {
  const database = harness(t);
  database.exec(`
    CREATE TABLE live_number_queue (
      suffix INTEGER PRIMARY KEY,
      audit_after TEXT NOT NULL,
      audit_outcome TEXT NOT NULL
    );
  `);
  const save = database.prepare(`
    INSERT INTO live_monitor_state (key,value,updated_at) VALUES (?,?,?)
  `);
  save.run('audit_delay_minutes', '40', '2026-07-21T12:30:00.000Z');
  database.prepare(`INSERT INTO live_number_queue(suffix,audit_after,audit_outcome) VALUES(?,?,?)`)
    .run(1, '2026-07-21T12:20:00.000Z', 'pending');

  const result = loadSqliteLiveSummary(database, { asOf: '2026-07-21T12:30:00.000Z' });
  assert.equal(result.completeness.audit_delay_minutes, 40);
  assert.equal(result.delayed.end, '2026-07-21T11:40:00.000Z');
  assert.deepEqual(result.delayed.audit_queue, {
    state: 'backlogged', overdue_suffixes: 1, verified_complete: false
  });
});

test('recent-row query uses the timestamp index before joining detail fallbacks', t => {
  const database = harness(t);
  const query = `EXPLAIN QUERY PLAN ${summaryRowsQuery(detailSql(true))}`;
  const plan = database.prepare(query).all({
    start: '2026-07-21T12:15:00.000Z',
    end: '2026-07-21T12:30:00.000Z'
  }).map(row => String(row.detail));

  assert.ok(plan.some(detail => detail.includes('live_portal_requests_submitted_at_idx')), plan.join('\n'));
  assert.ok(plan.some(detail => detail.includes('portal_requests_date_reported_idx')), plan.join('\n'));
});
