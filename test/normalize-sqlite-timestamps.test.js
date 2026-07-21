'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  TimestampRepairError,
  parseArguments,
  repairSqliteTimestamps
} = require('../normalize-sqlite-timestamps');

function fixture(t, { invalid = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc-311-timestamp-repair-'));
  const databasePath = path.join(directory, 'portal-archive.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY,
      submitted_at TEXT
    );
    CREATE TABLE portal_requests (
      srnumber TEXT PRIMARY KEY,
      date_reported TEXT,
      updated_on TEXT,
      date_closed TEXT
    );
    CREATE TABLE request_status_history (
      id INTEGER PRIMARY KEY,
      effective_at TEXT
    );
    CREATE TABLE request_closure_snapshots (
      id INTEGER PRIMARY KEY,
      date_closed TEXT
    );

    INSERT INTO live_portal_requests VALUES
      ('311-00000001', '7/20/2026 8:43:46 PM'),
      ('311-00000002', '2026-07-20T20:43:46.000Z'),
      ('311-00000003', NULL),
      ('311-00000004', '');

    INSERT INTO portal_requests VALUES (
      '311-00000001',
      '7/20/2026 12:00:00 AM',
      ${invalid ? "'not a portal timestamp'" : "'2026-07-20T20:43:46-04:00'"},
      '7/21/2026 12:00:00 PM'
    );
    INSERT INTO request_status_history VALUES
      (1, '7/21/2026 1:02:03 AM'),
      (2, NULL);
    INSERT INTO request_closure_snapshots VALUES
      (1, '2026-07-21T08:00:00+02:00'),
      (2, '');
  `);
  database.close();
  return databasePath;
}

function readValues(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      submitted: database.prepare(`
        SELECT submitted_at FROM live_portal_requests ORDER BY srnumber
      `).all().map(row => row.submitted_at),
      portal: { ...database.prepare(`
        SELECT date_reported, updated_on, date_closed FROM portal_requests
      `).get() },
      history: database.prepare(`
        SELECT effective_at FROM request_status_history ORDER BY id
      `).all().map(row => row.effective_at),
      closures: database.prepare(`
        SELECT date_closed FROM request_closure_snapshots ORDER BY id
      `).all().map(row => row.date_closed)
    };
  } finally {
    database.close();
  }
}

test('CLI parsing keeps dry-run as the default and rejects conflicting modes', () => {
  const parsed = parseArguments(['/tmp/example.sqlite']);
  assert.equal(parsed.apply, false);
  assert.throws(
    () => parseArguments(['/tmp/example.sqlite', '--dry-run', '--apply']),
    /either --dry-run or --apply/
  );
});

test('dry-run reports planned changes and preserves the source database', t => {
  const databasePath = fixture(t);
  const before = readValues(databasePath);
  const report = repairSqliteTimestamps({ databasePath });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.status, 'dry-run');
  assert.equal(report.can_apply, true);
  assert.equal(report.summary.planned_changes, 6);
  assert.equal(report.summary.applied_changes, 0);
  assert.equal(report.summary.invalid_values, 0);
  assert.equal(report.row_counts.unchanged, true);
  assert.deepEqual(readValues(databasePath), before);
});

test('apply repairs every target atomically and a second run is idempotent', t => {
  const databasePath = fixture(t);
  const report = repairSqliteTimestamps({ databasePath, apply: true });

  assert.equal(report.status, 'applied');
  assert.equal(report.summary.planned_changes, 6);
  assert.equal(report.summary.applied_changes, 6);
  assert.equal(report.row_counts.unchanged, true);
  assert.deepEqual(report.quick_check.after, { ok: true, messages: ['ok'] });
  assert.deepEqual(report.post_inspection, { planned_changes: 0, invalid_values: 0 });
  assert.deepEqual(readValues(databasePath), {
    submitted: [
      '2026-07-20T20:43:46.000Z',
      '2026-07-20T20:43:46.000Z',
      null,
      ''
    ],
    portal: {
      date_reported: '2026-07-20T00:00:00.000Z',
      updated_on: '2026-07-21T00:43:46.000Z',
      date_closed: '2026-07-21T12:00:00.000Z'
    },
    history: ['2026-07-21T01:02:03.000Z', null],
    closures: ['2026-07-21T06:00:00.000Z', '']
  });

  const second = repairSqliteTimestamps({ databasePath, apply: true });
  assert.equal(second.status, 'applied');
  assert.equal(second.summary.planned_changes, 0);
  assert.equal(second.summary.applied_changes, 0);
  assert.deepEqual(second.post_inspection, { planned_changes: 0, invalid_values: 0 });
});

test('apply reports invalid nonempty values and rolls back valid planned changes', t => {
  const databasePath = fixture(t, { invalid: true });
  const before = readValues(databasePath);
  let failure;
  try {
    repairSqliteTimestamps({ databasePath, apply: true });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof TimestampRepairError);
  assert.match(failure.message, /invalid nonempty timestamp/);
  assert.equal(failure.report.status, 'aborted');
  assert.equal(failure.report.summary.invalid_values, 1);
  assert.equal(failure.report.summary.applied_changes, 0);
  assert.deepEqual(failure.report.invalid_values, [{
    table: 'portal_requests',
    column: 'updated_on',
    rowid: 1,
    value: 'not a portal timestamp'
  }]);
  assert.deepEqual(readValues(databasePath), before);
});

test('missing tables and columns are skipped while available targets are repaired', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc-311-timestamp-partial-'));
  const databasePath = path.join(directory, 'partial.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE portal_requests (
      srnumber TEXT PRIMARY KEY,
      date_reported TEXT
    );
    INSERT INTO portal_requests VALUES ('311-00000001', '7/21/2026 3:04:05 PM');
  `);
  database.close();

  const report = repairSqliteTimestamps({ databasePath, apply: true });
  assert.equal(report.summary.applied_changes, 1);
  assert.equal(report.summary.skipped_targets, 5);
  assert.deepEqual(
    report.skipped_targets.map(target => target.reason),
    ['missing_table', 'missing_column', 'missing_column', 'missing_table', 'missing_table']
  );
  const verified = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    verified.prepare('SELECT date_reported FROM portal_requests').get().date_reported,
    '2026-07-21T15:04:05.000Z'
  );
  verified.close();
});
