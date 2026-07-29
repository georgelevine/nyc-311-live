const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

process.env.NYC311_SERVER_NO_LISTEN = '1';

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-compact-dashboard-'));
const databasePath = path.join(temporaryDirectory, 'archive.sqlite');
process.env.DATABASE_PATH = databasePath;

const database = new DatabaseSync(databasePath);
database.exec(`
  CREATE TABLE live_portal_requests (
    srnumber TEXT PRIMARY KEY,
    suffix INTEGER UNIQUE,
    portal_id TEXT UNIQUE,
    problem TEXT,
    address TEXT,
    borough TEXT,
    incident_zip TEXT,
    police_precinct INTEGER,
    police_precinct_boundary_version TEXT,
    business_improvement_district_boundary_version TEXT,
    latitude REAL,
    longitude REAL,
    submitted_at TEXT,
    status TEXT,
    portal_url TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
  );
  CREATE TABLE live_request_bid_memberships (
    srnumber TEXT NOT NULL,
    bid_id INTEGER NOT NULL,
    boundary_version TEXT NOT NULL
  );
  CREATE INDEX live_portal_requests_submitted_at_idx
    ON live_portal_requests(submitted_at);
  CREATE INDEX live_portal_requests_police_precinct_idx
    ON live_portal_requests(police_precinct,suffix DESC);
  CREATE TABLE portal_requests (
    srnumber TEXT PRIMARY KEY,
    suffix INTEGER NOT NULL UNIQUE,
    portal_id TEXT UNIQUE,
    status TEXT,
    problem TEXT,
    problem_details TEXT,
    additional_details TEXT,
    address TEXT,
    next_update TEXT,
    date_reported TEXT,
    updated_on TEXT,
    date_closed TEXT,
    fields_json TEXT NOT NULL,
    portal_url TEXT NOT NULL,
    archived_at TEXT NOT NULL
  );
  CREATE TABLE live_monitor_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
database.prepare(`
  INSERT INTO live_portal_requests (
    srnumber,suffix,portal_id,problem,address,borough,incident_zip,
    latitude,longitude,submitted_at,status,portal_url,first_seen_at,last_seen_at,raw_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
  '311-28390001',
  28390001,
  'portal-1',
  'Noise',
  '1 CENTRE STREET, MANHATTAN, NY, 10007',
  'MANHATTAN',
  '10007',
  40.7128,
  -74.006,
  '2026-07-29T12:00:00.000Z',
  'In Progress',
  'https://portal.311.nyc.gov/sr-details/?id=portal-1',
  '2026-07-29T12:00:01.000Z',
  '2026-07-29T12:00:02.000Z',
  '{}'
);
database.prepare(`
  INSERT INTO portal_requests (
    srnumber,suffix,portal_id,status,problem,problem_details,additional_details,
    address,next_update,date_reported,updated_on,date_closed,fields_json,
    portal_url,archived_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
  '311-28390001',
  28390001,
  'portal-1',
  'In Progress',
  'Noise',
  'Loud Music/Party',
  'Music from a residence',
  '1 CENTRE STREET, MANHATTAN, NY, 10007',
  '24 Hours',
  '2026-07-29T12:00:00.000Z',
  '2026-07-29T12:00:03.000Z',
  null,
  JSON.stringify({ 'Agency Response': 'The agency is reviewing this request.' }),
  'https://portal.311.nyc.gov/sr-details/?id=portal-1',
  '2026-07-29T12:00:04.000Z'
);
const insertState = database.prepare(`
  INSERT INTO live_monitor_state (key,value,updated_at) VALUES (?,?,?)
`);
insertState.run('live_frontier', '28390001', '2026-07-29T12:00:05.000Z');
insertState.run('last_successful_poll_at', '2026-07-29T12:00:05.000Z', '2026-07-29T12:00:05.000Z');
insertState.run('poll_interval_seconds', '30', '2026-07-29T12:00:05.000Z');
insertState.run(
  'legacy_reconciliation',
  JSON.stringify({
    version: 1,
    status: 'complete',
    total_candidates: 10,
    checked: 10,
    api_returned: 8,
    api_omitted: 2,
    api_closed: 3,
    api_open: 5
  }),
  '2026-07-29T12:00:05.000Z'
);
database.close();

const { app, liveMapRequestIndexClause } = require('../server');
let server;
let baseUrl;

before(async () => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.close();
    await once(server, 'close');
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('compact live dashboard returns records and only key-value monitor stats', async () => {
  const response = await fetch(`${baseUrl}/api/live-dashboard?limit=1&compact=1`);
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0].srnumber, '311-28390001');
  assert.equal(payload.records[0].status, 'In Progress');
  assert.equal(payload.records[0].problem_details, 'Loud Music/Party');
  assert.equal(payload.records[0].agency_response, 'The agency is reviewing this request.');

  assert.deepEqual(Object.keys(payload.stats).sort(), [
    'compact',
    'frontier',
    'last_seen_at',
    'last_successful_poll_at',
    'legacy_reconciliation',
    'poll_interval_seconds'
  ]);
  assert.equal(payload.stats.compact, true);
  assert.equal(payload.stats.frontier, 28390001);
  assert.equal(payload.stats.last_seen_at, '2026-07-29T12:00:05.000Z');
  assert.equal(payload.stats.last_successful_poll_at, '2026-07-29T12:00:05.000Z');
  assert.equal(payload.stats.poll_interval_seconds, 30);
  assert.equal(payload.stats.legacy_reconciliation.status, 'complete');
  assert.equal(payload.stats.legacy_reconciliation.percent, 100);
});

test('dashboard defaults to the safe compact path for older browser clients', async () => {
  const response = await fetch(`${baseUrl}/api/live-dashboard?limit=1`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.records.length, 1);
  assert.equal(payload.stats.compact, true);
  assert.equal(Object.hasOwn(payload.stats, 'total'), false);
});

test('compact query flag accepts only exact 0 or 1 values', async () => {
  for (const value of ['', 'true', 'yes', '2', '-1']) {
    const response = await fetch(
      `${baseUrl}/api/live-dashboard?compact=${encodeURIComponent(value)}`
    );
    assert.equal(response.status, 400, `compact=${JSON.stringify(value)}`);
    const payload = await response.json();
    assert.match(payload.error, /compact must be 0 or 1/);
  }
});

test('map fast path returns records without archive totals', async () => {
  const response = await fetch(
    `${baseUrl}/api/live-map?limit=1&include_totals=0`
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0].srnumber, '311-28390001');
  assert.equal(Object.hasOwn(payload, 'stats'), false);
  assert.deepEqual(payload.page, {
    limit: 1,
    returned: 1,
    has_more: false,
    more_available: true,
    next_before_suffix: 28390001
  });
});

test('map defaults to skipping totals for older browser clients', async () => {
  const response = await fetch(`${baseUrl}/api/live-map`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.records.length, 1);
  assert.equal(Object.hasOwn(payload, 'stats'), false);
  assert.deepEqual(payload.page, {
    limit: 250,
    returned: 1,
    has_more: false,
    more_available: false,
    next_before_suffix: 28390001
  });
});

test('map cursor remains available for deliberate manual paging', async () => {
  const response = await fetch(
    `${baseUrl}/api/live-map?limit=1&before_suffix=28390001`
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.page, {
    limit: 1,
    returned: 0,
    has_more: false,
    more_available: false,
    next_before_suffix: null
  });
});

test('map rejects page sizes large enough to monopolize the web process', async () => {
  const response = await fetch(`${baseUrl}/api/live-map?limit=1001`);
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.match(payload.error, /limit must be an integer from 1 through 1000/);
});

test('map totals flag accepts only exact 0 or 1 values', async () => {
  for (const value of ['', 'true', 'yes', '2', '-1']) {
    const response = await fetch(
      `${baseUrl}/api/live-map?include_totals=${encodeURIComponent(value)}`
    );
    assert.equal(response.status, 400, `include_totals=${JSON.stringify(value)}`);
    const payload = await response.json();
    assert.match(payload.error, /include_totals must be 0 or 1/);
  }
});

test('map fast paths force suffix-ordered indexes and avoid temporary sorting', () => {
  const readable = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const unscopedClause = liveMapRequestIndexClause(readable, {
      precinct: null,
      bid: null
    });
    assert.match(unscopedClause, /^INDEXED BY /);
    const unscopedPlan = readable.prepare(`
      EXPLAIN QUERY PLAN
      SELECT live.suffix
      FROM live_portal_requests AS live
      ${unscopedClause}
      WHERE live.latitude BETWEEN -90 AND 90
        AND live.longitude BETWEEN -180 AND 180
        AND live.submitted_at >= ?
      ORDER BY live.suffix DESC
      LIMIT ?
    `).all('2026-07-28T00:00:00.000Z', 250);
    assert.equal(
      unscopedPlan.some(row => /TEMP B-TREE/i.test(row.detail)),
      false,
      JSON.stringify(unscopedPlan)
    );

    const precinctClause = liveMapRequestIndexClause(readable, {
      precinct: { precinct: 1, boundaryVersion: 'test-v1' },
      bid: null
    });
    assert.match(precinctClause, /live_portal_requests_police_precinct_idx/);
    const precinctPlan = readable.prepare(`
      EXPLAIN QUERY PLAN
      SELECT live.suffix
      FROM live_portal_requests AS live
      ${precinctClause}
      WHERE live.police_precinct=?
        AND live.police_precinct_boundary_version=?
        AND live.latitude BETWEEN -90 AND 90
        AND live.longitude BETWEEN -180 AND 180
        AND live.submitted_at >= ?
      ORDER BY live.suffix DESC
      LIMIT ?
    `).all(1, 'test-v1', '2026-07-28T00:00:00.000Z', 250);
    assert.equal(
      precinctPlan.some(row => /TEMP B-TREE/i.test(row.detail)),
      false,
      JSON.stringify(precinctPlan)
    );

    assert.equal(liveMapRequestIndexClause(readable, {
      precinct: null,
      bid: { bidId: 68, boundaryVersion: 'test-v1' }
    }), '');
  } finally {
    readable.close();
  }
});
