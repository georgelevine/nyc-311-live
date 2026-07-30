'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activeFilterLabel,
  boundaryCatalogIsUsable,
  exactSrnumberQuery,
  feedHeadMembershipDelta,
  feedCardModel,
  recordCoordinates,
  recordDetailsPending,
  recordHasMapPin,
  validatePaginatedRecords
} = require('../public/js/live-dashboard-model');

test('normalizes exact NYC311 request-number searches', () => {
  assert.equal(exactSrnumberQuery('28334841'), '311-28334841');
  assert.equal(exactSrnumberQuery('31128334841'), '311-28334841');
  assert.equal(exactSrnumberQuery('311-28334841'), '311-28334841');
  assert.equal(exactSrnumberQuery('parking'), null);
});

test('builds separate request type and submitted-detail labels for feed cards', () => {
  const model = feedCardModel({
    srnumber: '311-28334841',
    problem: 'Illegal Parking',
    problem_details: 'Double Parked Blocking Vehicle',
    address: 'MENAHAN STREET AND WYCKOFF AVENUE, BROOKLYN, NY, 11237',
    status: 'Closed',
    submitted_at: '2026-07-23T16:14:50.000Z',
    latitude: 40.7,
    longitude: -73.9
  });
  assert.equal(model.headline, 'Illegal Parking');
  assert.equal(model.detail, 'Double Parked Blocking Vehicle');
  assert.equal(model.closed, true);
  assert.equal(model.hasMapPin, true);
});

test('does not repeat an identical type as the feed detail', () => {
  assert.equal(feedCardModel({
    srnumber: '311-28334842',
    problem: 'Noise',
    problem_details: ' noise '
  }).detail, '');
});

test('respects explicit Portal map-pin state before derived coordinates', () => {
  const record = { latitude: '40.71', longitude: '-74.01', has_map_pin: false };
  assert.deepEqual(recordCoordinates(record), { lat: 40.71, lng: -74.01 });
  assert.equal(recordHasMapPin(record), false);
});

test('summarizes active geography and status filters', () => {
  assert.equal(activeFilterLabel(['', null, '']), 'None selected');
  assert.equal(activeFilterLabel(['Closed', '', '12']), '2 active');
});

test('distinguishes a captured request whose submitted details are still pending', () => {
  assert.equal(recordDetailsPending({ public_details_state: 'pending' }), true);
  assert.equal(recordDetailsPending({ public_details_state: 'loaded' }), false);
  assert.equal(recordDetailsPending({ details_fetched_at: null }), true);
  assert.equal(recordDetailsPending({ details_fetched_at: '2026-07-26T15:00:00.000Z' }), false);
  assert.equal(recordDetailsPending({}), false);
});

test('validates a strictly progressing immutable pagination page', () => {
  assert.deepEqual(validatePaginatedRecords([
    { srnumber: '311-28334840', suffix: 28334840 },
    { srnumber: '311-28334839', suffix: 28334839 }
  ], {
    beforeSuffix: 28334841,
    expectedSnapshot: '2026-07-30T12:00:00.000Z',
    requireSnapshot: true,
    page: {
      returned: 2,
      has_more: true,
      next_before_suffix: 28334839,
      snapshot_at: '2026-07-30T12:00:00.000Z'
    },
    expectedTotal: 4,
    loadedCount: 0,
    label: 'Test archive'
  }), {
    hasMore: true,
    nextSuffix: 28334839,
    snapshotAt: '2026-07-30T12:00:00.000Z'
  });
});

test('rejects pagination that repeats, changes snapshots, or makes no progress', () => {
  const base = {
    beforeSuffix: 28334841,
    expectedSnapshot: '2026-07-30T12:00:00.000Z',
    requireSnapshot: true,
    label: 'Test archive'
  };
  assert.throws(() => validatePaginatedRecords([], {
    ...base,
    page: {
      returned: 0,
      has_more: true,
      next_before_suffix: 28334840,
      snapshot_at: base.expectedSnapshot
    }
  }), /made no pagination progress/);
  assert.throws(() => validatePaginatedRecords([
    { srnumber: '311-28334840', suffix: 28334840 }
  ], {
    ...base,
    page: {
      returned: 1,
      has_more: true,
      next_before_suffix: 28334840,
      snapshot_at: '2026-07-30T12:00:01.000Z'
    }
  }), /changed snapshots/);
  assert.throws(() => validatePaginatedRecords([
    { srnumber: '311-28334840', suffix: 28334840 }
  ], {
    ...base,
    existingNumbers: new Set(['311-28334840']),
    page: {
      returned: 1,
      has_more: false,
      next_before_suffix: 28334840,
      snapshot_at: base.expectedSnapshot
    }
  }), /repeated 311-28334840/);
  assert.throws(() => validatePaginatedRecords([
    { srnumber: '311-28334840', suffix: 28334840 }
  ], {
    ...base,
    page: {
      returned: 1,
      has_more: true,
      next_before_suffix: 28334839,
      snapshot_at: base.expectedSnapshot
    }
  }), /invalid page cursor/);
});

test('bounds pagination to its advertised total', () => {
  const page = {
    returned: 1,
    has_more: true,
    next_before_suffix: 28334840,
    snapshot_at: '2026-07-30T12:00:00.000Z'
  };
  assert.throws(() => validatePaginatedRecords([
    { srnumber: '311-28334840', suffix: 28334840 }
  ], {
    page,
    requireSnapshot: true,
    expectedTotal: 1,
    loadedCount: 0
  }), /changed while loading/);
  assert.throws(() => validatePaginatedRecords([
    { srnumber: '311-28334840', suffix: 28334840 }
  ], {
    page: { ...page, has_more: false },
    requireSnapshot: true,
    expectedTotal: 2,
    loadedCount: 0
  }), /changed while loading/);
});

test('detects unexplained changes outside a loaded feed head', () => {
  const current = [
    { srnumber: '311-28334843', suffix: 28334843 },
    { srnumber: '311-28334842', suffix: 28334842 },
    { srnumber: '311-28334841', suffix: 28334841 },
    { srnumber: '311-28334840', suffix: 28334840 }
  ];
  assert.equal(feedHeadMembershipDelta(current, [
    { srnumber: '311-28334844', suffix: 28334844 },
    { srnumber: '311-28334843', suffix: 28334843 }
  ]), 1);
  assert.equal(feedHeadMembershipDelta(current, [
    { srnumber: '311-28334843', suffix: 28334843 },
    { srnumber: '311-28334841', suffix: 28334841 }
  ]), -1);
  assert.equal(feedHeadMembershipDelta(current, []), -4);
});

test('accepts only nonempty versioned geography catalogs', () => {
  assert.equal(boundaryCatalogIsUsable([{ bid_id: 1 }], '2026-04-28'), true);
  assert.equal(boundaryCatalogIsUsable([], '2026-04-28'), false);
  assert.equal(boundaryCatalogIsUsable([{ bid_id: 1 }], null), false);
});
