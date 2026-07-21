'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePortalDetailTimestamps,
  normalizePortalTimestamp
} = require('../portal-timestamp');

test('normalizes the Portal legacy clock as UTC for AM, PM, noon, and midnight', () => {
  assert.equal(
    normalizePortalTimestamp('7/21/2026 4:28:50 AM'),
    '2026-07-21T04:28:50.000Z'
  );
  assert.equal(
    normalizePortalTimestamp('7/21/2026 4:28:50 PM'),
    '2026-07-21T16:28:50.000Z'
  );
  assert.equal(
    normalizePortalTimestamp('7/21/2026 12:00:00 AM'),
    '2026-07-21T00:00:00.000Z'
  );
  assert.equal(
    normalizePortalTimestamp('7/21/2026 12:00:00 PM'),
    '2026-07-21T12:00:00.000Z'
  );
});

test('accepts valid leap days and rejects invalid calendar dates', () => {
  assert.equal(
    normalizePortalTimestamp('2/29/2024 11:59:59 PM'),
    '2024-02-29T23:59:59.000Z'
  );
  assert.equal(normalizePortalTimestamp('2/29/2023 11:59:59 PM'), null);
  assert.equal(normalizePortalTimestamp('2/29/2100 11:59:59 PM'), null);
  assert.equal(
    normalizePortalTimestamp('2/29/2000 11:59:59 PM'),
    '2000-02-29T23:59:59.000Z'
  );
  assert.equal(normalizePortalTimestamp('4/31/2026 1:00:00 AM'), null);
});

test('normalizes explicitly zoned ISO timestamps and is idempotent', () => {
  assert.equal(
    normalizePortalTimestamp('2026-07-21T16:28:50Z'),
    '2026-07-21T16:28:50.000Z'
  );
  assert.equal(
    normalizePortalTimestamp('2026-07-21T16:28:50.123Z'),
    '2026-07-21T16:28:50.123Z'
  );
  assert.equal(
    normalizePortalTimestamp('2026-07-21T18:58:50+02:30'),
    '2026-07-21T16:28:50.000Z'
  );
  assert.equal(
    normalizePortalTimestamp('2026-07-21T11:28:50-05:00'),
    '2026-07-21T16:28:50.000Z'
  );

  const normalized = normalizePortalTimestamp('7/21/2026 4:28:50 PM');
  assert.equal(normalizePortalTimestamp(normalized), normalized);
});

test('rejects ambiguous zone-less strings and malformed clocks or offsets', () => {
  assert.equal(normalizePortalTimestamp('2026-07-21T16:28:50'), null);
  assert.equal(normalizePortalTimestamp('2026-07-21 16:28:50'), null);
  assert.equal(normalizePortalTimestamp('July 21, 2026 4:28:50 PM'), null);
  assert.equal(normalizePortalTimestamp('7/21/2026 0:28:50 AM'), null);
  assert.equal(normalizePortalTimestamp('7/21/2026 13:28:50 PM'), null);
  assert.equal(normalizePortalTimestamp('7/21/2026 4:60:50 PM'), null);
  assert.equal(normalizePortalTimestamp('7/21/2026 4:28:60 PM'), null);
  assert.equal(normalizePortalTimestamp('2026-07-21T24:00:00Z'), null);
  assert.equal(normalizePortalTimestamp('2026-07-21T16:60:00Z'), null);
  assert.equal(normalizePortalTimestamp('2026-07-21T16:28:50+24:00'), null);
  assert.equal(normalizePortalTimestamp('2026-07-21T16:28:50+01:60'), null);
});

test('accepts valid Date objects and rejects invalid or empty values', () => {
  assert.equal(
    normalizePortalTimestamp(new Date('2026-07-21T16:28:50.456Z')),
    '2026-07-21T16:28:50.456Z'
  );
  assert.equal(normalizePortalTimestamp(new Date(Number.NaN)), null);
  assert.equal(normalizePortalTimestamp(null), null);
  assert.equal(normalizePortalTimestamp(undefined), null);
  assert.equal(normalizePortalTimestamp('   '), null);
});

test('keeps UTC instants stable across New York daylight-saving boundaries', () => {
  assert.equal(
    normalizePortalTimestamp('3/8/2026 6:59:59 AM'),
    '2026-03-08T06:59:59.000Z'
  );
  assert.equal(
    normalizePortalTimestamp('3/8/2026 7:00:00 AM'),
    '2026-03-08T07:00:00.000Z'
  );
  assert.equal(
    normalizePortalTimestamp('11/1/2026 5:59:59 AM'),
    '2026-11-01T05:59:59.000Z'
  );
  assert.equal(
    normalizePortalTimestamp('11/1/2026 6:00:00 AM'),
    '2026-11-01T06:00:00.000Z'
  );
});

test('normalizes every Portal detail timestamp without mutating other fields', () => {
  const detail = {
    srnumber: '311-28310246',
    status: 'Closed',
    dateReported: '7/21/2026 4:28:50 PM',
    updatedOn: '2026-07-21T18:58:50+02:30',
    dateClosed: '',
    fields: { Problem: 'Noise' }
  };

  const normalized = normalizePortalDetailTimestamps(detail);
  assert.deepEqual(normalized, {
    srnumber: '311-28310246',
    status: 'Closed',
    dateReported: '2026-07-21T16:28:50.000Z',
    updatedOn: '2026-07-21T16:28:50.000Z',
    dateClosed: null,
    fields: { Problem: 'Noise' }
  });
  assert.equal(detail.dateReported, '7/21/2026 4:28:50 PM');
  assert.equal(normalizePortalDetailTimestamps(null), null);
});
