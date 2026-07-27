'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NYC311_SERVER_NO_LISTEN = '1';
const { sanitizeLegacyReconciliation } = require('../server');

test('sanitizes one-time reconciliation state before exposing it to the dashboard', () => {
  const result = sanitizeLegacyReconciliation(JSON.stringify({
    version: 1,
    status: 'running',
    started_at: '2026-07-27T14:00:00-04:00',
    updated_at: 'not-a-date',
    total_candidates: 100,
    checked: 120,
    api_calls: 5,
    api_returned: 105,
    api_omitted: 3,
    api_closed: 90,
    api_open: 20,
    closures_corrected: 95,
    open_subscriptions_queued: 30,
    errors: -4,
    retry_after_seconds: 999999,
    estimated_seconds_remaining: 50,
    message: '  Checking\u0000 official\nrecords  '
  }), '2026-07-27T18:01:00.000Z');

  assert.deepEqual(result, {
    version: 1,
    status: 'running',
    started_at: '2026-07-27T18:00:00.000Z',
    updated_at: '2026-07-27T18:01:00.000Z',
    finished_at: null,
    total_candidates: 100,
    checked: 100,
    percent: 100,
    api_calls: 5,
    api_returned: 100,
    api_omitted: 3,
    api_closed: 90,
    api_open: 20,
    closures_corrected: 90,
    open_subscriptions_queued: 20,
    errors: 0,
    retry_after_seconds: 86400,
    estimated_seconds_remaining: 50,
    message: 'Checking official records'
  });
});

test('keeps valid zero values and reports a completed empty reconciliation as complete', () => {
  const result = sanitizeLegacyReconciliation({
    version: 1,
    status: 'complete',
    total_candidates: 0,
    checked: 0,
    api_calls: 0,
    api_returned: 0,
    api_omitted: 0,
    api_closed: 0,
    api_open: 0,
    closures_corrected: 0,
    open_subscriptions_queued: 0,
    errors: 0,
    retry_after_seconds: null,
    estimated_seconds_remaining: null,
    finished_at: '2026-07-27T18:05:00.000Z'
  });

  assert.equal(result.percent, 100);
  assert.equal(result.finished_at, '2026-07-27T18:05:00.000Z');
  assert.equal(result.retry_after_seconds, null);
  assert.equal(result.estimated_seconds_remaining, null);
});

test('hides malformed, unknown, or oversized reconciliation state', () => {
  assert.equal(sanitizeLegacyReconciliation('{broken'), null);
  assert.equal(sanitizeLegacyReconciliation([]), null);
  assert.equal(sanitizeLegacyReconciliation({ version: 2, status: 'running' }), null);
  assert.equal(sanitizeLegacyReconciliation({ version: 1, status: 'surprise' }), null);
  assert.equal(sanitizeLegacyReconciliation('x'.repeat(32_769)), null);
});
