'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

process.env.NYC311_SERVER_NO_LISTEN = '1';
const priorCollectorScope = process.env.COLLECTOR_SCOPE;
delete process.env.COLLECTOR_SCOPE;

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-server-scope-'));
const databasePath = path.join(directory, 'archive.sqlite');
process.env.DATABASE_PATH = databasePath;

const MEMBER_SR = '311-00000071';
const OUTSIDE_SR = '311-00000072';
const upstreamCalls = [];
let simulateAdaptiveCap = false;

const database = new DatabaseSync(databasePath);
database.exec(`
  CREATE TABLE live_monitor_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE live_portal_requests (
    srnumber TEXT PRIMARY KEY,
    portal_id TEXT UNIQUE
  );
  CREATE TABLE live_request_bid_memberships (
    srnumber TEXT NOT NULL,
    boundary_version TEXT NOT NULL,
    bid_id INTEGER NOT NULL
  );
  CREATE TABLE business_improvement_district_boundary_versions (
    version TEXT PRIMARY KEY,
    feature_count INTEGER NOT NULL,
    active INTEGER NOT NULL
  );
  CREATE TABLE business_improvement_districts (
    boundary_version TEXT NOT NULL,
    bid_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    borough_code INTEGER NOT NULL,
    borough_name TEXT NOT NULL,
    geometry_json TEXT NOT NULL,
    min_longitude REAL NOT NULL,
    min_latitude REAL NOT NULL,
    max_longitude REAL NOT NULL,
    max_latitude REAL NOT NULL,
    PRIMARY KEY(boundary_version,bid_id)
  );
  CREATE TABLE request_status_history (
    id INTEGER PRIMARY KEY,
    srnumber TEXT NOT NULL,
    previous_status TEXT,
    status TEXT,
    source TEXT,
    effective_at TEXT,
    observed_at TEXT
  );
  CREATE TABLE nyc311_email_aliases (
    srnumber TEXT PRIMARY KEY,
    state TEXT,
    subscribed_at TEXT,
    last_received_at TEXT
  );
  CREATE TABLE nyc311_email_events (
    id INTEGER PRIMARY KEY,
    reconciled_srnumber TEXT,
    parse_outcome TEXT,
    srnumber_mismatch INTEGER,
    alias_match_status TEXT,
    event_kind TEXT,
    agency_name TEXT,
    agency_acronym TEXT,
    request_type TEXT,
    request_subtype TEXT,
    response_text TEXT,
    next_update_text TEXT,
    received_at TEXT,
    closure_wake_queued INTEGER
  );

  INSERT INTO live_monitor_state VALUES (
    'collector_scope','bid_only','2026-08-07T12:00:00.000Z'
  );
  INSERT INTO business_improvement_district_boundary_versions VALUES ('bids-v1',1,1);
  INSERT INTO business_improvement_districts VALUES (
    'bids-v1',1,'Test BID',1,'Manhattan',
    '{"type":"Polygon","coordinates":[[[-74.01,40.70],[-74.00,40.70],[-74.01,40.71],[-74.01,40.70]]]}',
    -74.01,40.70,-74.00,40.71
  );
  INSERT INTO live_portal_requests VALUES
    ('${MEMBER_SR}','11111111-1111-4111-8111-111111111111'),
    ('${OUTSIDE_SR}','22222222-2222-4222-8222-222222222222');
  INSERT INTO live_request_bid_memberships VALUES ('${MEMBER_SR}','bids-v1',1);

  INSERT INTO request_status_history VALUES
    (1,'${MEMBER_SR}','Pending','In Progress','test',NULL,'2026-08-07T12:01:00.000Z'),
    (2,'${OUTSIDE_SR}','Pending','OUTSIDE STATUS SENTINEL','test',NULL,
      '2026-08-07T12:02:00.000Z');
  INSERT INTO nyc311_email_aliases VALUES
    ('${MEMBER_SR}','active','2026-08-07T12:00:00.000Z',NULL),
    ('${OUTSIDE_SR}','outside-email-sentinel','2026-08-07T12:00:00.000Z',NULL);
  INSERT INTO nyc311_email_events VALUES
    (1,'${MEMBER_SR}','parsed',0,'matched','agency_update','Department of Test','DOT',
      'Noise',NULL,'Member response',NULL,'2026-08-07T12:03:00.000Z',0),
    (2,'${OUTSIDE_SR}','parsed',0,'matched','agency_update','Department of Test','DOT',
      'Noise',NULL,'OUTSIDE EMAIL SENTINEL',NULL,'2026-08-07T12:04:00.000Z',0);
`);
database.close();

async function mockNodeFetch(url) {
  const address = String(url);
  upstreamCalls.push(address);
  let portalPins = null;
  if (address.includes('/entity-pin-fetch-service-requests/')) {
    const portalUrl = new URL(address);
    const isFullBidBox = portalUrl.searchParams.get('minlongitude') === '-74.01'
      && portalUrl.searchParams.get('maxlongitude') === '-74';
    portalPins = simulateAdaptiveCap && isFullBidBox
      ? Array.from({ length: 100 }, (_, index) => ({
          id: `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
          latitude: 40.7001 + index * 0.000001,
          longitude: -74.0099 + index * 0.000001,
          data: {
            srnumber: `311-${String(index + 100).padStart(8, '0')}`,
            problem: 'Capped BID result',
            submitteddate: '08/07/2026 12:00:00 PM',
            status: 'In Progress'
          }
        }))
      : [
        {
          id: '33333333-3333-4333-8333-333333333333',
          latitude: 40.702,
          longitude: -74.008,
          data: {
            srnumber: '311-00000073',
            problem: 'Inside BID',
            submitteddate: '08/07/2026 12:00:00 PM',
            status: 'In Progress'
          }
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          latitude: 40.709,
          longitude: -74.001,
          data: {
            srnumber: '311-00000074',
            problem: 'Outside exact BID polygon',
            submitteddate: '08/07/2026 12:00:00 PM',
            status: 'In Progress'
          }
        }
      ];
  }
  const body = portalPins
    ? JSON.stringify(portalPins)
    : JSON.stringify({ source: 'mock-portal', number: OUTSIDE_SR });
  return {
    ok: true,
    status: 200,
    async text() {
      return body;
    }
  };
}

const originalLoad = Module._load;
Module._load = function loadWithMockedFetch(request, parent, isMain) {
  if (request === 'node-fetch') return mockNodeFetch;
  return originalLoad.call(this, request, parent, isMain);
};
const { app } = require('../server');
Module._load = originalLoad;

let server;
let baseUrl;

before(async () => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  Module._load = originalLoad;
  if (priorCollectorScope == null) delete process.env.COLLECTOR_SCOPE;
  else process.env.COLLECTOR_SCOPE = priorCollectorScope;
  if (server) {
    server.close();
    await once(server, 'close');
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

function setScope({ configured, durable }) {
  if (configured == null) delete process.env.COLLECTOR_SCOPE;
  else process.env.COLLECTOR_SCOPE = configured;
  const writable = new DatabaseSync(databasePath);
  try {
    writable.prepare(`
      UPDATE live_monitor_state SET value=?,updated_at=? WHERE key='collector_scope'
    `).run(durable, new Date().toISOString());
  } finally {
    writable.close();
  }
}

async function get(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
}

test('missing COLLECTOR_SCOPE defaults to BID-only when durable state agrees', async () => {
  setScope({ configured: null, durable: 'bid_only' });

  const history = await get(`/api/status-history/${MEMBER_SR}`);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.history.map(row => row.status), ['In Progress']);

  const email = await get(`/api/email-updates/${MEMBER_SR}`);
  assert.equal(email.status, 200);
  assert.equal(email.body.subscription.state, 'active');
  assert.deepEqual(email.body.updates.map(row => row.response_text), ['Member response']);
});

test('default BID configuration rejects durable citywide state with 503', async () => {
  setScope({ configured: null, durable: 'citywide' });

  for (const pathname of [
    `/api/status-history/${MEMBER_SR}`,
    `/api/email-updates/${MEMBER_SR}`,
    `/api/portal-sr?number=${MEMBER_SR}`,
    '/api/portal-pins?minlatitude=40&minlongitude=-75&maxlatitude=41&maxlongitude=-73'
  ]) {
    const result = await get(pathname);
    assert.equal(result.status, 503, pathname);
  }
});

test('explicit citywide configuration works only when durable state agrees', async () => {
  setScope({ configured: 'citywide', durable: 'citywide' });

  const history = await get(`/api/status-history/${OUTSIDE_SR}`);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.history.map(row => row.status), ['OUTSIDE STATUS SENTINEL']);

  const email = await get(`/api/email-updates/${OUTSIDE_SR}`);
  assert.equal(email.status, 200);
  assert.equal(email.body.subscription.state, 'outside-email-sentinel');
  assert.deepEqual(email.body.updates.map(row => row.response_text), [
    'OUTSIDE EMAIL SENTINEL'
  ]);

  const callsBefore = upstreamCalls.length;
  const portal = await get(`/api/portal-sr?number=${OUTSIDE_SR}`);
  assert.equal(portal.status, 200);
  assert.equal(portal.body.source, 'mock-portal');
  assert.equal(upstreamCalls.length, callsBefore + 1);
});

test('BID-only raw bbox proxy is rejected without contacting NYC311', async () => {
  setScope({ configured: null, durable: 'bid_only' });
  const callsBefore = upstreamCalls.length;

  const result = await get(
    '/api/portal-pins?minlatitude=40&minlongitude=-75&maxlatitude=41&maxlongitude=-73'
  );
  assert.equal(result.status, 404);
  assert.equal(upstreamCalls.length, callsBefore);
});

test('adaptive BID proxy derives its bbox server-side and exact-filters Portal pins', async () => {
  setScope({ configured: null, durable: 'bid_only' });
  const callsBefore = upstreamCalls.length;
  const maliciousBbox = 'minlatitude=-90&minlongitude=-180&maxlatitude=90&maxlongitude=180';

  const result = await get(
    `/api/portal-pins-adaptive?bid_id=1&bid_boundary_version=bids-v1&${maliciousBbox}`
      + '&fromdate=2026-08-07&todate=2026-08-07'
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.scope, 'bid_only');
  assert.equal(result.body.bid_id, 1);
  assert.equal(result.body.bid_boundary_version, 'bids-v1');
  assert.deepEqual(result.body.pins.map(pin => pin.srnumber), ['311-00000073']);
  assert.equal(upstreamCalls.length, callsBefore + 1);

  const portalUrl = new URL(upstreamCalls.at(-1));
  assert.equal(portalUrl.searchParams.get('minlatitude'), '40.7');
  assert.equal(portalUrl.searchParams.get('minlongitude'), '-74.01');
  assert.equal(portalUrl.searchParams.get('maxlatitude'), '40.71');
  assert.equal(portalUrl.searchParams.get('maxlongitude'), '-74');
});

test('adaptive BID proxy requires bid_id before contacting NYC311', async () => {
  setScope({ configured: null, durable: 'bid_only' });
  const callsBefore = upstreamCalls.length;

  const result = await get(
    '/api/portal-pins-adaptive?fromdate=2026-08-07&todate=2026-08-07'
  );
  assert.equal(result.status, 400);
  assert.match(result.body.error, /bid_id is required/i);
  assert.equal(upstreamCalls.length, callsBefore);
});

test('adaptive BID proxy rejects stale boundary versions before contacting NYC311', async () => {
  setScope({ configured: null, durable: 'bid_only' });
  const callsBefore = upstreamCalls.length;

  const result = await get(
    '/api/portal-pins-adaptive?bid_id=1&bid_boundary_version=bids-v0'
      + '&fromdate=2026-08-07&todate=2026-08-07'
  );
  assert.equal(result.status, 409);
  assert.match(result.body.error, /boundary release changed/i);
  assert.equal(upstreamCalls.length, callsBefore);
});

test('adaptive BID proxy recursively recovers a capped day before exact filtering', async () => {
  setScope({ configured: null, durable: 'bid_only' });
  const callsBefore = upstreamCalls.length;
  simulateAdaptiveCap = true;
  try {
    const result = await get(
      '/api/portal-pins-adaptive?bid_id=1&bid_boundary_version=bids-v1&refresh=1'
        + '&fromdate=2026-08-07&todate=2026-08-07'
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.pins.map(pin => pin.srnumber), ['311-00000073']);
    assert.equal(result.body.stats.phase2_capped_days, 1);
    assert.equal(result.body.stats.phase2_calls, 4);
    assert.equal(result.body.stats.recursive_spatial_splits, 1);
    assert.equal(result.body.stats.unresolved_caps, 0);
    assert.equal(upstreamCalls.length, callsBefore + 5);
  } finally {
    simulateAdaptiveCap = false;
  }
});

test('BID-only SR, status, and email endpoints hide retained citywide requests', async () => {
  setScope({ configured: null, durable: 'bid_only' });
  const callsBefore = upstreamCalls.length;

  for (const pathname of [
    `/api/portal-sr?number=${OUTSIDE_SR}`,
    `/api/status-history/${OUTSIDE_SR}`,
    `/api/email-updates/${OUTSIDE_SR}`
  ]) {
    const result = await get(pathname);
    assert.equal(result.status, 404, pathname);
    assert.match(result.body.error, /outside the active BID collection scope/i);
  }
  assert.equal(upstreamCalls.length, callsBefore);
});

test('explicit citywide configuration with durable BID state fails closed', async () => {
  setScope({ configured: 'citywide', durable: 'bid_only' });

  for (const pathname of [
    `/api/status-history/${MEMBER_SR}`,
    `/api/email-updates/${MEMBER_SR}`,
    `/api/portal-sr?number=${MEMBER_SR}`
  ]) {
    const result = await get(pathname);
    assert.equal(result.status, 503, pathname);
  }
});
