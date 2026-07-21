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
