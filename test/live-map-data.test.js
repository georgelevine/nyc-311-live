'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAP_RECORD_FIELDS,
  buildLiveMapPayload,
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
    followup_state: 'open',
    next_check_at: new Date('2026-07-21T12:05:00.000Z'),
    finalized_at: null
  });

  assert.deepEqual(Object.keys(record), MAP_RECORD_FIELDS);
  assert.deepEqual(record, {
    srnumber: '311-00123456',
    suffix: 123456,
    problem: 'Street Condition',
    address: '1 Centre St',
    latitude: 40.7128,
    longitude: -74.006,
    submitted_at: '2026-07-20T12:00:00.000Z',
    status: 'Open',
    portal_url: 'https://portal.311.nyc.gov/sr-details/?id=99999999-1111-2222-3333-444444444444',
    first_seen_at: '2026-07-20T12:00:01.000Z',
    last_seen_at: '2026-07-20T12:05:00.000Z',
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

test('does not derive or geocode coordinates from any other field', () => {
  const record = projectLiveMapRow({
    srnumber: '311-00000001',
    suffix: 1,
    address: '1 Centre St, New York, NY',
    raw_json: { latitude: 40.7, longitude: -74 }
  });

  assert.equal(record, null);
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
