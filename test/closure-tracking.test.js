'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  createClosureTracker,
  isClosedStatus,
  statusesMatch
} = require('../closure-tracking');

const SR_NUMBER = '311-12345678';
const PORTAL_ID = '11111111-2222-3333-4444-555555555555';

function harness(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return { db, tracker: createClosureTracker(db) };
}

function detail(overrides = {}) {
  return {
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    status: 'Closed',
    problem: 'Illegal Parking',
    problemDetails: 'Blocked Hydrant',
    additionalDetails: null,
    address: '1 CENTRE STREET, NEW YORK, NY, 10007',
    nextUpdate: '2 hours',
    dateReported: '2026-07-20T12:00:00Z',
    updatedOn: '2026-07-20T13:00:00Z',
    dateClosed: null,
    fields: { 'Problem Details': 'Blocked Hydrant' },
    ...overrides
  };
}

function queueClosure(tracker, observedAt = '2026-07-20T13:30:00.000Z') {
  return tracker.queueMapStatusChange({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    previousStatus: 'In Progress',
    status: 'Closed',
    observedAt
  });
}

test('status history deduplicates normalized statuses and records open-close-reopen', t => {
  const { db, tracker } = harness(t);
  const firstSeen = '2026-07-20T12:00:00.000Z';

  assert.equal(tracker.observeStatus({
    srnumber: SR_NUMBER,
    previousStatus: null,
    status: 'In Progress',
    source: 'map',
    observedAt: firstSeen
  }), true);
  assert.equal(tracker.observeStatus({
    srnumber: SR_NUMBER,
    previousStatus: null,
    status: '  in   progress  ',
    source: 'detail',
    observedAt: '2026-07-20T12:01:00.000Z'
  }), false);
  assert.equal(tracker.observeStatus({
    srnumber: SR_NUMBER,
    previousStatus: null,
    status: 'Closed',
    source: 'map',
    effectiveAt: '2026-07-20T12:30:00.000Z',
    observedAt: '2026-07-20T12:31:00.000Z'
  }), true);
  assert.equal(tracker.observeStatus({
    srnumber: SR_NUMBER,
    previousStatus: null,
    status: 'In Progress',
    source: 'map',
    observedAt: '2026-07-20T12:45:00.000Z'
  }), true);

  const rows = db.prepare(`
    SELECT previous_status, status, source, effective_at
    FROM request_status_history ORDER BY id
  `).all().map(row => ({ ...row }));
  assert.deepEqual(rows, [
    {
      previous_status: null,
      status: 'In Progress',
      source: 'map',
      effective_at: null
    },
    {
      previous_status: 'In Progress',
      status: 'Closed',
      source: 'map',
      effective_at: '2026-07-20T12:30:00.000Z'
    },
    {
      previous_status: 'Closed',
      status: 'In Progress',
      source: 'map',
      effective_at: null
    }
  ]);
  assert.equal(statusesMatch(' RESOLVED ', 'resolved'), true);
  assert.equal(isClosedStatus('Request was cancelled'), true);
});

test('a newly captured open map request is monitored immediately before details load', t => {
  const { tracker } = harness(t);
  const observedAt = '2026-07-20T12:00:00.000Z';

  assert.equal(tracker.queueMapStatusChange({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    previousStatus: null,
    status: 'In Progress',
    observedAt
  }), true);

  const row = tracker.getFollowUp.get(SR_NUMBER);
  assert.equal(row.state, 'open');
  assert.equal(row.next_check_at, '2026-07-21T12:00:00.000Z');
  assert.equal(row.last_checked_at, null);
  assert.equal(row.last_success_at, null);
  assert.equal(tracker.normalizeOpenFollowUps(new Date('2026-07-20T12:05:00.000Z')), 0);
  assert.equal(tracker.getFollowUp.get(SR_NUMBER).last_success_at, null);
});

test('map close observations do not reset an active closure attempt, and reopen starts the next cycle', t => {
  const { tracker } = harness(t);
  const closedAt = '2026-07-20T13:30:00.000Z';
  assert.equal(queueClosure(tracker, closedAt), true);

  const firstAttemptAt = '2026-07-20T13:31:00.000Z';
  tracker.scheduleAfterDetail({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    effectiveStatus: 'Closed',
    detail: detail(),
    source: 'closure_followup',
    checkedAt: firstAttemptAt
  });
  const beforeRepeat = tracker.getFollowUp.get(SR_NUMBER);
  assert.equal(beforeRepeat.state, 'closing');
  assert.equal(beforeRepeat.closing_attempts, 1);
  assert.equal(beforeRepeat.closure_cycle, 1);

  assert.equal(tracker.queueMapStatusChange({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    previousStatus: 'Closed',
    status: ' closed ',
    observedAt: '2026-07-20T13:32:00.000Z'
  }), false);
  assert.deepEqual(tracker.getFollowUp.get(SR_NUMBER), beforeRepeat);

  assert.equal(tracker.queueMapStatusChange({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    previousStatus: 'Closed',
    status: 'Resolved',
    observedAt: '2026-07-20T13:33:00.000Z'
  }), false);
  assert.deepEqual(tracker.getFollowUp.get(SR_NUMBER), beforeRepeat);

  assert.equal(tracker.queueMapStatusChange({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    previousStatus: 'Closed',
    status: 'In Progress',
    observedAt: '2026-07-20T14:00:00.000Z'
  }), true);
  let row = tracker.getFollowUp.get(SR_NUMBER);
  assert.equal(row.state, 'open');
  assert.equal(row.closure_cycle, 1);
  assert.equal(row.closing_attempts, 0);

  assert.equal(tracker.queueMapStatusChange({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    previousStatus: 'In Progress',
    status: 'Resolved',
    observedAt: '2026-07-20T15:00:00.000Z'
  }), true);
  row = tracker.getFollowUp.get(SR_NUMBER);
  assert.equal(row.state, 'closing');
  assert.equal(row.closure_cycle, 2);
  assert.equal(row.closing_attempts, 0);
});

test('closure retries use 15-minute, 2-hour, and 24-hour delays before a date-missing final snapshot', t => {
  const { db, tracker } = harness(t);
  queueClosure(tracker);
  const checkedAt = [
    '2026-07-20T14:00:00.000Z',
    '2026-07-20T15:00:00.000Z',
    '2026-07-20T18:00:00.000Z',
    '2026-07-21T19:00:00.000Z'
  ];
  const expectedNext = [
    '2026-07-20T14:15:00.000Z',
    '2026-07-20T17:00:00.000Z',
    '2026-07-21T18:00:00.000Z'
  ];

  for (let index = 0; index < checkedAt.length; index += 1) {
    const result = tracker.scheduleAfterDetail({
      srnumber: SR_NUMBER,
      portalId: PORTAL_ID,
      effectiveStatus: 'Closed',
      detail: detail(),
      source: 'closure_followup',
      checkedAt: checkedAt[index]
    });
    const row = tracker.getFollowUp.get(SR_NUMBER);
    assert.equal(row.closing_attempts, index + 1);
    if (index < 3) {
      assert.deepEqual(result, {
        state: 'closing',
        finalized: false,
        snapshotAdded: index === 0
      });
      assert.equal(row.next_check_at, expectedNext[index]);
      assert.equal(row.finalized_at, null);
    } else {
      assert.deepEqual(result, {
        state: 'closed',
        finalized: true,
        snapshotAdded: true
      });
      assert.equal(row.next_check_at, null);
      assert.equal(row.finalized_at, checkedAt[index]);
    }
  }

  const snapshots = db.prepare(`
    SELECT closure_cycle, date_closed, is_final, final_state
    FROM request_closure_snapshots ORDER BY id
  `).all().map(row => ({ ...row }));
  assert.deepEqual(snapshots, [
    {
      closure_cycle: 1,
      date_closed: null,
      is_final: 0,
      final_state: null
    },
    {
      closure_cycle: 1,
      date_closed: null,
      is_final: 1,
      final_state: 'date_missing'
    }
  ]);
});

test('a closure date appearing during retries produces a complete final snapshot in the same cycle', t => {
  const { db, tracker } = harness(t);
  queueClosure(tracker);

  const first = tracker.scheduleAfterDetail({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    effectiveStatus: 'Closed',
    detail: detail(),
    source: 'closure_followup',
    checkedAt: '2026-07-20T14:00:00.000Z'
  });
  assert.equal(first.finalized, false);

  const dateClosed = '2026-07-20T13:29:45Z';
  const second = tracker.scheduleAfterDetail({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    effectiveStatus: 'Closed',
    detail: detail({ dateClosed, updatedOn: '2026-07-20T14:05:00Z' }),
    source: 'closure_followup',
    checkedAt: '2026-07-20T14:05:10.000Z'
  });
  assert.deepEqual(second, {
    state: 'closed',
    finalized: true,
    snapshotAdded: true
  });

  const row = tracker.getFollowUp.get(SR_NUMBER);
  assert.equal(row.state, 'closed');
  assert.equal(row.closure_cycle, 1);
  assert.equal(row.closing_attempts, 2);
  const final = db.prepare(`
    SELECT date_closed, final_state, snapshot_json
    FROM request_closure_snapshots
    WHERE srnumber = ? AND is_final = 1
  `).get(SR_NUMBER);
  assert.equal(final.date_closed, dateClosed);
  assert.equal(final.final_state, 'complete');
  assert.equal(JSON.parse(final.snapshot_json).dateClosed, dateClosed);
});

test('a lagging detail page cannot undo a map closure and is retried until it confirms closure', t => {
  const { db, tracker } = harness(t);
  queueClosure(tracker);

  const lagged = tracker.scheduleAfterDetail({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    effectiveStatus: 'Closed',
    detail: detail({ status: 'In Progress', dateClosed: null }),
    source: 'closure_followup',
    checkedAt: '2026-07-20T14:00:00.000Z'
  });
  assert.deepEqual(lagged, {
    state: 'closing',
    finalized: false,
    snapshotAdded: false
  });
  let row = tracker.getFollowUp.get(SR_NUMBER);
  assert.equal(row.state, 'closing');
  assert.equal(row.closure_cycle, 1);
  assert.equal(row.closing_attempts, 1);
  assert.match(row.last_error, /has not confirmed the map closure/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM request_closure_snapshots').get().count, 0);

  const dateClosed = '2026-07-20T13:55:00Z';
  const confirmed = tracker.scheduleAfterDetail({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    effectiveStatus: 'Closed',
    detail: detail({ status: 'Resolved', dateClosed }),
    source: 'closure_followup',
    checkedAt: '2026-07-20T14:15:05.000Z'
  });
  assert.equal(confirmed.finalized, true);
  row = tracker.getFollowUp.get(SR_NUMBER);
  assert.equal(row.state, 'closed');
  assert.equal(row.closure_cycle, 1);
  assert.equal(row.last_error, null);
});

test('four successful but lagging open detail responses finalize one detail-unconfirmed snapshot', t => {
  const { db, tracker } = harness(t);
  queueClosure(tracker);
  const checkedAt = [
    '2026-07-20T14:00:00.000Z',
    '2026-07-20T14:15:00.000Z',
    '2026-07-20T16:15:00.000Z',
    '2026-07-21T16:15:00.000Z'
  ];

  for (let index = 0; index < checkedAt.length; index += 1) {
    const result = tracker.scheduleAfterDetail({
      srnumber: SR_NUMBER,
      portalId: PORTAL_ID,
      effectiveStatus: 'Closed',
      detail: detail({ status: 'In Progress', dateClosed: null }),
      source: 'closure_followup',
      checkedAt: checkedAt[index]
    });
    assert.equal(result.finalized, index === 3);
    assert.equal(result.snapshotAdded, index === 3);
  }

  const row = tracker.getFollowUp.get(SR_NUMBER);
  assert.equal(row.state, 'closed');
  assert.equal(row.closure_cycle, 1);
  assert.equal(row.closing_attempts, 4);
  assert.equal(row.finalized_at, checkedAt[3]);
  assert.equal(row.last_error, null);

  const snapshots = db.prepare(`
    SELECT closure_cycle, status, date_closed, is_final, final_state
    FROM request_closure_snapshots WHERE srnumber = ? ORDER BY id
  `).all(SR_NUMBER).map(snapshot => ({ ...snapshot }));
  assert.deepEqual(snapshots, [{
    closure_cycle: 1,
    status: 'In Progress',
    date_closed: null,
    is_final: 1,
    final_state: 'detail_unconfirmed'
  }]);
});

test('late duplicate closure detail after finalization cannot create another cycle or final snapshot', t => {
  const { db, tracker } = harness(t);
  queueClosure(tracker);
  const dateClosed = '2026-07-20T13:35:00Z';
  tracker.scheduleAfterDetail({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    effectiveStatus: 'Closed',
    detail: detail({ dateClosed }),
    source: 'closure_followup',
    checkedAt: '2026-07-20T14:00:00.000Z'
  });
  const finalizedRow = tracker.getFollowUp.get(SR_NUMBER);

  const duplicate = tracker.scheduleAfterDetail({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    effectiveStatus: 'Closed',
    detail: detail({
      status: 'Resolved',
      dateClosed,
      updatedOn: '2026-07-20T14:30:00Z'
    }),
    source: 'detail',
    checkedAt: '2026-07-20T14:31:00.000Z'
  });
  assert.deepEqual(duplicate, {
    state: 'closed',
    finalized: true,
    snapshotAdded: false
  });
  assert.deepEqual(tracker.getFollowUp.get(SR_NUMBER), finalizedRow);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM request_closure_snapshots
    WHERE srnumber = ? AND is_final = 1
  `).get(SR_NUMBER).count, 1);
  assert.equal(db.prepare(`
    SELECT MAX(closure_cycle) AS cycle FROM request_closure_snapshots
    WHERE srnumber = ?
  `).get(SR_NUMBER).cycle, 1);
});

test('dateClosed finalizes a complete closure even while detail status is stale and open', t => {
  const { db, tracker } = harness(t);
  queueClosure(tracker);
  const dateClosed = '2026-07-20T13:50:00Z';

  const result = tracker.scheduleAfterDetail({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    effectiveStatus: 'In Progress',
    detail: detail({ status: 'In Progress', dateClosed }),
    source: 'closure_followup',
    checkedAt: '2026-07-20T14:00:00.000Z'
  });
  assert.deepEqual(result, {
    state: 'closed',
    finalized: true,
    snapshotAdded: true
  });
  const row = tracker.getFollowUp.get(SR_NUMBER);
  assert.equal(row.state, 'closed');
  assert.equal(row.closure_cycle, 1);
  assert.equal(row.closing_attempts, 1);

  const final = db.prepare(`
    SELECT status, date_closed, final_state
    FROM request_closure_snapshots
    WHERE srnumber = ? AND closure_cycle = 1 AND is_final = 1
  `).get(SR_NUMBER);
  assert.equal(final.status, 'In Progress');
  assert.equal(final.date_closed, dateClosed);
  assert.equal(final.final_state, 'complete');
});

test('open follow-ups use a fixed 24 hours and ignore Portal timing metadata', t => {
  const { tracker } = harness(t);
  const checkedAt = '2026-07-20T14:00:00.000Z';
  const result = tracker.scheduleAfterDetail({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    effectiveStatus: 'In Progress',
    detail: detail({
      status: 'In Progress',
      nextUpdate: '5 minutes',
      updatedOn: '2030-01-01T00:00:00.000Z'
    }),
    source: 'detail',
    checkedAt
  });

  assert.deepEqual(result, {
    state: 'open',
    finalized: false,
    snapshotAdded: false
  });
  const row = tracker.getFollowUp.get(SR_NUMBER);
  assert.equal(row.next_check_at, '2026-07-21T14:00:00.000Z');
  assert.equal(row.last_checked_at, checkedAt);
  assert.equal(row.last_success_at, checkedAt);
  assert.equal(tracker.markFollowUpError(
    row,
    new Error('timeout'),
    '2026-07-20T14:05:00.000Z'
  ), 30_000);
  const retry = tracker.getFollowUp.get(SR_NUMBER);
  assert.equal(retry.next_check_at, '2026-07-20T14:05:30.000Z');
  assert.equal(retry.last_success_at, checkedAt);
  assert.equal(retry.last_error, 'timeout');
});

test('normalizes legacy open schedules without replacing an error retry', t => {
  const { db, tracker } = harness(t);
  db.prepare(`
    INSERT INTO request_followup_queue (
      srnumber, portal_id, state, next_check_at, attempts, closing_attempts,
      closure_cycle, last_checked_at, last_success_at, last_error, finalized_at, updated_at
    ) VALUES (?, ?, 'open', ?, 0, 0, 0, ?, NULL, NULL, NULL, ?)
  `).run(
    SR_NUMBER,
    PORTAL_ID,
    '2026-07-27T12:00:00.000Z',
    '2026-07-20T12:00:00.000Z',
    '2026-07-20T12:00:00.000Z'
  );
  const retryNumber = '311-12345679';
  db.prepare(`
    INSERT INTO request_followup_queue (
      srnumber, portal_id, state, next_check_at, attempts, closing_attempts,
      closure_cycle, last_checked_at, last_success_at, last_error, finalized_at, updated_at
    ) VALUES (?, NULL, 'open', ?, 1, 0, 0, ?, NULL, 'timeout', NULL, ?)
  `).run(
    retryNumber,
    '2026-07-20T13:00:00.000Z',
    '2026-07-20T12:00:00.000Z',
    '2026-07-20T12:00:00.000Z'
  );
  const dueNumber = '311-12345680';
  db.prepare(`
    INSERT INTO request_followup_queue (
      srnumber, portal_id, state, next_check_at, attempts, closing_attempts,
      closure_cycle, last_checked_at, last_success_at, last_error, finalized_at, updated_at
    ) VALUES (?, NULL, 'open', ?, 0, 0, 0, ?, NULL, NULL, NULL, ?)
  `).run(
    dueNumber,
    '2026-07-20T13:30:00.000Z',
    '2026-07-20T12:00:00.000Z',
    '2026-07-20T13:30:00.000Z'
  );

  assert.equal(tracker.normalizeOpenFollowUps(new Date('2026-07-20T14:00:00.000Z')), 2);
  const normalized = tracker.getFollowUp.get(SR_NUMBER);
  assert.equal(normalized.next_check_at, '2026-07-21T12:00:00.000Z');
  assert.equal(normalized.last_success_at, '2026-07-20T12:00:00.000Z');
  assert.equal(tracker.getFollowUp.get(retryNumber).next_check_at, '2026-07-20T13:00:00.000Z');
  assert.equal(tracker.getFollowUp.get(dueNumber).next_check_at, '2026-07-20T13:30:00.000Z');
  assert.equal(tracker.normalizeOpenFollowUps(new Date('2026-07-20T14:00:00.000Z')), 0);
});

test('adds last-success tracking to an existing follow-up database without losing its queue', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE request_followup_queue (
      srnumber TEXT PRIMARY KEY,
      portal_id TEXT,
      state TEXT NOT NULL,
      next_check_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      closing_attempts INTEGER NOT NULL DEFAULT 0,
      closure_cycle INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      last_error TEXT,
      finalized_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO request_followup_queue (
      srnumber, portal_id, state, next_check_at, last_checked_at, updated_at
    ) VALUES (?, ?, 'open', ?, ?, ?)
  `).run(
    SR_NUMBER,
    PORTAL_ID,
    '2026-07-27T12:00:00.000Z',
    '2026-07-20T12:00:00.000Z',
    '2026-07-20T12:00:00.000Z'
  );

  const tracker = createClosureTracker(db);
  const columns = db.prepare('PRAGMA table_info(request_followup_queue)').all();
  assert.ok(columns.some(column => column.name === 'last_success_at'));
  assert.equal(tracker.getFollowUp.get(SR_NUMBER).next_check_at, '2026-07-27T12:00:00.000Z');
  assert.equal(tracker.normalizeOpenFollowUps(new Date('2026-07-20T14:00:00.000Z')), 1);
  assert.equal(tracker.getFollowUp.get(SR_NUMBER).next_check_at, '2026-07-21T12:00:00.000Z');
});

test('follow-up state, status dedupe, and closure cycle survive tracker recreation', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const firstTracker = createClosureTracker(db);

  firstTracker.observeStatus({
    srnumber: SR_NUMBER,
    previousStatus: null,
    status: 'In Progress',
    source: 'map',
    observedAt: '2026-07-20T12:00:00.000Z'
  });
  firstTracker.observeStatus({
    srnumber: SR_NUMBER,
    previousStatus: 'In Progress',
    status: 'Closed',
    source: 'map',
    observedAt: '2026-07-20T13:30:00.000Z'
  });
  queueClosure(firstTracker);
  firstTracker.scheduleAfterDetail({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    effectiveStatus: 'Closed',
    detail: detail(),
    source: 'closure_followup',
    checkedAt: '2026-07-20T14:00:00.000Z'
  });

  const secondTracker = createClosureTracker(db);
  let row = secondTracker.getFollowUp.get(SR_NUMBER);
  assert.equal(row.state, 'closing');
  assert.equal(row.closure_cycle, 1);
  assert.equal(row.closing_attempts, 1);
  assert.equal(secondTracker.observeStatus({
    srnumber: SR_NUMBER,
    previousStatus: null,
    status: ' closed ',
    source: 'migration',
    observedAt: '2026-07-20T14:01:00.000Z'
  }), false);

  const dateClosed = '2026-07-20T13:35:00Z';
  const result = secondTracker.scheduleAfterDetail({
    srnumber: SR_NUMBER,
    portalId: PORTAL_ID,
    effectiveStatus: 'Closed',
    detail: detail({ dateClosed }),
    source: 'closure_followup',
    checkedAt: '2026-07-20T14:15:00.000Z'
  });
  assert.equal(result.finalized, true);
  row = secondTracker.getFollowUp.get(SR_NUMBER);
  assert.equal(row.state, 'closed');
  assert.equal(row.closure_cycle, 1);
  assert.equal(row.closing_attempts, 2);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM request_status_history WHERE srnumber = ?
  `).get(SR_NUMBER).count, 2);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM request_closure_snapshots
    WHERE srnumber = ? AND closure_cycle = 1 AND is_final = 1
  `).get(SR_NUMBER).count, 1);
});
