'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStatusUpdateModel,
  currentClosureSnapshot,
  portalEvent
} = require('../public/js/status-update-model');

function closedRecord(overrides = {}) {
  return {
    srnumber: '311-28334446',
    status: 'Closed',
    followup_state: 'closed',
    closure_cycle: 1,
    date_closed: '2026-07-23T16:39:18.000Z',
    finalized_at: '2026-07-23T20:01:56.170Z',
    ...overrides
  };
}

function closurePayload(overrides = {}) {
  return {
    history: [
      {
        id: 1,
        previous_status: null,
        status: 'In Progress',
        source: 'migration',
        observed_at: '2026-07-23T15:42:48.000Z'
      },
      {
        id: 2,
        previous_status: 'In Progress',
        status: 'Closed',
        source: 'detail',
        effective_at: '2026-07-23T16:39:18.000Z',
        observed_at: '2026-07-23T20:01:56.170Z'
      }
    ],
    closure_snapshots: [
      {
        id: 4,
        closure_cycle: 1,
        is_final: 1,
        final_state: 'complete',
        fetched_at: '2026-07-23T20:01:56.170Z',
        snapshot: {
          status: 'Closed',
          dateClosed: '2026-07-23T16:39:18.000Z',
          additionalDetails: null
        }
      }
    ],
    followup: { state: 'closed', closure_cycle: 1 },
    ...overrides
  };
}

test('projects a pre-subscription closure from the current Portal cycle', () => {
  const model = buildStatusUpdateModel(closedRecord(), closurePayload(), {
    updates: [],
    total: 0
  });
  assert.equal(model.official_status, 'Closed');
  assert.equal(model.events.length, 1);
  assert.equal(model.events[0].source, 'portal');
  assert.equal(model.events[0].title, 'In Progress → Closed');
  assert.equal(model.events[0].effective_at, '2026-07-23T16:39:18.000Z');
  assert.equal(model.events[0].verification_state, 'verified');
});

test('ignores a retained closure snapshot after a request reopens', () => {
  const record = closedRecord({
    status: 'In Progress',
    followup_state: 'open',
    date_closed: '2026-07-23T16:39:18.000Z'
  });
  const payload = closurePayload({
    history: [
      ...closurePayload().history,
      {
        id: 3,
        previous_status: 'Closed',
        status: 'In Progress',
        source: 'detail',
        effective_at: '2026-07-23T21:00:00.000Z',
        observed_at: '2026-07-23T21:00:05.000Z'
      }
    ],
    followup: { state: 'open', closure_cycle: 1 }
  });
  assert.equal(currentClosureSnapshot(record, payload), null);
  const event = portalEvent(record, payload);
  assert.equal(event.title, 'Closed → In Progress');
  assert.equal(event.effective_at, '2026-07-23T21:00:00.000Z');
  assert.equal(event.verification_state, null);
});

test('labels a provisional closing snapshot as verification in progress', () => {
  const record = closedRecord({ followup_state: 'closing' });
  const payload = closurePayload({
    closure_snapshots: [{
      id: 3,
      closure_cycle: 1,
      is_final: 0,
      final_state: null,
      fetched_at: '2026-07-23T20:00:00.000Z',
      snapshot: { status: 'Closed', dateClosed: '2026-07-23T16:39:18.000Z' }
    }],
    followup: { state: 'closing', closure_cycle: 1 }
  });
  const event = portalEvent(record, payload);
  assert.equal(event.verification_state, 'checking');
  assert.equal(event.verification_label, 'Portal verification in progress');
});

test('does not invent a closure timestamp when the Portal omitted it', () => {
  const record = closedRecord({ date_closed: null });
  const payload = closurePayload({
    history: [{
      id: 2,
      previous_status: 'In Progress',
      status: 'Closed',
      source: 'detail',
      effective_at: null,
      observed_at: '2026-07-23T20:01:56.170Z'
    }],
    closure_snapshots: [{
      id: 4,
      closure_cycle: 1,
      is_final: 1,
      final_state: 'date_missing',
      fetched_at: '2026-07-23T20:01:56.170Z',
      snapshot: { status: 'Closed', dateClosed: null }
    }]
  });
  const event = portalEvent(record, payload);
  assert.equal(event.effective_at, null);
  assert.equal(event.observed_at, '2026-07-23T20:01:56.170Z');
});

test('email narrative is shown without changing the official lifecycle status', () => {
  const record = closedRecord({ status: 'In Progress', followup_state: 'closing' });
  const model = buildStatusUpdateModel(record, { history: [], closure_snapshots: [] }, {
    total: 1,
    updates: [{
      id: 9,
      event_kind: 'Closed',
      agency_name: 'New York City Police Department',
      response_text: 'The agency responded to the complaint.',
      received_at: '2026-07-23T20:05:00.000Z',
      closure_wake_queued: true
    }]
  });
  assert.equal(model.official_status, 'In Progress');
  assert.equal(model.events[0].source, 'email');
  assert.equal(model.events[0].response_text, 'The agency responded to the complaint.');
  assert.equal(model.events[0].verification_state, 'checking');
});

test('orders the newest email and Portal events first', () => {
  const model = buildStatusUpdateModel(closedRecord(), closurePayload(), {
    total: 2,
    updates: [
      { id: 1, event_kind: 'Updated', received_at: '2026-07-23T19:00:00.000Z' },
      { id: 2, event_kind: 'Closed', received_at: '2026-07-23T20:05:00.000Z' }
    ]
  });
  assert.deepEqual(model.events.map(event => event.id), [
    'email-2',
    'portal-2',
    'email-1'
  ]);
});
