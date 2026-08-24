'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { inspectSqliteHealth } = require('../sqlite-health');

test('reports a missing archive as starting and unavailable', () => {
  const missing = path.join(os.tmpdir(), `nyc311-missing-${process.pid}.sqlite`);
  const health = inspectSqliteHealth(missing);
  assert.equal(health.ok, false);
  assert.equal(health.status, 'starting');
  assert.equal(health.database, 'missing');
});

test('reports database access separately from collector freshness', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-health-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE live_monitor_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  database.prepare(`
    INSERT INTO live_monitor_state (key, value, updated_at)
    VALUES ('last_successful_poll_at', ?, ?)
  `).run('2026-07-21T12:00:00.000Z', '2026-07-21T12:00:00.000Z');
  database.close();

  const fresh = inspectSqliteHealth(databasePath, {
    now: new Date('2026-07-21T12:01:00.000Z')
  });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.status, 'ok');
  assert.equal(fresh.collector, 'fresh');
  assert.equal(fresh.collector_scope, 'bid_only');
  assert.equal(fresh.poll_age_seconds, 60);

  const stale = inspectSqliteHealth(databasePath, {
    now: new Date('2026-07-21T12:10:00.000Z')
  });
  assert.equal(stale.ok, true);
  assert.equal(stale.status, 'degraded');
  assert.equal(stale.collector, 'stale');
});

test('allows at most sixty seconds of collector clock skew', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-health-skew-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE live_monitor_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  database.prepare(`
    INSERT INTO live_monitor_state (key, value, updated_at)
    VALUES ('last_successful_poll_at', ?, ?)
  `).run('2026-07-21T12:01:00.000Z', '2026-07-21T12:01:00.000Z');
  database.close();

  const health = inspectSqliteHealth(databasePath, {
    now: new Date('2026-07-21T12:00:00.000Z')
  });
  assert.equal(health.ok, true);
  assert.equal(health.status, 'ok');
  assert.equal(health.collector, 'fresh');
  assert.equal(health.poll_age_seconds, 0);
});

test('rejects a collector timestamp more than sixty seconds in the future', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-health-future-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE live_monitor_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  database.prepare(`
    INSERT INTO live_monitor_state (key, value, updated_at)
    VALUES ('last_successful_poll_at', ?, ?)
  `).run('2026-07-21T12:01:01.000Z', '2026-07-21T12:01:01.000Z');
  database.close();

  const health = inspectSqliteHealth(databasePath, {
    now: new Date('2026-07-21T12:00:00.000Z')
  });
  assert.equal(health.ok, true);
  assert.equal(health.status, 'degraded');
  assert.equal(health.collector, 'invalid');
  assert.equal(health.poll_age_seconds, null);
});

test('BID collector readiness requires complete boundaries and a healthy current zone plan', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-health-bid-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE live_monitor_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE business_improvement_district_boundary_versions (
      version TEXT PRIMARY KEY,
      feature_count INTEGER NOT NULL,
      active INTEGER NOT NULL
    );
    CREATE TABLE business_improvement_districts (
      boundary_version TEXT NOT NULL,
      bid_id INTEGER NOT NULL
    );
    CREATE TABLE bid_collector_zone_state (
      plan_hash TEXT NOT NULL,
      zone_id TEXT NOT NULL,
      last_error TEXT
    );
    INSERT INTO business_improvement_district_boundary_versions
      VALUES ('2026-04-28',78,1);
    INSERT INTO bid_collector_zone_state VALUES ('plan-1','zone-1',NULL);
  `);
  const insertState = database.prepare(`
    INSERT INTO live_monitor_state(key,value,updated_at) VALUES (?,?,?)
  `);
  const observedAt = '2026-07-21T12:00:00.000Z';
  insertState.run('collector_scope', 'bid_only', observedAt);
  insertState.run('last_successful_poll_at', observedAt, observedAt);
  insertState.run('bid_query_plan_hash', 'plan-1', observedAt);
  insertState.run('bid_query_zone_count', '1', observedAt);
  const insertDistrict = database.prepare(`
    INSERT INTO business_improvement_districts(boundary_version,bid_id)
    VALUES ('2026-04-28',?)
  `);
  for (let bidId = 1; bidId <= 78; bidId += 1) insertDistrict.run(bidId);
  database.close();

  const ready = inspectSqliteHealth(databasePath, {
    now: new Date('2026-07-21T12:01:00.000Z')
  });
  assert.equal(ready.collector, 'fresh');
  assert.equal(ready.collector_scope_integrity, 'ready');

  const failed = new DatabaseSync(databasePath);
  failed.prepare(`
    INSERT INTO live_monitor_state(key,value,updated_at) VALUES (?,?,?)
  `).run('bid_collector_last_attempt_at', '2026-07-21T12:09:30.000Z', observedAt);
  failed.prepare(`
    INSERT INTO live_monitor_state(key,value,updated_at) VALUES (?,?,?)
  `).run('bid_collector_catching_up_zones', '1', observedAt);
  const recovering = inspectSqliteHealth(databasePath, {
    now: new Date('2026-07-21T12:10:00.000Z')
  });
  assert.equal(recovering.collector, 'fresh');
  assert.equal(recovering.last_successful_poll_at, observedAt);
  assert.equal(recovering.last_attempt_at, '2026-07-21T12:09:30.000Z');
  assert.equal(recovering.collector_scope_integrity, 'zone_catching_up');
  failed.prepare(`
    INSERT INTO live_monitor_state(key,value,updated_at) VALUES (?,?,?)
  `).run('bid_collector_startup_error', 'private failure detail', observedAt);
  failed.close();
  assert.equal(inspectSqliteHealth(databasePath, {
    now: new Date('2026-07-21T12:01:00.000Z')
  }).collector_scope_integrity, 'startup_failed');
});
