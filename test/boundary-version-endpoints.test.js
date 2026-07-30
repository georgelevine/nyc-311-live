'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

process.env.NYC311_SERVER_NO_LISTEN = '1';

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-boundary-api-'));
const databasePath = path.join(temporaryDirectory, 'archive.sqlite');
process.env.DATABASE_PATH = databasePath;

function geometry(minLongitude, minLatitude, maxLongitude, maxLatitude) {
  return JSON.stringify({
    type: 'Polygon',
    coordinates: [[
      [minLongitude, minLatitude],
      [maxLongitude, minLatitude],
      [maxLongitude, maxLatitude],
      [minLongitude, maxLatitude],
      [minLongitude, minLatitude]
    ]]
  });
}

const database = new DatabaseSync(databasePath);
database.exec(`
  CREATE TABLE live_portal_requests (
    srnumber TEXT PRIMARY KEY,
    suffix INTEGER UNIQUE,
    portal_id TEXT,
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
    boundary_version TEXT NOT NULL,
    bid_id INTEGER NOT NULL,
    PRIMARY KEY(srnumber,boundary_version,bid_id)
  );
  CREATE INDEX live_request_bid_memberships_district_idx
    ON live_request_bid_memberships(boundary_version,bid_id,srnumber);

  CREATE TABLE police_precinct_boundary_versions (
    version TEXT PRIMARY KEY,
    feature_count INTEGER NOT NULL,
    active INTEGER NOT NULL
  );
  CREATE TABLE police_precincts (
    boundary_version TEXT NOT NULL,
    precinct_number INTEGER NOT NULL,
    label TEXT NOT NULL,
    geometry_json TEXT NOT NULL,
    min_longitude REAL NOT NULL,
    min_latitude REAL NOT NULL,
    max_longitude REAL NOT NULL,
    max_latitude REAL NOT NULL,
    PRIMARY KEY(boundary_version,precinct_number)
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

  INSERT INTO police_precinct_boundary_versions VALUES
    ('26B',1,1),
    ('25D',1,0);
  INSERT INTO business_improvement_district_boundary_versions VALUES
    ('2026-04-28',1,1),
    ('2025-07-01',1,0);

  INSERT INTO live_portal_requests VALUES (
    '311-28420001',28420001,'portal-current','Noise',
    '1 CENTRE STREET, MANHATTAN, NY, 10007','MANHATTAN','10007',
    1,'26B','2026-04-28',40.715,-74.005,
    '2026-07-29T12:00:00.000Z','In Progress',
    'https://portal.311.nyc.gov/sr-details/?id=portal-current',
    '2026-07-29T12:00:01.000Z','2026-07-29T12:00:02.000Z','{}'
  );
  INSERT INTO live_request_bid_memberships VALUES (
    '311-28420001','2026-04-28',68
  );
`);

const precinctGeometry = geometry(-74.02, 40.70, -74.00, 40.72);
database.prepare(`
  INSERT INTO police_precincts VALUES (?,?,?,?,?,?,?,?)
`).run('26B', 1, '1st Precinct', precinctGeometry, -74.02, 40.70, -74.00, 40.72);
database.prepare(`
  INSERT INTO police_precincts VALUES (?,?,?,?,?,?,?,?)
`).run('25D', 9, '9th Precinct', precinctGeometry, -74.02, 40.70, -74.00, 40.72);

const bidGeometry = geometry(-74.01, 40.71, -74.00, 40.72);
database.prepare(`
  INSERT INTO business_improvement_districts VALUES (?,?,?,?,?,?,?,?,?,?)
`).run(
  '2026-04-28',
  68,
  'Current BID',
  1,
  'Manhattan',
  bidGeometry,
  -74.01,
  40.71,
  -74.00,
  40.72
);
database.prepare(`
  INSERT INTO business_improvement_districts VALUES (?,?,?,?,?,?,?,?,?,?)
`).run(
  '2025-07-01',
  99,
  'Former BID',
  1,
  'Manhattan',
  bidGeometry,
  -74.01,
  40.71,
  -74.00,
  40.72
);
database.close();

const { app } = require('../server');
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

async function get(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return {
    status: response.status,
    body: await response.json()
  };
}

test('stale BID versions return 409 even when the former district no longer exists', async () => {
  for (const endpoint of ['/api/live-map', '/api/live-dashboard']) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const result = await get(
      `${endpoint}${separator}bid_id=99&bid_boundary_version=2025-07-01`
    );
    assert.equal(result.status, 409, endpoint);
    assert.match(result.body.error, /release changed/i);
  }

  const geometryResult = await get(
    '/api/business-improvement-districts/99/geometry?boundary_version=2025-07-01'
  );
  assert.equal(geometryResult.status, 409);
  assert.match(geometryResult.body.error, /release changed/i);
});

test('stale precinct versions return 409 even when the former precinct no longer exists', async () => {
  for (const endpoint of ['/api/live-map', '/api/live-dashboard']) {
    const result = await get(
      `${endpoint}?police_precinct=9&precinct_boundary_version=25D`
    );
    assert.equal(result.status, 409, endpoint);
    assert.match(result.body.error, /release changed/i);
  }

  const geometryResult = await get(
    '/api/police-precincts/9/geometry?boundary_version=25D'
  );
  assert.equal(geometryResult.status, 409);
  assert.match(geometryResult.body.error, /release changed/i);
});

test('geometry endpoints distinguish malformed, missing, and current boundaries', async () => {
  const malformed = await get(
    '/api/business-improvement-districts/68/geometry?boundary_version=bad%20version'
  );
  assert.equal(malformed.status, 400);
  assert.match(malformed.body.error, /not a valid boundary version/i);

  const missing = await get(
    '/api/business-improvement-districts/99/geometry?boundary_version=2026-04-28'
  );
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /not in the active boundary release/i);

  const current = await get(
    '/api/business-improvement-districts/68/geometry?boundary_version=2026-04-28'
  );
  assert.equal(current.status, 200);
  assert.equal(current.body.properties.boundary_version, '2026-04-28');
  assert.equal(current.body.properties.bid_id, 68);
});

test('current boundary versions filter map and dashboard records without a false conflict', async () => {
  const query = 'bid_id=68&bid_boundary_version=2026-04-28'
    + '&police_precinct=1&precinct_boundary_version=26B';
  for (const endpoint of [
    `/api/live-map?paginate=1&limit=20&include_totals=1&${query}`,
    `/api/live-dashboard?compact=1&limit=20&${query}`
  ]) {
    const result = await get(endpoint);
    assert.equal(result.status, 200, endpoint);
    assert.deepEqual(
      result.body.records.map(record => record.srnumber),
      ['311-28420001'],
      endpoint
    );
  }
});

test('filter endpoints keep 400 semantics for malformed versions and current-release misses', async () => {
  for (const endpoint of ['/api/live-map', '/api/live-dashboard']) {
    const malformed = await get(
      `${endpoint}?bid_id=68&bid_boundary_version=bad%20version`
    );
    assert.equal(malformed.status, 400, endpoint);
    assert.match(malformed.body.error, /not a valid boundary version/i);

    const missing = await get(
      `${endpoint}?bid_id=99&bid_boundary_version=2026-04-28`
    );
    assert.equal(missing.status, 400, endpoint);
    assert.match(missing.body.error, /not in the active boundary release/i);
  }
});
