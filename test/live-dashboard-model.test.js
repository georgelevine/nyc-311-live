'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activeFilterLabel,
  exactSrnumberQuery,
  feedCardModel,
  recordCoordinates,
  recordDetailsPending,
  recordHasMapPin
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
