const test = require('node:test');
const assert = require('node:assert/strict');
const {
  closureRetryAt,
  closureSnapshot,
  stableValue
} = require('../cloud/closure-tracking');

test('cloud closure retries match the local 15 minute, 2 hour, 24 hour sequence', () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  assert.equal(closureRetryAt(1, now), '2026-07-20T12:15:00.000Z');
  assert.equal(closureRetryAt(2, now), '2026-07-20T14:00:00.000Z');
  assert.equal(closureRetryAt(3, now), '2026-07-21T12:00:00.000Z');
  assert.equal(closureRetryAt(99, now), '2026-07-21T12:00:00.000Z');
});
test('cloud closure snapshots are stable and retain submitted detail fields', () => {
  const detail = {
    srnumber: '311-28304438',
    status: 'Closed',
    agencyResponse: 'The outreach team visited the location.',
    dateClosed: '2026-07-20T20:00:00.000Z',
    fields: { Zebra: 'last', Alpha: 'first' }
  };
  assert.deepEqual(closureSnapshot(detail), {
    additionalDetails: null,
    agencyResponse: 'The outreach team visited the location.',
    address: null,
    dateClosed: '2026-07-20T20:00:00.000Z',
    dateReported: null,
    fields: { Alpha: 'first', Zebra: 'last' },
    nextUpdate: null,
    portalId: null,
    problem: null,
    problemDetails: null,
    srnumber: '311-28304438',
    status: 'Closed',
    updatedOn: null
  });
  assert.deepEqual(stableValue({ b: 2, a: 1 }), { a: 1, b: 2 });
});
