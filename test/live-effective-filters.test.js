const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

process.env.NYC311_SERVER_NO_LISTEN = '1';

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-effective-filters-'));
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

  CREATE TABLE live_monitor_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE live_number_queue (
    suffix INTEGER PRIMARY KEY,
    audit_outcome TEXT,
    audit_after TEXT
  );

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

  CREATE TABLE request_followup_queue (
    srnumber TEXT PRIMARY KEY,
    portal_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('open', 'closing', 'closed')),
    next_check_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    closing_attempts INTEGER NOT NULL DEFAULT 0,
    closure_cycle INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_success_at TEXT,
    last_error TEXT,
    finalized_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE request_closure_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    srnumber TEXT NOT NULL,
    closure_cycle INTEGER NOT NULL,
    status TEXT,
    date_closed TEXT,
    source TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    is_final INTEGER NOT NULL DEFAULT 0,
    final_state TEXT,
    content_hash TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
  );

  CREATE UNIQUE INDEX request_closure_snapshots_final_idx
    ON request_closure_snapshots(srnumber, closure_cycle)
    WHERE is_final = 1;
`);

const insertLive = database.prepare(`
  INSERT INTO live_portal_requests (
    srnumber,suffix,portal_id,problem,address,borough,incident_zip,
    latitude,longitude,submitted_at,status,portal_url,first_seen_at,last_seen_at,raw_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const insertDetail = database.prepare(`
  INSERT INTO portal_requests (
    srnumber,suffix,portal_id,status,problem,problem_details,additional_details,
    address,next_update,date_reported,updated_on,date_closed,fields_json,
    portal_url,archived_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

function addRequest({
  suffix,
  liveProblem,
  liveAddress,
  liveSubmittedAt,
  liveStatus = 'In Progress',
  detailProblem,
  detailAddress,
  detailDateReported,
  detailStatus = 'In Progress',
  followupState = null
}) {
  const srnumber = `311-${suffix}`;
  const portalId = `portal-${suffix}`;
  const portalUrl = `https://portal.311.nyc.gov/sr-details/?id=${portalId}`;
  insertLive.run(
    srnumber,
    suffix,
    portalId,
    liveProblem,
    liveAddress,
    'MANHATTAN',
    '10007',
    40.71 + (suffix % 100) / 10_000,
    -74.00 - (suffix % 100) / 10_000,
    liveSubmittedAt,
    liveStatus,
    portalUrl,
    '2026-07-29T10:00:00.000Z',
    '2026-07-29T10:00:01.000Z',
    '{}'
  );
  insertDetail.run(
    srnumber,
    suffix,
    portalId,
    detailStatus,
    detailProblem,
    null,
    null,
    detailAddress,
    null,
    detailDateReported,
    '2026-07-29T12:05:00.000Z',
    null,
    '{}',
    portalUrl,
    '2026-07-29T12:06:00.000Z'
  );
  if (followupState) {
    database.prepare(`
      INSERT INTO request_followup_queue (
        srnumber,portal_id,state,next_check_at,closure_cycle,updated_at
      ) VALUES (?,?,?,?,?,?)
    `).run(
      srnumber,
      portalId,
      followupState,
      null,
      1,
      '2026-07-29T12:07:00.000Z'
    );
  }
  return srnumber;
}

const timestampFallbackSr = addRequest({
  suffix: 28420004,
  liveProblem: 'Timestamp fallback',
  liveAddress: '1 CLOCK PLACE, MANHATTAN, NY, 10007',
  liveSubmittedAt: 'not-a-timestamp',
  detailProblem: 'Timestamp fallback',
  detailAddress: '1 CLOCK PLACE, MANHATTAN, NY, 10007',
  detailDateReported: '2026-07-29T12:00:00.000Z'
});
const detailOnlySr = addRequest({
  suffix: 28420003,
  liveProblem: null,
  liveAddress: null,
  liveSubmittedAt: '2026-07-29T12:01:00.000Z',
  detailProblem: 'Hydrant Mystery',
  detailAddress: '99 HIDDEN PROMENADE, MANHATTAN, NY, 10007',
  detailDateReported: '2026-07-29T12:01:00.000Z'
});
const closingSr = addRequest({
  suffix: 28420002,
  liveProblem: 'Lifecycle closing case',
  liveAddress: '2 STATE PLACE, MANHATTAN, NY, 10007',
  liveSubmittedAt: '2026-07-29T12:02:00.000Z',
  detailProblem: 'Lifecycle closing case',
  detailAddress: '2 STATE PLACE, MANHATTAN, NY, 10007',
  detailDateReported: '2026-07-29T12:02:00.000Z',
  followupState: 'closing'
});
const closedSr = addRequest({
  suffix: 28420001,
  liveProblem: 'Lifecycle closed case',
  liveAddress: '3 STATE PLACE, MANHATTAN, NY, 10007',
  liveSubmittedAt: '2026-07-29T12:03:00.000Z',
  detailProblem: 'Lifecycle closed case',
  detailAddress: '3 STATE PLACE, MANHATTAN, NY, 10007',
  detailDateReported: '2026-07-29T12:03:00.000Z',
  followupState: 'closed'
});
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

async function payload(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  assert.equal(response.status, 200, pathname);
  return response.json();
}

test('map and dashboard time filters and output fall back from malformed live timestamps', async () => {
  const query = '&submitted_since=2026-07-29T11%3A00%3A00.000Z&q=timestamp%20fallback';
  const [map, dashboard] = await Promise.all([
    payload(`/api/live-map?paginate=1&limit=20&include_totals=1${query}`),
    payload(`/api/live-dashboard?compact=0&limit=20${query}`)
  ]);

  assert.deepEqual(map.records.map(record => record.srnumber), [timestampFallbackSr]);
  assert.equal(map.records[0].submitted_at, '2026-07-29T12:00:00.000Z');
  assert.deepEqual(map.stats, { total: 1, mapped_total: 1, unmapped_total: 0 });
  assert.deepEqual(dashboard.records.map(record => record.srnumber), [timestampFallbackSr]);
  assert.equal(dashboard.records[0].submitted_at, '2026-07-29T12:00:00.000Z');
  assert.equal(dashboard.page.matching_total, 1);
  assert.equal(dashboard.stats.total, 1);
});

test('map and dashboard broad search use detail-only problem and address fallbacks', async () => {
  for (const query of ['hydrant mystery', 'hidden promenade']) {
    const encoded = encodeURIComponent(query);
    const [map, dashboard] = await Promise.all([
      payload(`/api/live-map?paginate=1&limit=20&include_totals=1&q=${encoded}`),
      payload(`/api/live-dashboard?compact=1&limit=20&q=${encoded}`)
    ]);

    assert.deepEqual(map.records.map(record => record.srnumber), [detailOnlySr], query);
    assert.equal(map.stats.total, 1, query);
    assert.deepEqual(dashboard.records.map(record => record.srnumber), [detailOnlySr], query);
    assert.equal(dashboard.page.matching_total, 1, query);
  }
});

test('map and dashboard status filters use lifecycle-projected closure state', async () => {
  const query = '&status=Closed&q=lifecycle';
  const [map, dashboard] = await Promise.all([
    payload(`/api/live-map?paginate=1&limit=20&include_totals=1${query}`),
    payload(`/api/live-dashboard?compact=0&limit=20${query}`)
  ]);
  const expected = [closingSr, closedSr];

  assert.deepEqual(map.records.map(record => record.srnumber), expected);
  assert.deepEqual(map.records.map(record => record.status), ['Closed', 'Closed']);
  assert.deepEqual(map.stats, { total: 2, mapped_total: 2, unmapped_total: 0 });
  assert.deepEqual(dashboard.records.map(record => record.srnumber), expected);
  assert.deepEqual(dashboard.records.map(record => record.status), ['Closed', 'Closed']);
  assert.equal(dashboard.page.matching_total, 2);
  assert.equal(dashboard.stats.total, 2);
  assert.equal(dashboard.stats.closure_refreshes_pending, 1);
  assert.equal(dashboard.stats.closures_finalized, 1);
});
