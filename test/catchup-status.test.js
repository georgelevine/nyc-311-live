'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatchupStatus, parseState } = require('../catchup-status');

test('builds live backward catch-up progress and ETA', () => {
  const status = buildCatchupStatus({
    windowState: JSON.stringify({
      offline_from: '2026-07-21T00:31:53.685Z',
      offline_to: '2026-07-21T04:41:37.015Z',
      low_suffix: 28305051,
      high_suffix: 28307044
    }),
    runState: {
      status: 'running',
      low_suffix: 28305051,
      high_suffix: 28307035,
      completed_at_start: 101,
      started_at: '2026-07-21T05:00:00.000Z'
    },
    coverage: { completed: 161, found: 150, not_found: 11, retry: 2 },
    currentSuffix: 28306795,
    now: Date.parse('2026-07-21T05:01:00.000Z')
  });

  assert.equal(status.status, 'running');
  assert.equal(status.total, 1994);
  assert.equal(status.completed, 161);
  assert.equal(status.remaining, 1833);
  assert.equal(status.current_suffix, 28306795);
  assert.equal(status.requests_per_second, 1);
  assert.equal(status.estimated_seconds_remaining, 1833);
});

test('marks a fully covered offline range complete', () => {
  const status = buildCatchupStatus({
    windowState: { low_suffix: 100, high_suffix: 109 },
    runState: { status: 'complete', finished_at: '2026-07-21T05:05:00.000Z' },
    coverage: { completed: 10, found: 8, not_found: 2 }
  });
  assert.equal(status.status, 'complete');
  assert.equal(status.percent, 100);
  assert.equal(status.current_suffix, null);
});

test('ignores invalid stored JSON and suffix ranges', () => {
  assert.equal(parseState('{oops'), null);
  assert.equal(buildCatchupStatus({ windowState: { low_suffix: 20, high_suffix: 10 } }), null);
});
