'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { createClosureTracker } = require('../closure-tracking');
const {
  SEED_MISSING_STATUS_HISTORY_SQL,
  seedClosureTracking
} = require('../closure-tracking-seed');

const NOW = new Date('2026-07-30T04:00:00.000Z');

function createDatabase(t, { file = false } = {}) {
  let directory = null;
  let databasePath = ':memory:';
  if (file) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-closure-seed-'));
    databasePath = path.join(directory, 'archive.sqlite');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  }
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY,
      suffix INTEGER UNIQUE,
      portal_id TEXT,
      status TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT
    );
    CREATE TABLE portal_requests (
      srnumber TEXT PRIMARY KEY,
      status TEXT,
      problem TEXT,
      problem_details TEXT,
      additional_details TEXT,
      address TEXT,
      next_update TEXT,
      date_reported TEXT,
      updated_on TEXT,
      date_closed TEXT,
      fields_json TEXT,
      archived_at TEXT
    );
  `);
  const tracker = createClosureTracker(db);
  const updateLiveStatus = db.prepare(
    'UPDATE live_portal_requests SET status=? WHERE srnumber=?'
  );
  return { db, databasePath, tracker, updateLiveStatus };
}

function insertLive(db, suffix, status = 'In Progress') {
  const srnumber = `311-${String(suffix).padStart(8, '0')}`;
  db.prepare(`
    INSERT INTO live_portal_requests (
      srnumber,suffix,portal_id,status,first_seen_at,last_seen_at
    ) VALUES (?,?,?,?,?,?)
  `).run(
    srnumber,
    suffix,
    `portal-${suffix}`,
    status,
    '2026-07-29T12:00:00.000Z',
    '2026-07-30T03:59:00.000Z'
  );
  return srnumber;
}

test('startup seeding inserts only missing history and uses the history index', t => {
  const { db, tracker, updateLiveStatus } = createDatabase(t);
  const tracked = insertLive(db, 1);
  const untracked = insertLive(db, 2);
  const blank = insertLive(db, 3, '  ');
  tracker.observeStatus({
    srnumber: tracked,
    previousStatus: null,
    status: 'In Progress',
    source: 'map',
    observedAt: '2026-07-29T12:00:00.000Z'
  });

  const first = seedClosureTracking({
    db,
    closureTracker: tracker,
    updateLiveStatus,
    now: NOW
  });
  assert.deepEqual(first, {
    statusRows: 1,
    followUpsSeeded: 0,
    provisionalFollowUpsSeeded: 2
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM request_status_history WHERE srnumber=?
  `).get(tracked).count, 1);
  assert.deepEqual({
    ...db.prepare(`
      SELECT status,source,observed_at
      FROM request_status_history WHERE srnumber=?
    `).get(untracked)
  }, {
    status: 'In Progress',
    source: 'migration',
    observed_at: '2026-07-29T12:00:00.000Z'
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM request_status_history WHERE srnumber=?
  `).get(blank).count, 0);

  assert.deepEqual(seedClosureTracking({
    db,
    closureTracker: tracker,
    updateLiveStatus,
    now: new Date(NOW.getTime() + 1000)
  }), {
    statusRows: 0,
    followUpsSeeded: 0,
    provisionalFollowUpsSeeded: 0
  });

  const plan = db.prepare(
    `EXPLAIN QUERY PLAN ${SEED_MISSING_STATUS_HISTORY_SQL}`
  ).all(NOW.toISOString());
  assert.equal(plan.some(row => (
    row.detail.includes('request_status_history_request_idx')
    && row.detail.includes('(srnumber=?)')
  )), true, plan.map(row => row.detail).join('\n'));
});

test('stored details without follow-up survive seeding under an immediate write lock', t => {
  const {
    db,
    databasePath,
    tracker,
    updateLiveStatus
  } = createDatabase(t, { file: true });
  const srnumber = insertLive(db, 4);
  tracker.observeStatus({
    srnumber,
    previousStatus: null,
    status: 'In Progress',
    source: 'map',
    observedAt: '2026-07-29T12:00:00.000Z'
  });
  db.prepare(`
    INSERT INTO portal_requests (
      srnumber,status,problem,problem_details,additional_details,address,next_update,
      date_reported,updated_on,date_closed,fields_json,archived_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    srnumber,
    'Closed',
    'Illegal Parking',
    'Blocked Hydrant',
    null,
    '1 CENTRE STREET, NEW YORK, NY, 10007',
    null,
    '2026-07-29T12:00:00.000Z',
    '2026-07-30T03:00:00.000Z',
    '2026-07-30T03:00:00.000Z',
    '{"Problem Details":"Blocked Hydrant"}',
    '2026-07-30T03:01:00.000Z'
  );

  const competitor = new DatabaseSync(databasePath);
  t.after(() => competitor.close());
  competitor.exec('PRAGMA busy_timeout=0');
  let competingWriteError = null;
  const observingTracker = {
    ...tracker,
    scheduleAfterDetail(input) {
      try {
        competitor.prepare(`
          INSERT INTO request_status_history (
            srnumber,previous_status,status,source,effective_at,observed_at,snapshot_json
          ) VALUES (?,NULL,'In Progress','test',NULL,?,NULL)
        `).run('311-99999999', NOW.toISOString());
      } catch (error) {
        competingWriteError = error;
      }
      return tracker.scheduleAfterDetail(input);
    }
  };

  assert.deepEqual(seedClosureTracking({
    db,
    closureTracker: observingTracker,
    updateLiveStatus,
    now: NOW
  }), {
    statusRows: 0,
    followUpsSeeded: 1,
    provisionalFollowUpsSeeded: 0
  });
  assert.match(String(competingWriteError && competingWriteError.message), /database is locked/i);
  assert.equal(
    db.prepare('SELECT status FROM live_portal_requests WHERE srnumber=?').get(srnumber).status,
    'Closed'
  );
  assert.equal(tracker.getFollowUp.get(srnumber).state, 'closed');
  assert.deepEqual(db.prepare(`
    SELECT source,status FROM request_status_history WHERE srnumber=? ORDER BY id
  `).all(srnumber).map(row => ({ ...row })), [
    { source: 'map', status: 'In Progress' },
    { source: 'stored_detail', status: 'Closed' }
  ]);
});
