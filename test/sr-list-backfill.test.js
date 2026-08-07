'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { ensureSqliteBusinessImprovementDistrictSchema } = require('../business-improvement-districts');
const {
  importSource,
  parseArguments,
  requestPortalDetail,
  runBackfill,
  stateCounts,
  validateSource
} = require('../scripts/backfill-sr-list');

const HEADERS = [
  'SR Number', 'BID ID', 'BID Name', 'Borough', 'Submitted At', 'Latitude',
  'Longitude', 'Problem', 'Status', 'Address', 'Portal URL', 'Boundary Version'
];

function csvCell(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

function writeCsv(directory, rows, name = 'source.csv') {
  const filename = path.join(directory, name);
  const csv = [HEADERS, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
  fs.writeFileSync(filename, csv);
  return filename;
}

function sourceRow({
  number,
  bidId = 1,
  bidName = `BID ${bidId}`,
  portalId = `00000000-0000-0000-0000-${String(number).slice(-8).padStart(12, '0')}`,
  status = 'In Progress',
  problem = 'Noise - Residential',
  latitude = 40.72,
  longitude = -74.0
}) {
  return [
    number,
    bidId,
    bidName,
    'Manhattan',
    '2026-01-01T05:00:00.000Z',
    latitude,
    longitude,
    problem,
    status,
    '1 TEST STREET, MANHATTAN (NEW YORK), NY, 10001',
    `https://portal.311.nyc.gov/sr-details/?id=${portalId}`,
    '2026-04-28'
  ];
}

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY,
      suffix INTEGER UNIQUE,
      portal_id TEXT UNIQUE,
      problem TEXT,
      address TEXT,
      latitude REAL,
      longitude REAL,
      submitted_at TEXT,
      status TEXT,
      portal_url TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
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
    CREATE TABLE live_detail_queue (
      srnumber TEXT PRIMARY KEY,
      portal_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE number_ledger (
      suffix INTEGER PRIMARY KEY,
      srnumber TEXT NOT NULL UNIQUE,
      outcome TEXT NOT NULL CHECK(outcome IN ('found','not_found','retry')),
      attempts INTEGER NOT NULL,
      http_status INTEGER,
      error TEXT,
      checked_at TEXT NOT NULL
    );
    CREATE TABLE live_monitor_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureSqliteBusinessImprovementDistrictSchema(database);
  database.prepare(`
    INSERT INTO business_improvement_district_boundary_versions(
      version,source_url,source_sha256,source_date,imported_at,feature_count,active
    ) VALUES ('2026-04-28','https://example.test/bids',?,'2026-04-28',?,2,1)
  `).run('a'.repeat(64), '2026-08-04T20:00:00.000Z');
  const insertBid = database.prepare(`
    INSERT INTO business_improvement_districts(
      boundary_version,bid_id,name,borough_code,borough_name,geometry_json,
      min_longitude,min_latitude,max_longitude,max_latitude
    ) VALUES ('2026-04-28',?,?,1,'Manhattan','{"type":"Polygon","coordinates":[]}',
              -75,39.5,-73,41.5)
  `);
  insertBid.run(1, 'BID 1');
  insertBid.run(2, 'BID 2');
  return database;
}

function options(input, overrides = {}) {
  return {
    input,
    refreshExisting: false,
    importBatchSize: 2,
    concurrency: 2,
    delayMs: 0,
    requestTimeoutMs: 5_000,
    maxAttempts: 2,
    retryBaseMs: 1,
    limit: null,
    progressEvery: 1,
    ...overrides
  };
}

function detailResult(item) {
  return {
    outcome: 'found',
    httpStatus: 200,
    record: {
      srnumber: item.srnumber,
      portalId: item.portal_id,
      status: 'Closed',
      problem: 'Noise - Residential',
      problemDetails: 'Loud Music/Party',
      additionalDetails: null,
      address: '1 TEST STREET, MANHATTAN (NEW YORK), NY, 10001',
      nextUpdate: null,
      dateReported: '2026-01-01T05:00:00.000Z',
      updatedOn: '2026-01-01T06:00:00.000Z',
      dateClosed: '2026-01-01T06:00:00.000Z',
      fields: { 'SR Status': 'Closed', 'Problem Details': 'Loud Music/Party' }
    }
  };
}

test('argument parser exposes bounded benchmark and retry controls', () => {
  const parsed = parseArguments([
    '--concurrency', '4', '--delay-ms', '250', '--limit', '100',
    '--max-attempts', '5', '--prepare-only'
  ], {});
  assert.equal(parsed.concurrency, 4);
  assert.equal(parsed.delayMs, 250);
  assert.equal(parsed.limit, 100);
  assert.equal(parsed.maxAttempts, 5);
  assert.equal(parsed.prepareOnly, true);
  assert.throws(() => parseArguments(['--concurrency', '9'], {}), /1 through 8/);
});

test('detail requests resolve by SR number and reject an empty Portal shell', async () => {
  const item = {
    srnumber: '311-25775504',
    portal_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    portal_url: 'https://portal.311.nyc.gov/sr-details/?id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  };
  let requestedUrl;
  const result = await requestPortalDetail(item, { requestTimeoutMs: 5_000 }, async url => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () => `
        <input id="EntityFormView_EntityID" value="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee">
        <div class="info">
          <div class="col-sm-6"><label>SR Number</label><div class="control"><span>311-25775504</span></div></div>
        </div>
      `
    };
  });
  assert.match(requestedUrl, /[?]srnum=311-25775504$/);
  assert.doesNotMatch(requestedUrl, /[?]id=/);
  assert.equal(result.outcome, 'retry');
  assert.match(result.error, /incomplete detail page/);
});

test('source validation deduplicates multi-BID SRs and rejects conflicting duplicates', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-list-backfill-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = sourceRow({ number: '311-25775504', bidId: 1 });
  const secondMembership = [...first];
  secondMembership[1] = 2;
  secondMembership[2] = 'BID 2';
  const input = writeCsv(directory, [
    first,
    secondMembership,
    sourceRow({ number: '311-25775505', bidId: 2 })
  ]);
  const validation = await validateSource(input);
  assert.equal(validation.membershipRows, 3);
  assert.equal(validation.uniqueSrNumbers, 2);
  assert.equal(validation.deduplicatedRows, 1);
  assert.equal(validation.multiBidSrNumbers, 1);

  const conflict = [...secondMembership];
  conflict[7] = 'Different problem';
  const badInput = writeCsv(directory, [first, conflict], 'conflict.csv');
  await assert.rejects(validateSource(badInput), /Conflicting map fields/);
});

test('preparation safely upserts map fields, exact memberships, and resumable items', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-list-backfill-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = sourceRow({ number: '311-25775504', bidId: 1, status: 'In Progress' });
  const secondMembership = [...first];
  secondMembership[1] = 2;
  secondMembership[2] = 'BID 2';
  const second = sourceRow({ number: '311-25775505', bidId: 2 });
  const input = writeCsv(directory, [first, secondMembership, second]);
  const database = createDatabase();
  t.after(() => database.close());
  const existingObservedAt = '2026-08-04T21:00:00.000Z';
  database.prepare(`
    INSERT INTO live_portal_requests(
      srnumber,suffix,portal_id,problem,address,latitude,longitude,submitted_at,
      status,portal_url,first_seen_at,last_seen_at,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    '311-25775504', 25775504, null, null, null, null, null, null,
    'Closed', null, existingObservedAt, existingObservedAt, '{"source":"existing"}'
  );
  database.prepare(`
    INSERT INTO portal_requests(
      srnumber,suffix,status,fields_json,portal_url,archived_at
    ) VALUES (?,?,?,?,?,?)
  `).run(
    '311-25775505', 25775505, 'Closed', '{}',
    'https://portal.311.nyc.gov/sr-details/?srnum=311-25775505',
    existingObservedAt
  );

  const validation = await validateSource(input);
  const prepared = await importSource(database, options(input), validation, {
    now: () => new Date('2026-08-04T20:00:00.000Z')
  });
  assert.equal(prepared.importedRequests, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM live_portal_requests').get().count, 2);
  assert.equal(
    database.prepare("SELECT status FROM live_portal_requests WHERE srnumber='311-25775504'").get().status,
    'Closed',
    'older source status must not overwrite an existing status'
  );
  assert.deepEqual(database.prepare(`
    SELECT srnumber,bid_id FROM live_request_bid_memberships ORDER BY srnumber,bid_id
  `).all().map(row => [row.srnumber, row.bid_id]), [
    ['311-25775504', 1],
    ['311-25775504', 2],
    ['311-25775505', 2]
  ]);
  assert.deepEqual(stateCounts(database, prepared.runId), {
    pending: 1,
    succeeded: 1,
    working: 0,
    retry: 0,
    failed: 0
  });
  assert.equal(
    database.prepare(`
      SELECT result_source FROM sr_list_backfill_items
      WHERE run_id=? AND srnumber='311-25775505'
    `).get(prepared.runId).result_source,
    'existing_database'
  );

  await importSource(database, options(input), validation, {
    now: () => new Date('2026-08-04T20:01:00.000Z')
  });
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM sr_list_backfill_items').get().count,
    2,
    're-preparing the same source must not duplicate checkpoint items'
  );
});

test('detail workers retry, checkpoint, and resume without refetching successes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-list-backfill-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = writeCsv(directory, [
    sourceRow({ number: '311-25775504', bidId: 1 }),
    sourceRow({ number: '311-25775505', bidId: 2 })
  ]);
  const database = createDatabase();
  t.after(() => database.close());
  const validation = await validateSource(input);
  const runOptions = options(input);
  const prepared = await importSource(database, runOptions, validation);
  const calls = new Map();
  const events = [];
  const result = await runBackfill(database, prepared.runId, runOptions, {
    emit: event => events.push(event),
    requestDetail: async item => {
      calls.set(item.srnumber, (calls.get(item.srnumber) || 0) + 1);
      if (item.srnumber === '311-25775504' && calls.get(item.srnumber) === 1) {
        return { outcome: 'retry', httpStatus: 503, error: 'temporary failure' };
      }
      return detailResult(item);
    }
  });
  assert.equal(result.event, 'sr_list_backfill_completed');
  assert.equal(calls.get('311-25775504'), 2);
  assert.equal(calls.get('311-25775505'), 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM portal_requests').get().count, 2);
  assert.deepEqual(stateCounts(database, prepared.runId), {
    succeeded: 2,
    pending: 0,
    working: 0,
    retry: 0,
    failed: 0
  });
  assert.ok(events.some(event => event.event === 'sr_list_backfill_progress'));

  let resumedCalls = 0;
  await runBackfill(database, prepared.runId, runOptions, {
    emit: () => {},
    requestDetail: async item => {
      resumedCalls += 1;
      return detailResult(item);
    }
  });
  assert.equal(resumedCalls, 0, 'completed checkpoints must not be fetched again');
});

test('benchmark limit caps Portal calls and leaves a resumable queue', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-list-backfill-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = writeCsv(directory, [
    sourceRow({ number: '311-25775504', bidId: 1 }),
    sourceRow({ number: '311-25775505', bidId: 1 }),
    sourceRow({ number: '311-25775506', bidId: 2 })
  ]);
  const database = createDatabase();
  t.after(() => database.close());
  const validation = await validateSource(input);
  const runOptions = options(input, { limit: 1, concurrency: 4 });
  const prepared = await importSource(database, runOptions, validation);
  let calls = 0;
  const result = await runBackfill(database, prepared.runId, runOptions, {
    emit: () => {},
    requestDetail: async item => {
      calls += 1;
      return detailResult(item);
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.event, 'sr_list_backfill_benchmark_complete');
  assert.equal(result.unresolved, 2);
  assert.deepEqual(stateCounts(database, prepared.runId), {
    succeeded: 1,
    pending: 2,
    working: 0,
    retry: 0,
    failed: 0
  });
});
