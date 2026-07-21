const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assessRecordAvailability,
  currentCycleClosureDate,
  currentLifecycleProjection,
  hasMapPin
} = require('../record-availability');

function completeRecord(overrides = {}) {
  return {
    status: 'In Progress',
    problem: 'Illegal Parking',
    problem_details: 'Blocked hydrant',
    additional_details: 'Blue sedan',
    address: '100 Main Street',
    latitude: 40.71,
    longitude: -74.0,
    submitted_at: '2026-07-20T12:00:00.000Z',
    date_reported: '2026-07-20T12:00:00.000Z',
    updated_on: '2026-07-20T12:05:00.000Z',
    next_update: '2 Hours',
    date_closed: null,
    details_fetched_at: '2026-07-20T12:06:00.000Z',
    ...overrides
  };
}

test('does not call fields missing while the detail check is pending', () => {
  const result = assessRecordAvailability(completeRecord({
    details_fetched_at: null,
    status: null,
    problem: null
  }));

  assert.equal(result.public_details_state, 'pending');
  assert.equal(result.missing_public_fields, null);
});

test('keeps a missing map pin separate from public-field completeness', () => {
  const result = assessRecordAvailability(completeRecord({
    latitude: null,
    longitude: null
  }));

  assert.equal(result.has_map_pin, false);
  assert.deepEqual(result.missing_public_fields, []);
});

test('lists every public field that the loaded Portal record omitted', () => {
  const result = assessRecordAvailability(completeRecord({
    status: null,
    problem: null,
    problem_details: null,
    additional_details: '',
    address: null,
    submitted_at: null,
    date_reported: null,
    updated_on: null,
    next_update: null
  }));

  assert.deepEqual(
    result.missing_public_fields.map(field => field.key),
    [
      'status', 'problem', 'problem_details', 'additional_details', 'address',
      'reported_time', 'updated_on', 'next_update'
    ]
  );
  assert.deepEqual(
    result.missing_important_fields.map(field => field.key),
    ['status', 'problem', 'reported_time']
  );
});

test('requires a closed time for a closed request instead of a next update', () => {
  const result = assessRecordAvailability(completeRecord({
    status: 'Closed',
    next_update: null,
    date_closed: null
  }));

  assert.ok(result.missing_public_fields.some(field => field.key === 'date_closed'));
  assert.ok(!result.missing_public_fields.some(field => field.key === 'next_update'));
});

test('a closure date wins over a stale open status when no reopen is tracked', () => {
  const result = assessRecordAvailability(completeRecord({
    status: 'In Progress',
    followup_state: null,
    next_update: null,
    date_closed: '2026-07-20T14:00:00.000Z'
  }));

  assert.ok(!result.missing_public_fields.some(field => field.key === 'date_closed'));
  assert.ok(!result.missing_public_fields.some(field => field.key === 'next_update'));
});

test('an active followup wins over a retained closure date after reopening', () => {
  const result = assessRecordAvailability(completeRecord({
    status: 'In Progress',
    followup_state: 'open',
    next_update: null,
    date_closed: '2026-07-20T14:00:00.000Z'
  }));

  assert.ok(result.missing_public_fields.some(field => field.key === 'next_update'));
  assert.ok(!result.missing_public_fields.some(field => field.key === 'date_closed'));
});

test('the current dashboard projection suppresses retained closure dates while open or closing', () => {
  const retained = '2026-07-20T14:00:00.000Z';
  assert.equal(currentCycleClosureDate({ followup_state: 'open', date_closed: retained }), null);
  assert.equal(currentCycleClosureDate({ followup_state: 'closing', date_closed: retained }), null);
  assert.equal(currentCycleClosureDate({ followup_state: 'closed', date_closed: retained }), retained);
  assert.equal(currentCycleClosureDate({ followup_state: null, date_closed: retained }), retained);
});

test('the current closure cycle snapshot wins over a retained prior-cycle date', () => {
  const priorDate = '2026-07-19T14:00:00.000Z';
  const currentDate = '2026-07-20T14:00:00.000Z';
  assert.equal(currentCycleClosureDate({
    followup_state: 'closed',
    closure_cycle_tracking: true,
    date_closed: priorDate,
    current_cycle_date_closed: currentDate,
    current_cycle_final_state: 'complete'
  }), currentDate);
  assert.equal(currentCycleClosureDate({
    followup_state: 'closed',
    closure_cycle_tracking: true,
    date_closed: priorDate,
    current_cycle_date_closed: null,
    current_cycle_final_state: 'date_missing'
  }), null);
  assert.equal(currentCycleClosureDate({
    followup_state: 'closed',
    closure_cycle_tracking: true,
    date_closed: priorDate,
    current_cycle_date_closed: null,
    current_cycle_final_state: 'detail_unconfirmed'
  }), null);
});

test('an untracked current closure date normalizes a stale open status for rendering', () => {
  assert.deepEqual(currentLifecycleProjection({
    status: 'In Progress',
    followup_state: null,
    date_closed: '2026-07-20T14:00:00.000Z'
  }), {
    status: 'Closed',
    date_closed: '2026-07-20T14:00:00.000Z'
  });
});

test('a tracked limited closure normalizes stale status without reviving the prior date', () => {
  assert.deepEqual(currentLifecycleProjection({
    status: 'In Progress',
    followup_state: 'closed',
    closure_cycle_tracking: true,
    date_closed: '2026-07-19T14:00:00.000Z',
    current_cycle_date_closed: null,
    current_cycle_final_state: 'date_missing'
  }), {
    status: 'Closed',
    date_closed: null
  });
});

test('a closure date supplies lifecycle status when the detail status is blank', () => {
  const result = assessRecordAvailability(completeRecord({
    status: null,
    followup_state: 'closed',
    date_closed: '2026-07-20T14:00:00.000Z'
  }));

  assert.ok(!result.missing_public_fields.some(field => field.key === 'status'));
  assert.ok(!result.missing_public_fields.some(field => field.key === 'next_update'));
});

test('treats N/A as a value supplied by the Portal', () => {
  const result = assessRecordAvailability(completeRecord({
    next_update: 'N/A',
    additional_details: 'N/A'
  }));

  assert.deepEqual(result.missing_public_fields, []);
});

test('accepts numeric strings as real coordinates but rejects blanks', () => {
  assert.equal(hasMapPin({ latitude: '40.7', longitude: '-73.9' }), true);
  assert.equal(hasMapPin({ latitude: '', longitude: '-73.9' }), false);
  assert.equal(hasMapPin({ latitude: null, longitude: null }), false);
});
