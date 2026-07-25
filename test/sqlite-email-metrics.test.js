'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  computeSqliteEmailMetrics,
  durationStatistics,
  loadSqliteEmailMetrics
} = require('../sqlite-email-metrics');

function createSchema(database) {
  database.exec(`
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY,
      submitted_at TEXT
    );
    CREATE TABLE portal_requests (
      srnumber TEXT PRIMARY KEY,
      date_reported TEXT,
      date_closed TEXT
    );
    CREATE TABLE nyc311_email_subscription_jobs (
      srnumber TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      subscribed_at TEXT
    );
    CREATE TABLE nyc311_email_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciled_srnumber TEXT,
      event_kind TEXT,
      subject TEXT,
      received_at TEXT,
      parse_outcome TEXT NOT NULL,
      srnumber_mismatch INTEGER NOT NULL DEFAULT 0,
      alias_match_status TEXT NOT NULL,
      agency_name TEXT,
      agency_acronym TEXT,
      request_type TEXT,
      request_subtype TEXT,
      response_text TEXT,
      spam_verdict TEXT,
      virus_verdict TEXT,
      spf_verdict TEXT,
      dkim_verdict TEXT,
      dmarc_verdict TEXT,
      parsed_json TEXT
    );
  `);
}

function insertRequest(database, {
  srnumber,
  liveSubmitted,
  portalSubmitted = liveSubmitted,
  portalClosed = null,
  state = 'subscribed',
  subscribedAt = null
}) {
  database.prepare(`
    INSERT INTO live_portal_requests(srnumber,submitted_at) VALUES (?,?)
  `).run(srnumber, liveSubmitted);
  database.prepare(`
    INSERT INTO portal_requests(srnumber,date_reported,date_closed) VALUES (?,?,?)
  `).run(srnumber, portalSubmitted, portalClosed);
  database.prepare(`
    INSERT INTO nyc311_email_subscription_jobs(srnumber,state,subscribed_at)
    VALUES (?,?,?)
  `).run(srnumber, state, subscribedAt);
}

function insertEmail(database, {
  srnumber,
  kind,
  subject = `SR ${kind} # ${srnumber}`,
  receivedAt,
  parseOutcome = 'parsed',
  aliasMatchStatus = 'matched',
  mismatch = 0,
  agencyName = null,
  agencyAcronym = null,
  requestType = null,
  requestSubtype = null,
  responseText,
  deliveryMode = 'direct',
  spamVerdict = 'PASS',
  virusVerdict = 'PASS',
  spfVerdict = 'PASS',
  dkimVerdict = 'PASS',
  dmarcVerdict = 'PASS'
}) {
  const expectedResponse = responseText === undefined
    && ['updated', 'closed'].includes(String(kind || '').toLowerCase())
    ? 'Agency response'
    : responseText ?? null;
  database.prepare(`
    INSERT INTO nyc311_email_events (
      reconciled_srnumber,event_kind,subject,received_at,parse_outcome,
      srnumber_mismatch,alias_match_status,agency_name,agency_acronym,
      request_type,request_subtype,response_text,parsed_json
      ,spam_verdict,virus_verdict,spf_verdict,dkim_verdict,dmarc_verdict
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    srnumber,
    kind,
    subject,
    receivedAt,
    parseOutcome,
    mismatch,
    aliasMatchStatus,
    agencyName,
    agencyAcronym,
    requestType,
    requestSubtype,
    expectedResponse,
    JSON.stringify({ deliveryMode }),
    spamVerdict,
    virusVerdict,
    spfVerdict,
    dkimVerdict,
    dmarcVerdict
  );
}

function populatedDatabase() {
  const database = new DatabaseSync(':memory:');
  createSchema(database);
  insertRequest(database, {
    srnumber: '311-00000001',
    liveSubmitted: '2026-07-25T08:00:00.000Z',
    portalSubmitted: '2026-07-25T10:00:00.000Z',
    portalClosed: '2026-07-25T11:00:00.000Z',
    subscribedAt: '2026-07-25T10:01:00.000Z'
  });
  insertRequest(database, {
    srnumber: '311-00000002',
    liveSubmitted: '2026-07-25T10:00:00.000Z',
    portalClosed: '2026-07-25T12:00:00.000Z',
    subscribedAt: '2026-07-25T10:02:00.000Z'
  });
  insertRequest(database, {
    srnumber: '311-00000003',
    liveSubmitted: '2026-07-25T10:00:00.000Z',
    portalClosed: '2026-07-25T13:00:00.000Z',
    subscribedAt: '2026-07-25T10:20:00.000Z'
  });
  insertRequest(database, {
    srnumber: '311-00000004',
    liveSubmitted: '2026-07-25T10:00:00.000Z',
    subscribedAt: null,
    state: 'pending'
  });
  insertRequest(database, {
    srnumber: '311-00000005',
    liveSubmitted: '2026-07-25T10:00:00.000Z',
    subscribedAt: '2026-07-25T10:00:30.000Z'
  });
  insertRequest(database, {
    srnumber: '311-00000006',
    liveSubmitted: '2026-07-25T10:00:00.000Z',
    subscribedAt: '2026-07-25T10:00:10.000Z'
  });

  for (const receivedAt of [
    '2026-07-25T10:10:00.000Z',
    '2026-07-25T10:20:00.000Z'
  ]) {
    insertEmail(database, {
      srnumber: '311-00000001',
      kind: 'Updated',
      receivedAt,
      agencyName: 'Alpha Department',
      agencyAcronym: 'ALPHA',
      requestType: 'Noise',
      requestSubtype: 'Residential'
    });
  }
  insertEmail(database, {
    srnumber: '311-00000001',
    kind: 'Closed',
    receivedAt: '2026-07-25T11:05:00.000Z',
    agencyName: 'Beta Department',
    agencyAcronym: 'BETA',
    requestType: 'Noise',
    requestSubtype: 'Residential'
  });
  insertEmail(database, {
    srnumber: '311-00000002',
    kind: 'Updated',
    receivedAt: '2026-07-25T10:04:00.000Z',
    agencyName: 'Alpha Department',
    agencyAcronym: 'ALPHA',
    requestType: 'Noise',
    requestSubtype: 'Street'
  });
  insertEmail(database, {
    srnumber: '311-00000002',
    kind: 'Closed',
    receivedAt: '2026-07-25T12:00:30.000Z',
    agencyName: 'Beta Department',
    agencyAcronym: 'BETA',
    requestType: 'Noise',
    requestSubtype: 'Street'
  });
  insertEmail(database, {
    srnumber: '311-00000003',
    kind: 'Updated',
    receivedAt: '2026-07-25T10:21:00.000Z',
    agencyName: 'Alpha Department',
    agencyAcronym: 'ALPHA',
    requestType: 'Noise'
  });
  insertEmail(database, {
    srnumber: '311-00000006',
    kind: null,
    subject: 'SR Submitted # 311-00000006',
    receivedAt: '2026-07-25T14:00:00.000Z',
    parseOutcome: 'unrecognized',
    agencyName: null,
    agencyAcronym: null,
    requestType: 'Obstruction',
    requestSubtype: 'Merchandise'
  });
  return database;
}

test('duration statistics use an ordinary median and nearest-rank p90', () => {
  assert.deepEqual(durationStatistics([]), {
    sample_size: 0,
    median_seconds: null,
    p90_seconds: null
  });
  assert.deepEqual(durationStatistics([10, 30, 20, 100]), {
    sample_size: 4,
    median_seconds: 25,
    p90_seconds: 100
  });
});

test('returns a stable empty contract when email tables are absent', () => {
  const database = new DatabaseSync(':memory:');
  const result = computeSqliteEmailMetrics(database, {
    now: new Date('2026-07-25T15:00:00.000Z')
  });
  assert.equal(result.database_available, true);
  assert.equal(result.deliveries.all_accepted, 0);
  assert.equal(result.subscriptions.total, 0);
  assert.deepEqual(result.observed_response_times.by_agency, []);
  assert.equal(
    result.observed_response_times.overall.portal_closure.sample_size,
    0
  );
  assert.equal(result.observed_response_times.prospective_cohort.started_at, null);
  database.close();
});

test('counts deliveries, parser issues, subscriptions, and measured closure coverage', () => {
  const database = populatedDatabase();
  const result = computeSqliteEmailMetrics(database, {
    now: new Date('2026-07-25T15:00:00.000Z'),
    closureGraceSeconds: 3600
  });

  assert.deepEqual(result.deliveries, {
    all_accepted: 7,
    usable: 6,
    detail_complete: 6,
    excluded_non_direct: 0,
    submitted: 1,
    updated: 4,
    closed: 2,
    other_or_unknown: 0,
    issues: 1,
    parser_issues: 1,
    reconciliation_issues: 0,
    authentication_issues: 0,
    detail_issues: 0,
    unrecognized_submitted: 1,
    latest_received_at: '2026-07-25T14:00:00.000Z'
  });
  assert.equal(result.subscriptions.total, 6);
  assert.deepEqual(result.subscriptions.states, {
    pending: 1,
    subscribed: 5
  });
  assert.equal(result.subscriptions.confirmed, 5);
  assert.deepEqual(result.subscriptions.lag, {
    sample_size: 5,
    median_seconds: 60,
    p90_seconds: 1200,
    within_early_window: 4,
    early_window_seconds: 900
  });
  assert.deepEqual(result.measured_closure_email_coverage, {
    eligible_portal_closures: 3,
    closed_email_observed: 2,
    missing: 1,
    missing_after_grace: 1,
    mature_eligible_portal_closures: 3,
    mature_closed_email_observed: 2,
    awaiting_within_grace: 0,
    grace_seconds: 3600,
    observed_coverage_percent: 66.7,
    mature_coverage_percent: 66.7,
    limitation: 'Only closures independently present in stored Portal detail can enter this denominator'
  });
  assert.equal(
    result.data_quality.late_subscriptions_excluded_from_response_times,
    1
  );
  database.close();
});

test('closure coverage uses post-subscription email and separates the grace period', () => {
  const database = new DatabaseSync(':memory:');
  createSchema(database);
  insertRequest(database, {
    srnumber: '311-00000021',
    liveSubmitted: '2026-07-25T10:00:00.000Z',
    portalClosed: '2026-07-25T11:00:00.000Z',
    subscribedAt: '2026-07-25T10:01:00.000Z'
  });
  insertRequest(database, {
    srnumber: '311-00000022',
    liveSubmitted: '2026-07-25T10:00:00.000Z',
    portalClosed: '2026-07-25T14:30:00.000Z',
    subscribedAt: '2026-07-25T10:01:00.000Z'
  });
  insertEmail(database, {
    srnumber: '311-00000021',
    kind: 'Closed',
    receivedAt: '2026-07-25T10:00:30.000Z'
  });
  insertEmail(database, {
    srnumber: '311-00000021',
    kind: 'Closed',
    receivedAt: '2026-07-25T11:00:20.000Z'
  });

  const coverage = computeSqliteEmailMetrics(database, {
    now: new Date('2026-07-25T15:00:00.000Z'),
    closureGraceSeconds: 3600
  }).measured_closure_email_coverage;
  assert.equal(coverage.eligible_portal_closures, 2);
  assert.equal(coverage.closed_email_observed, 1);
  assert.equal(coverage.missing, 1);
  assert.equal(coverage.missing_after_grace, 0);
  assert.equal(coverage.awaiting_within_grace, 1);
  assert.equal(coverage.mature_eligible_portal_closures, 1);
  assert.equal(coverage.mature_closed_email_observed, 1);
  assert.equal(coverage.mature_coverage_percent, 100);
  database.close();
});

test('delivery issues are a unique OR of parser and reconciliation failures', () => {
  const database = new DatabaseSync(':memory:');
  createSchema(database);
  insertEmail(database, {
    srnumber: '311-00000011',
    kind: null,
    subject: 'Unexpected message',
    receivedAt: '2026-07-25T10:00:00.000Z',
    parseOutcome: 'unrecognized'
  });
  insertEmail(database, {
    srnumber: null,
    kind: 'Updated',
    subject: 'SR Updated # 311-00000012',
    receivedAt: '2026-07-25T10:01:00.000Z',
    aliasMatchStatus: 'unregistered'
  });
  insertEmail(database, {
    srnumber: null,
    kind: null,
    subject: 'Unexpected message',
    receivedAt: '2026-07-25T10:02:00.000Z',
    parseOutcome: 'unrecognized',
    aliasMatchStatus: 'unregistered'
  });
  const result = computeSqliteEmailMetrics(database, {
    now: new Date('2026-07-25T15:00:00.000Z')
  });
  assert.equal(result.deliveries.parser_issues, 2);
  assert.equal(result.deliveries.reconciliation_issues, 2);
  assert.equal(result.deliveries.issues, 3);
  database.close();
});

test('separates missing parsed details and excludes forwarded attachments from evidence', () => {
  const database = new DatabaseSync(':memory:');
  createSchema(database);
  insertEmail(database, {
    srnumber: '311-00000031',
    kind: 'Updated',
    receivedAt: '2026-07-25T10:00:00.000Z',
    requestType: 'Noise'
  });
  insertEmail(database, {
    srnumber: '311-00000032',
    kind: 'Closed',
    receivedAt: '2026-07-25T10:01:00.000Z',
    agencyAcronym: 'NYPD',
    requestType: 'Noise',
    deliveryMode: 'forwarded-attachment'
  });
  insertEmail(database, {
    srnumber: '311-00000033',
    kind: 'Closed',
    receivedAt: '2026-07-25T10:02:00.000Z',
    agencyAcronym: 'NYPD',
    requestType: 'Noise',
    dmarcVerdict: 'FAIL'
  });
  const deliveries = computeSqliteEmailMetrics(database, {
    now: new Date('2026-07-25T15:00:00.000Z')
  }).deliveries;
  assert.equal(deliveries.all_accepted, 3);
  assert.equal(deliveries.usable, 1);
  assert.equal(deliveries.detail_complete, 0);
  assert.equal(deliveries.detail_issues, 1);
  assert.equal(deliveries.excluded_non_direct, 1);
  assert.equal(deliveries.authentication_issues, 1);
  assert.equal(deliveries.issues, 2);
  database.close();
});

test('keeps first Updated timing distinct from exact Portal closure timing', () => {
  const database = populatedDatabase();
  const result = computeSqliteEmailMetrics(database, {
    now: new Date('2026-07-25T15:00:00.000Z')
  });
  assert.deepEqual(result.observed_response_times.overall, {
    first_updated: {
      sample_size: 2,
      median_seconds: 420,
      p90_seconds: 600
    },
    portal_closure: {
      sample_size: 2,
      median_seconds: 5400,
      p90_seconds: 7200
    },
    closure_notification_delay: {
      sample_size: 2,
      median_seconds: 165,
      p90_seconds: 300
    }
  });
  assert.deepEqual(result.observed_response_times.prospective_cohort, {
    requests: 4,
    started_at: '2026-07-25T10:00:00.000Z',
    early_subscription_seconds: 900,
    right_censored_without_first_updated: 2,
    right_censored_without_observed_portal_closure: 2
  });

  const alpha = result.observed_response_times.by_agency.find(
    row => row.agency_acronym === 'ALPHA'
  );
  const beta = result.observed_response_times.by_agency.find(
    row => row.agency_acronym === 'BETA'
  );
  assert.equal(alpha.first_updated.sample_size, 2);
  assert.equal(alpha.portal_closure.sample_size, 0);
  assert.equal(beta.first_updated.sample_size, 0);
  assert.equal(beta.portal_closure.sample_size, 2);

  const noise = result.observed_response_times.by_complaint_type.find(
    row => row.complaint_type === 'Noise'
  );
  assert.equal(noise.first_updated.sample_size, 2);
  assert.equal(noise.portal_closure.sample_size, 2);
  database.close();
});

test('cohort start is the earliest canonical submission among successful early subscriptions', () => {
  const database = new DatabaseSync(':memory:');
  createSchema(database);
  insertRequest(database, {
    srnumber: '311-00000041',
    liveSubmitted: '2026-07-25T08:00:00.000Z',
    portalSubmitted: '2026-07-25T12:00:00.000Z',
    subscribedAt: '2026-07-25T12:01:00.000Z'
  });
  insertRequest(database, {
    srnumber: '311-00000042',
    liveSubmitted: '2026-07-25T07:00:00-04:00',
    portalSubmitted: '2026-07-25T07:00:00-04:00',
    subscribedAt: '2026-07-25T07:05:00-04:00'
  });
  insertRequest(database, {
    srnumber: '311-00000043',
    liveSubmitted: '2026-07-25T09:00:00.000Z',
    subscribedAt: '2026-07-25T09:20:00.000Z'
  });
  insertRequest(database, {
    srnumber: '311-00000044',
    liveSubmitted: '2026-07-25T07:00:00.000Z',
    state: 'pending',
    subscribedAt: null
  });

  const cohort = computeSqliteEmailMetrics(database, {
    now: new Date('2026-07-25T15:00:00.000Z')
  }).observed_response_times.prospective_cohort;
  assert.equal(cohort.requests, 2);
  assert.equal(cohort.started_at, '2026-07-25T11:00:00.000Z');
  database.close();
});

test('uses Portal date_reported before the live fallback and ignores repeat updates', () => {
  const database = populatedDatabase();
  const result = computeSqliteEmailMetrics(database, {
    now: new Date('2026-07-25T15:00:00.000Z')
  });
  const alpha = result.observed_response_times.by_agency.find(
    row => row.agency_acronym === 'ALPHA'
  );
  assert.deepEqual(alpha.first_updated, {
    sample_size: 2,
    median_seconds: 420,
    p90_seconds: 600
  });
  database.close();
});

test('rejects unzoned canonical timestamps instead of applying host timezone', () => {
  const database = new DatabaseSync(':memory:');
  createSchema(database);
  insertRequest(database, {
    srnumber: '311-00000009',
    liveSubmitted: '2026-07-25T10:00:00',
    portalSubmitted: null,
    subscribedAt: '2026-07-25T10:01:00.000Z'
  });
  insertEmail(database, {
    srnumber: '311-00000009',
    kind: 'Updated',
    receivedAt: '2026-07-25T10:02:00.000Z',
    agencyAcronym: 'TEST',
    requestType: 'Test'
  });
  const result = computeSqliteEmailMetrics(database, {
    now: new Date('2026-07-25T15:00:00.000Z')
  });
  assert.equal(result.subscriptions.lag.sample_size, 0);
  assert.equal(result.data_quality.subscription_rows_invalid_submitted_time, 1);
  assert.equal(result.observed_response_times.overall.first_updated.sample_size, 0);
  database.close();
});

test('can open a database path read-only and reports a missing path safely', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-email-metrics-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const database = new DatabaseSync(databasePath);
  createSchema(database);
  database.close();
  try {
    const result = loadSqliteEmailMetrics(databasePath, {
      now: new Date('2026-07-25T15:00:00.000Z')
    });
    assert.equal(result.database_available, true);
    assert.equal(result.deliveries.all_accepted, 0);

    const missing = loadSqliteEmailMetrics(path.join(directory, 'missing.sqlite'), {
      now: new Date('2026-07-25T15:00:00.000Z')
    });
    assert.equal(missing.database_available, false);
    assert.equal(missing.deliveries.all_accepted, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
