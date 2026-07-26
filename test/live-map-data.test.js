'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAP_RECORD_FIELDS,
  buildLiveMapPayload,
  mapSubmittedSince,
  projectLiveMapRow
} = require('../live-map-data');

test('projects the exact lightweight map record contract across database types', () => {
  const record = projectLiveMapRow({
    srnumber: '311-00123456',
    suffix: '123456',
    portal_id: '99999999-1111-2222-3333-444444444444',
    problem: '',
    detail_problem: 'Street Condition',
    address: ' 1 Centre St ',
    latitude: '40.7128',
    longitude: '-74.0060',
    submitted_at: new Date('2026-07-20T12:00:00.000Z'),
    status: null,
    detail_status: 'Open',
    portal_url: null,
    first_seen_at: '2026-07-20T12:00:01.000Z',
    last_seen_at: new Date('2026-07-20T12:05:00.000Z'),
    details_fetched_at: new Date('2026-07-20T12:06:00.000Z'),
    followup_state: 'open',
    next_check_at: new Date('2026-07-21T12:05:00.000Z'),
    business_improvement_district_ids: '[10,8,10]',
    business_improvement_district_boundary_version: '2026-04-28',
    finalized_at: null
  });

  assert.deepEqual(Object.keys(record), MAP_RECORD_FIELDS);
  assert.deepEqual(record, {
    srnumber: '311-00123456',
    suffix: 123456,
    problem: 'Street Condition',
    address: '1 Centre St',
    borough: null,
    incident_zip: null,
    police_precinct: null,
    police_precinct_boundary_version: null,
    business_improvement_district_ids: [8, 10],
    business_improvement_district_boundary_version: '2026-04-28',
    latitude: 40.7128,
    longitude: -74.006,
    submitted_at: '2026-07-20T12:00:00.000Z',
    status: 'Open',
    portal_url: 'https://portal.311.nyc.gov/sr-details/?id=99999999-1111-2222-3333-444444444444',
    first_seen_at: '2026-07-20T12:00:01.000Z',
    last_seen_at: '2026-07-20T12:05:00.000Z',
    details_fetched_at: '2026-07-20T12:06:00.000Z',
    followup_state: 'open',
    next_check_at: '2026-07-21T12:05:00.000Z',
    finalized_at: null
  });
});

test('returns every and only valid stored coordinate pair with matching totals', () => {
  const payload = buildLiveMapPayload([
    { srnumber: '311-00000003', suffix: 3, latitude: 40.7, longitude: -73.9 },
    { srnumber: '311-00000001', suffix: 1, latitude: '40.6', longitude: '-74.1' },
    { srnumber: '311-00000002', suffix: 2, latitude: null, longitude: -74 },
    { srnumber: '311-00000004', suffix: 4, latitude: 91, longitude: -74 },
    { srnumber: '311-00000005', suffix: 5, latitude: 40.7, longitude: 'not-a-number' }
  ]);

  assert.deepEqual(payload.stats, { total: 5, mapped_total: 2, unmapped_total: 3 });
  assert.deepEqual(payload.records.map(record => record.srnumber), [
    '311-00000003',
    '311-00000001'
  ]);
  assert.equal(payload.records.some(record => record.latitude == null || record.longitude == null), false);
});

test('accepts archive totals when the database query already omitted unmapped rows', () => {
  const payload = buildLiveMapPayload([
    { srnumber: '311-00000003', suffix: 3, latitude: 40.7, longitude: -73.9 },
    { srnumber: '311-00000001', suffix: 1, latitude: 40.6, longitude: -74.1 }
  ], {
    total: 10,
    mapped_total: 2,
    unmapped_total: 8
  });

  assert.deepEqual(payload.stats, { total: 10, mapped_total: 2, unmapped_total: 8 });
  assert.equal(payload.records.length, 2);
});

test('does not derive or geocode coordinates from any other field', () => {
  const record = projectLiveMapRow({
    srnumber: '311-00000001',
    suffix: 1,
    address: '1 Centre St, New York, NY',
    raw_json: { latitude: 40.7, longitude: -74 }
  });

  assert.equal(record, null);
});

test('accepts only a strict UTC timestamp for a recent map window', () => {
  assert.equal(mapSubmittedSince(null), null);
  assert.equal(
    mapSubmittedSince('2026-07-25T15:30:00.000Z'),
    '2026-07-25T15:30:00.000Z'
  );
  assert.throws(() => mapSubmittedSince('2026-07-25 15:30:00'), /ISO UTC timestamp/);
  assert.throws(() => mapSubmittedSince('2026-02-30T15:30:00.000Z'), /ISO UTC timestamp/);
});

test('projects lifecycle status consistently for closing, closed, and reopened requests', () => {
  const base = {
    srnumber: '311-00000001', suffix: 1, latitude: 40.7, longitude: -74
  };
  assert.equal(projectLiveMapRow({
    ...base, status: 'In Progress', followup_state: 'closing'
  }).status, 'Closed');
  assert.equal(projectLiveMapRow({
    ...base, status: 'In Progress', followup_state: 'closed',
    closure_cycle_tracking: 1, current_cycle_date_closed: null
  }).status, 'Closed');
  assert.equal(projectLiveMapRow({
    ...base, status: 'In Progress', followup_state: 'open',
    detail_date_closed: '2026-07-19T12:00:00.000Z'
  }).status, 'In Progress');
});
