'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  loadOperationalHealth,
  overallStatus
} = require('../operational-health');

const NOW = new Date('2026-07-29T12:00:00.000Z');

function createHealthDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-operational-health-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE live_monitor_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE live_detail_queue (
      srnumber TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX live_detail_queue_status_idx
      ON live_detail_queue(status,next_attempt_at);
    CREATE TABLE nyc311_email_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciled_srnumber TEXT,
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      parse_outcome TEXT NOT NULL,
      alias_match_status TEXT NOT NULL
    );
    CREATE TABLE nyc311_email_subscription_jobs (
      srnumber TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      bid_id INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX nyc311_email_subscription_jobs_due_idx
      ON nyc311_email_subscription_jobs(state,next_attempt_at,bid_id);
    CREATE TABLE request_followup_queue (
      srnumber TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_check_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX request_followup_queue_due_idx
      ON request_followup_queue(state,next_check_at);
  `);
  return { database, databasePath };
}

function seedFreshCollector(database) {
  const insert = database.prepare(`
    INSERT INTO live_monitor_state(key,value,updated_at) VALUES (?,?,?)
  `);
  insert.run(
    'last_successful_poll_at',
    '2026-07-29T11:59:45.000Z',
    '2026-07-29T11:59:45.000Z'
  );
  insert.run(
    'poll_interval_seconds',
    '15',
    '2026-07-29T11:59:45.000Z'
  );
}

test('returns a lightweight healthy snapshot with safe queue descriptors', () => {
  const { database, databasePath } = createHealthDatabase();
  seedFreshCollector(database);
  database.prepare(`
    INSERT INTO live_detail_queue VALUES (?,?,?,?,?,?)
  `).run(
    '311-00000001',
    'pending',
    0,
    '2026-07-29T12:00:30.000Z',
    null,
    '2026-07-29T11:59:50.000Z'
  );
  database.prepare(`
    INSERT INTO nyc311_email_events(
      reconciled_srnumber,received_at,created_at,parse_outcome,alias_match_status
    ) VALUES (NULL,?,?,?,?)
  `).run(
    '2026-07-29T11:58:00.000Z',
    '2026-07-29T11:58:00.000Z',
    'parsed',
    'matched'
  );
  database.prepare(`
    INSERT INTO nyc311_email_subscription_jobs VALUES (?,?,?,?,?,?,?)
  `).run(
    '311-00000001',
    'pending',
    0,
    '2026-07-29T12:00:20.000Z',
    null,
    '2026-07-29T11:59:55.000Z',
    0
  );
  database.prepare(`
    INSERT INTO request_followup_queue VALUES (?,?,?,?,?,?)
  `).run(
    '311-00000001',
    'closing',
    1,
    '2026-07-29T12:01:00.000Z',
    null,
    '2026-07-29T11:59:30.000Z'
  );
  database.close();

  const result = loadOperationalHealth(databasePath, {
    now: NOW,
    analyticsSnapshot: {
      statusCode: 200,
      payload: {
        metrics_generated_at: '2026-07-29T11:57:00.000Z',
        metrics_refreshing: false,
        metrics_stale: false
      }
    }
  });

  assert.equal(result.version, 1);
  assert.equal(result.generated_at, NOW.toISOString());
  assert.equal(result.status, 'healthy');
  assert.equal(result.components.database.status, 'healthy');
  assert.ok(result.components.database.file_size_bytes > 0);
  assert.equal(result.components.map_discovery.reason, 'poll_fresh');
  assert.equal(result.components.map_discovery.poll_age_seconds, 15);
  assert.equal(result.components.details.next.due, 'scheduled');
  assert.equal(result.components.details.next.due_in_seconds, 30);
  assert.equal(result.components.email_intake.latest_event.id, 1);
  assert.equal(result.components.email_intake.latest_event.age_seconds, 120);
  assert.equal(result.components.subscriptions.next.state, 'pending');
  assert.equal(result.components.closure_verification.next.state, 'closing');
  assert.equal(result.components.analytics.status, 'healthy');
});

test('BID-only health ignores retained citywide email and subscription rows', () => {
  const { database, databasePath } = createHealthDatabase();
  database.exec(`
    CREATE TABLE business_improvement_district_boundary_versions (
      version TEXT PRIMARY KEY,
      active INTEGER NOT NULL
    );
    CREATE TABLE live_request_bid_memberships (
      srnumber TEXT NOT NULL,
      boundary_version TEXT NOT NULL,
      bid_id INTEGER NOT NULL
    );
    INSERT INTO business_improvement_district_boundary_versions VALUES ('bids-v1',1);
    INSERT INTO live_request_bid_memberships VALUES ('311-00000011','bids-v1',1);
    INSERT INTO live_monitor_state VALUES (
      'collector_scope','bid_only','2026-07-29T11:59:45.000Z'
    );
    INSERT INTO live_monitor_state VALUES (
      'last_successful_poll_at','2026-07-29T11:59:45.000Z','2026-07-29T11:59:45.000Z'
    );
    INSERT INTO live_monitor_state VALUES (
      'bid_poll_interval_seconds','60','2026-07-29T11:59:45.000Z'
    );
  `);
  const insertEvent = database.prepare(`
    INSERT INTO nyc311_email_events(
      reconciled_srnumber,received_at,created_at,parse_outcome,alias_match_status
    ) VALUES (?,?,?,?,?)
  `);
  insertEvent.run(
    '311-00000011',
    '2026-07-29T11:58:00.000Z',
    '2026-07-29T11:58:00.000Z',
    'parsed',
    'matched'
  );
  insertEvent.run(
    '311-00000012',
    '2026-07-29T11:59:59.000Z',
    '2026-07-29T11:59:59.000Z',
    'unrecognized',
    'unregistered'
  );
  database.prepare(`
    INSERT INTO nyc311_email_subscription_jobs VALUES (?,?,?,?,?,?,?)
  `).run(
    '311-00000011', 'pending', 0, '2026-07-29T12:01:00.000Z',
    null, '2026-07-29T11:59:00.000Z', 0
  );
  database.prepare(`
    INSERT INTO nyc311_email_subscription_jobs VALUES (?,?,?,?,?,?,?)
  `).run(
    '311-00000012', 'error', 9, '2026-07-29T11:00:00.000Z',
    'retained citywide failure', '2026-07-29T11:00:00.000Z', 0
  );
  database.close();

  const result = loadOperationalHealth(databasePath, { now: NOW });
  assert.equal(result.components.map_discovery.collector_scope, 'bid_only');
  assert.equal(result.components.email_intake.latest_event.id, 1);
  assert.equal(result.components.email_intake.status, 'healthy');
  assert.equal(result.components.subscriptions.next.state, 'pending');
  assert.notEqual(result.components.subscriptions.reason, 'work_failed');
});

test('classifies overdue work and a stale collector without scanning queue totals', () => {
  const { database, databasePath } = createHealthDatabase();
  const insertState = database.prepare(`
    INSERT INTO live_monitor_state(key,value,updated_at) VALUES (?,?,?)
  `);
  insertState.run(
    'last_successful_poll_at',
    '2026-07-29T11:57:30.000Z',
    '2026-07-29T11:57:30.000Z'
  );
  insertState.run('poll_interval_seconds', '15', '2026-07-29T11:57:30.000Z');
  database.prepare(`
    INSERT INTO live_detail_queue VALUES (?,?,?,?,?,?)
  `).run(
    '311-00000002',
    'retry',
    2,
    '2026-07-29T11:58:00.000Z',
    'sensitive upstream response',
    '2026-07-29T11:58:00.000Z'
  );
  database.close();

  const result = loadOperationalHealth(databasePath, { now: NOW });

  assert.equal(result.status, 'delayed');
  assert.equal(result.components.map_discovery.status, 'delayed');
  assert.equal(result.components.details.status, 'delayed');
  assert.equal(result.components.details.next.due, 'overdue');
  assert.equal(result.components.details.next.overdue_seconds, 120);
  assert.equal(result.components.details.next.has_error, true);
  assert.doesNotMatch(JSON.stringify(result), /sensitive upstream response/);
  assert.equal(result.components.email_intake.status, 'quiet');
  assert.equal(result.components.subscriptions.status, 'quiet');
  assert.equal(result.components.closure_verification.status, 'quiet');
});

test('surfaces failed and stalled queue lanes as attention without exposing errors', () => {
  const { database, databasePath } = createHealthDatabase();
  seedFreshCollector(database);
  database.prepare(`
    INSERT INTO nyc311_email_subscription_jobs VALUES (?,?,?,?,?,?,?)
  `).run(
    '311-00000003',
    'error',
    7,
    '2026-07-29T12:10:00.000Z',
    'secret subscription failure',
    '2026-07-29T11:59:00.000Z',
    0
  );
  database.prepare(`
    INSERT INTO nyc311_email_subscription_jobs VALUES (?,?,?,?,?,?,?)
  `).run(
    '311-00000005',
    'pending',
    0,
    '2026-07-29T11:00:00.000Z',
    null,
    '2026-07-29T11:00:00.000Z',
    0
  );
  database.prepare(`
    INSERT INTO request_followup_queue VALUES (?,?,?,?,?,?)
  `).run(
    '311-00000004',
    'closing',
    4,
    '2026-07-29T11:30:00.000Z',
    'secret portal failure',
    '2026-07-29T11:30:00.000Z'
  );
  database.prepare(`
    INSERT INTO nyc311_email_events(
      reconciled_srnumber,received_at,created_at,parse_outcome,alias_match_status
    ) VALUES (NULL,?,?,?,?)
  `).run(
    '2026-07-29T11:59:00.000Z',
    '2026-07-29T11:59:00.000Z',
    'unrecognized',
    'unregistered'
  );
  database.close();

  const result = loadOperationalHealth(databasePath, { now: NOW });
  const serialized = JSON.stringify(result);

  assert.equal(result.status, 'attention');
  assert.equal(result.components.subscriptions.status, 'attention');
  assert.equal(result.components.subscriptions.reason, 'work_failed');
  assert.equal(result.components.subscriptions.next.state, 'error');
  assert.equal(result.components.closure_verification.status, 'attention');
  assert.equal(result.components.closure_verification.reason, 'work_stalled');
  assert.equal(result.components.email_intake.status, 'attention');
  assert.equal(result.components.email_intake.reason, 'latest_event_needs_review');
  assert.doesNotMatch(serialized, /secret subscription failure|secret portal failure/);
  assert.equal(serialized.includes('last_error'), false);
});

test('a future Portal 5xx quarantine is quiet but becomes active when due', () => {
  const { database, databasePath } = createHealthDatabase();
  seedFreshCollector(database);
  database.prepare(`
    INSERT INTO nyc311_email_subscription_jobs VALUES (?,?,?,?,?,?,?)
  `).run(
    '311-00000006',
    'retry',
    15,
    '2026-07-31T12:00:00.000Z',
    'NYC311 subscription submit returned HTTP 500',
    '2026-07-29T12:00:00.000Z',
    0
  );
  database.close();

  const quarantined = loadOperationalHealth(databasePath, { now: NOW });
  assert.equal(quarantined.components.subscriptions.status, 'quiet');
  assert.equal(
    quarantined.components.subscriptions.reason,
    'portal_failure_quarantined'
  );
  assert.equal(quarantined.components.subscriptions.next.quarantined, true);
  assert.equal(quarantined.components.subscriptions.next.attempts, 15);

  const due = loadOperationalHealth(databasePath, {
    now: new Date('2026-07-31T12:20:00.000Z')
  });
  assert.equal(due.components.subscriptions.status, 'attention');
  assert.equal(due.components.subscriptions.reason, 'work_stalled');
});

test('reports a missing database with the same stable component contract', () => {
  const databasePath = path.join(
    os.tmpdir(),
    `nyc311-operational-health-missing-${process.pid}-${Date.now()}.sqlite`
  );
  const result = loadOperationalHealth(databasePath, {
    now: NOW,
    analyticsSnapshot: { status: 'quiet' }
  });

  assert.equal(result.status, 'attention');
  assert.deepEqual(Object.keys(result.components), [
    'database',
    'map_discovery',
    'details',
    'email_intake',
    'subscriptions',
    'closure_verification',
    'analytics'
  ]);
  assert.equal(result.components.database.reason, 'database_missing');
  assert.equal(result.components.map_discovery.reason, 'database_unavailable');
  assert.equal(result.components.analytics.status, 'quiet');
});

test('sanitizes analytics worker state instead of returning its error text', () => {
  const { database, databasePath } = createHealthDatabase();
  seedFreshCollector(database);
  database.close();

  const result = loadOperationalHealth(databasePath, {
    now: NOW,
    analyticsSnapshot: {
      statusCode: 200,
      payload: {
        metrics_generated_at: '2026-07-29T10:00:00.000Z',
        metrics_refreshing: false,
        metrics_stale: true,
        metrics_refresh_error: 'database or disk is full'
      }
    }
  });

  assert.equal(result.status, 'delayed');
  assert.deepEqual(result.components.analytics, {
    status: 'delayed',
    reason: 'snapshot_refreshing',
    available: true,
    generated_at: '2026-07-29T10:00:00.000Z',
    age_seconds: 7200,
    refreshing: false,
    stale: true
  });
  assert.doesNotMatch(JSON.stringify(result), /database or disk is full/);
});

test('the overall state uses attention, delayed, healthy, quiet precedence', () => {
  assert.equal(overallStatus({
    one: { status: 'healthy' },
    two: { status: 'quiet' }
  }), 'healthy');
  assert.equal(overallStatus({
    one: { status: 'healthy' },
    two: { status: 'delayed' }
  }), 'delayed');
  assert.equal(overallStatus({
    one: { status: 'delayed' },
    two: { status: 'attention' }
  }), 'attention');
  assert.equal(overallStatus({
    one: { status: 'quiet' },
    two: { status: 'quiet' }
  }), 'quiet');
});

test('health reads stay bounded and avoid full-table diagnostics', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'operational-health.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /\bCOUNT\s*\(/i);
  assert.doesNotMatch(source, /sqlite_master/i);
  assert.doesNotMatch(source, /quick_check/i);
  assert.match(source, /WHERE key=\?/);
  assert.match(source, /ORDER BY id DESC\s+LIMIT 1/);
  assert.match(source, /WHERE \$\{stateColumn\}=\?/);
  assert.match(source, /ORDER BY \$\{dueColumn\}\s+LIMIT 1/);
});
