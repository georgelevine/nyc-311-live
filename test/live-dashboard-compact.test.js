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
  CREATE INDEX live_request_bid_memberships_district_idx
    ON live_request_bid_memberships(boundary_version,bid_id,srnumber);
  CREATE TABLE business_improvement_district_boundary_versions (
    version TEXT PRIMARY KEY,
    active INTEGER NOT NULL
  );
  CREATE TABLE business_improvement_districts (
    boundary_version TEXT NOT NULL,
    bid_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY(boundary_version,bid_id)
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
  CREATE TABLE live_number_queue (
    suffix INTEGER PRIMARY KEY,
    audit_outcome TEXT,
    audit_after TEXT
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
const insertLiveRequest = database.prepare(`
  INSERT INTO live_portal_requests (
    srnumber,suffix,portal_id,problem,address,borough,incident_zip,
    latitude,longitude,submitted_at,status,portal_url,first_seen_at,last_seen_at,raw_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
insertLiveRequest.run(
  '311-28390000',
  28390000,
  'portal-2',
  'Illegal Parking',
  '2 CENTRE STREET, MANHATTAN, NY, 10007',
  'MANHATTAN',
  '10007',
  40.713,
  -74.005,
  '2026-07-29T11:59:00.000Z',
  'Closed',
  'https://portal.311.nyc.gov/sr-details/?id=portal-2',
  '2026-07-29T11:59:01.000Z',
  '2026-07-29T11:59:02.000Z',
  '{}'
);
insertLiveRequest.run(
  '311-28389999',
  28389999,
  'portal-3',
  'Noise',
  '3 CENTRE STREET, MANHATTAN, NY, 10007',
  'MANHATTAN',
  '10007',
  40.714,
  -74.004,
  '2026-07-28T12:00:00.000Z',
  'In Progress',
  'https://portal.311.nyc.gov/sr-details/?id=portal-3',
  '2026-07-28T12:00:01.000Z',
  '2026-07-28T12:00:02.000Z',
  '{}'
);
database.prepare(`
  INSERT INTO business_improvement_district_boundary_versions(version,active)
  VALUES (?,1)
`).run('test-v1');
database.prepare(`
  INSERT INTO business_improvement_districts(boundary_version,bid_id,name)
  VALUES (?,?,?)
`).run('test-v1', 68, 'Test BID');
const insertBidMembership = database.prepare(`
  INSERT INTO live_request_bid_memberships(srnumber,bid_id,boundary_version)
  VALUES (?,?,?)
`);
insertBidMembership.run('311-28390001', 68, 'test-v1');
insertBidMembership.run('311-28389999', 68, 'test-v1');
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

test('dashboard can skip an expensive first-page matching total without changing records', async () => {
  const defaultResponse = await fetch(
    `${baseUrl}/api/live-dashboard?limit=1&compact=1&status=Closed`
  );
  assert.equal(defaultResponse.status, 200);
  const defaultPayload = await defaultResponse.json();
  assert.deepEqual(defaultPayload.records.map(record => record.srnumber), ['311-28390000']);
  assert.equal(defaultPayload.page.matching_total, 1);

  const skippedResponse = await fetch(
    `${baseUrl}/api/live-dashboard?limit=1&compact=1&status=Closed&include_totals=0`
  );
  assert.equal(skippedResponse.status, 200);
  const skippedPayload = await skippedResponse.json();
  assert.deepEqual(skippedPayload.records, defaultPayload.records);
  assert.equal(Object.hasOwn(skippedPayload.page, 'matching_total'), false);
  assert.equal(skippedPayload.page.snapshot_at != null, true);

  for (const value of ['', 'true', 'yes', '2', '-1']) {
    const response = await fetch(
      `${baseUrl}/api/live-dashboard?include_totals=${encodeURIComponent(value)}`
    );
    assert.equal(response.status, 400, `include_totals=${JSON.stringify(value)}`);
    const payload = await response.json();
    assert.match(payload.error, /include_totals must be 0 or 1/);
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
    next_before_suffix: 28390001,
    snapshot_at: null
  });
});

test('map defaults to skipping totals for older browser clients', async () => {
  const response = await fetch(`${baseUrl}/api/live-map`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.records.length, 3);
  assert.equal(Object.hasOwn(payload, 'stats'), false);
  assert.deepEqual(payload.page, {
    limit: 250,
    returned: 3,
    has_more: false,
    more_available: false,
    next_before_suffix: 28389999,
    snapshot_at: null
  });
});

test('map cursor requires deliberate snapshot pagination', async () => {
  const response = await fetch(
    `${baseUrl}/api/live-map?limit=1&before_suffix=28390001`
  );
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.match(payload.error, /require paginate=1/);
});

test('map snapshot pagination returns a truthful continuation cursor', async () => {
  const firstResponse = await fetch(
    `${baseUrl}/api/live-map?limit=1&paginate=1`
  );
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.page.has_more, true);
  assert.equal(first.page.more_available, true);
  assert.equal(first.page.next_before_suffix, 28390001);
  assert.match(first.page.snapshot_at, /^\d{4}-\d{2}-\d{2}T/);

  const response = await fetch(
    `${baseUrl}/api/live-map?limit=1&paginate=1`
      + `&before_suffix=${first.page.next_before_suffix}`
      + `&snapshot_at=${encodeURIComponent(first.page.snapshot_at)}`
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.records[0].srnumber, '311-28390000');
  assert.deepEqual(payload.page, {
    limit: 1,
    returned: 1,
    has_more: true,
    more_available: true,
    next_before_suffix: 28390000,
    snapshot_at: first.page.snapshot_at
  });
});

test('map snapshot pagination excludes requests first observed after page one', async () => {
  const firstResponse = await fetch(
    `${baseUrl}/api/live-map?limit=1&paginate=1`
  );
  const first = await firstResponse.json();
  const lateFirstSeenAt = new Date(
    new Date(first.page.snapshot_at).getTime() + 1_000
  ).toISOString();
  const writable = new DatabaseSync(databasePath);
  try {
    writable.prepare(`
      INSERT INTO live_portal_requests (
        srnumber,suffix,portal_id,problem,address,borough,incident_zip,
        latitude,longitude,submitted_at,status,portal_url,first_seen_at,last_seen_at,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      '311-28389998',
      28389998,
      'portal-late',
      'Late request',
      '4 CENTRE STREET, MANHATTAN, NY, 10007',
      'MANHATTAN',
      '10007',
      40.715,
      -74.003,
      '2026-07-28T11:00:00.000Z',
      'In Progress',
      'https://portal.311.nyc.gov/sr-details/?id=portal-late',
      lateFirstSeenAt,
      lateFirstSeenAt,
      '{}'
    );
  } finally {
    writable.close();
  }
  try {
    const response = await fetch(
      `${baseUrl}/api/live-map?limit=20&paginate=1`
        + `&before_suffix=${first.page.next_before_suffix}`
        + `&snapshot_at=${encodeURIComponent(first.page.snapshot_at)}`
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(
      payload.records.some(record => record.srnumber === '311-28389998'),
      false
    );
  } finally {
    const cleanup = new DatabaseSync(databasePath);
    try {
      cleanup.prepare('DELETE FROM live_portal_requests WHERE srnumber=?')
        .run('311-28389998');
    } finally {
      cleanup.close();
    }
  }
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

test('map totals use the same time, status, and search filters as records', async () => {
  const response = await fetch(
    `${baseUrl}/api/live-map?paginate=1&limit=20&include_totals=1`
      + '&submitted_since=2026-07-29T11%3A00%3A00.000Z'
      + '&status=Closed&q=parking'
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.records.map(record => record.srnumber), ['311-28390000']);
  assert.deepEqual(payload.stats, {
    total: 1,
    mapped_total: 1,
    unmapped_total: 0
  });
  assert.equal(payload.page.has_more, false);
});

test('map BID scope starts from indexed memberships and returns only members', async () => {
  const response = await fetch(
    `${baseUrl}/api/live-map?paginate=1&limit=20&include_totals=1&bid_id=68`
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(
    payload.records.map(record => record.srnumber),
    ['311-28390001', '311-28389999']
  );
  assert.equal(payload.stats.total, 2);

  const readable = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const plan = readable.prepare(`
      EXPLAIN QUERY PLAN
      SELECT live.suffix
      FROM live_request_bid_memberships AS scope_bid
      JOIN live_portal_requests AS live ON live.srnumber=scope_bid.srnumber
      WHERE scope_bid.boundary_version=? AND scope_bid.bid_id=?
      ORDER BY live.suffix DESC
      LIMIT ?
    `).all('test-v1', 68, 20);
    assert.equal(
      plan.some(row => /SEARCH scope_bid USING COVERING INDEX live_request_bid_memberships_district_idx/i
        .test(row.detail)),
      true,
      JSON.stringify(plan)
    );
    assert.equal(
      plan.some(row => /SCAN live(?:\\s|$)/i.test(row.detail)),
      false,
      JSON.stringify(plan)
    );
  } finally {
    readable.close();
  }
});

test('BID map and feed pagination traverse every record beyond their former caps', async () => {
  const writable = new DatabaseSync(databasePath);
  const insertedSuffixFloor = 28370000;
  const insertedCount = 260;
  try {
    const insertRequest = writable.prepare(`
      INSERT INTO live_portal_requests (
        srnumber,suffix,portal_id,problem,address,borough,incident_zip,
        latitude,longitude,submitted_at,status,portal_url,first_seen_at,last_seen_at,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertMembership = writable.prepare(`
      INSERT INTO live_request_bid_memberships(srnumber,bid_id,boundary_version)
      VALUES (?,?,?)
    `);
    writable.exec('BEGIN');
    for (let offset = 0; offset < insertedCount; offset += 1) {
      const suffix = insertedSuffixFloor + offset;
      const srnumber = `311-${suffix}`;
      insertRequest.run(
        srnumber,
        suffix,
        `bulk-${suffix}`,
        'Bulk pagination test',
        `${offset + 1} TEST STREET, MANHATTAN, NY, 10007`,
        'MANHATTAN',
        '10007',
        40.70 + offset / 100_000,
        -74.00 - offset / 100_000,
        '2026-07-27T12:00:00.000Z',
        'In Progress',
        `https://portal.311.nyc.gov/sr-details/?id=bulk-${suffix}`,
        '2026-07-27T12:00:01.000Z',
        '2026-07-27T12:00:02.000Z',
        '{}'
      );
      insertMembership.run(srnumber, 68, 'test-v1');
    }
    writable.exec('COMMIT');

    const seen = new Set();
    let beforeSuffix = null;
    let snapshotAt = null;
    let firstStats = null;
    let pages = 0;
    do {
      const parameters = new URLSearchParams({
        paginate: '1',
        limit: '100',
        include_totals: pages === 0 ? '1' : '0',
        bid_id: '68',
        ...(beforeSuffix == null ? {} : { before_suffix: String(beforeSuffix) }),
        ...(snapshotAt == null ? {} : { snapshot_at: snapshotAt })
      });
      const response = await fetch(`${baseUrl}/api/live-map?${parameters}`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      if (pages === 0) firstStats = payload.stats;
      for (const record of payload.records) {
        assert.equal(seen.has(record.srnumber), false, record.srnumber);
        seen.add(record.srnumber);
      }
      pages += 1;
      snapshotAt = payload.page.snapshot_at;
      beforeSuffix = payload.page.has_more
        ? payload.page.next_before_suffix
        : null;
    } while (beforeSuffix != null);

    assert.equal(seen.size, insertedCount + 2);
    assert.equal(firstStats.total, insertedCount + 2);
    assert.equal(firstStats.mapped_total, insertedCount + 2);
    assert.equal(pages, 3);

    const feedSeen = new Set();
    let feedBeforeSuffix = null;
    let feedSnapshotAt = null;
    let feedPages = 0;
    let feedMatchingTotal = null;
    do {
      const parameters = new URLSearchParams({
        compact: '1',
        limit: '100',
        bid_id: '68',
        q: 'bulk pagination test',
        ...(feedBeforeSuffix == null
          ? {}
          : { before_suffix: String(feedBeforeSuffix) }),
        ...(feedSnapshotAt == null ? {} : { snapshot_at: feedSnapshotAt })
      });
      const response = await fetch(`${baseUrl}/api/live-dashboard?${parameters}`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      if (feedPages === 0) feedMatchingTotal = payload.page.matching_total;
      for (const record of payload.records) {
        assert.equal(feedSeen.has(record.srnumber), false, record.srnumber);
        feedSeen.add(record.srnumber);
      }
      feedPages += 1;
      feedSnapshotAt = payload.page.snapshot_at;
      feedBeforeSuffix = payload.page.has_more
        ? payload.page.next_before_suffix
        : null;
    } while (feedBeforeSuffix != null);

    assert.equal(feedSeen.size, insertedCount);
    assert.equal(feedMatchingTotal, insertedCount);
    assert.equal(feedPages, 3);
  } finally {
    writable.exec(`
      DELETE FROM live_request_bid_memberships
      WHERE srnumber IN (
        SELECT srnumber FROM live_portal_requests
        WHERE suffix>=${insertedSuffixFloor}
          AND suffix<${insertedSuffixFloor + insertedCount}
      );
      DELETE FROM live_portal_requests
      WHERE suffix>=${insertedSuffixFloor}
        AND suffix<${insertedSuffixFloor + insertedCount};
    `);
    writable.close();
  }
});

test('dashboard keyset pagination is stable and filters its full totals', async () => {
  const firstResponse = await fetch(
    `${baseUrl}/api/live-dashboard?limit=1&compact=1&q=noise`
  );
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.deepEqual(first.records.map(record => record.srnumber), ['311-28390001']);
  assert.equal(first.page.has_more, true);
  assert.equal(first.page.matching_total, 2);
  assert.match(first.page.snapshot_at, /^\d{4}-\d{2}-\d{2}T/);

  const secondResponse = await fetch(
    `${baseUrl}/api/live-dashboard?limit=1&compact=1&q=noise`
      + `&before_suffix=${first.page.next_before_suffix}`
      + `&snapshot_at=${encodeURIComponent(first.page.snapshot_at)}`
  );
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  assert.deepEqual(second.records.map(record => record.srnumber), ['311-28389999']);
  assert.equal(second.page.has_more, false);
  assert.equal(Object.hasOwn(second.page, 'matching_total'), false);

  const totalsResponse = await fetch(
    `${baseUrl}/api/live-dashboard?limit=20&compact=0`
      + '&submitted_since=2026-07-29T11%3A00%3A00.000Z'
      + '&status=Closed&q=parking'
  );
  assert.equal(totalsResponse.status, 200);
  const totals = await totalsResponse.json();
  assert.deepEqual(totals.records.map(record => record.srnumber), ['311-28390000']);
  assert.equal(totals.stats.total, 1);
  assert.equal(totals.stats.details_loaded, 0);
  assert.equal(totals.stats.details_pending, 1);
});

test('broad search stays on lightweight request-card fields', async () => {
  const response = await fetch(
    `${baseUrl}/api/live-dashboard?limit=20&compact=1&q=loud%20music`
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.records, []);
  assert.equal(payload.page.matching_total, 0);
});

test('dashboard rejects cursors without their original snapshot', async () => {
  const response = await fetch(
    `${baseUrl}/api/live-dashboard?limit=1&before_suffix=28390001`
  );
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.match(payload.error, /snapshot_at is required/);
});

test('dashboard BID records and totals use the same indexed membership scope', async () => {
  const response = await fetch(
    `${baseUrl}/api/live-dashboard?limit=20&compact=0&bid_id=68`
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(
    payload.records.map(record => record.srnumber),
    ['311-28390001', '311-28389999']
  );
  assert.equal(payload.page.matching_total, 2);
  assert.equal(payload.stats.total, 2);
  assert.equal(payload.stats.details_loaded, 1);
  assert.equal(payload.stats.details_pending, 1);
});

test('exact dashboard lookups remain available outside the 300-record page contract', async () => {
  const response = await fetch(
    `${baseUrl}/api/live-dashboard?limit=9999&compact=1&srnumber=311-28389999`
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.records.map(record => record.srnumber), ['311-28389999']);
  assert.equal(payload.page.limit, 1);
  assert.equal(payload.page.has_more, false);
  assert.equal(payload.page.matching_total, 1);
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

    const exactClause = liveMapRequestIndexClause(readable, {
      precinct: null,
      bid: null
    }, { exactSrnumber: true });
    assert.equal(exactClause, '');
    const exactPlan = readable.prepare(`
      EXPLAIN QUERY PLAN
      SELECT live.suffix
      FROM live_portal_requests AS live
      WHERE live.srnumber=?
        AND live.latitude BETWEEN -90 AND 90
        AND live.longitude BETWEEN -180 AND 180
      ORDER BY live.suffix DESC
      LIMIT ?
    `).all('311-28390001', 1);
    assert.equal(
      exactPlan.some(row => /SEARCH live USING INDEX .*srnumber/i.test(row.detail)),
      true,
      JSON.stringify(exactPlan)
    );

    assert.equal(liveMapRequestIndexClause(readable, {
      precinct: null,
      bid: { bidId: 68, boundaryVersion: 'test-v1' }
    }), '');
  } finally {
    readable.close();
  }
});
