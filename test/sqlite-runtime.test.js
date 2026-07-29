'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_BUSY_TIMEOUT_MS,
  MAX_BUSY_TIMEOUT_MS,
  resolveBusyTimeoutMs,
  resolveSynchronousMode
} = require('../sqlite-runtime');

test('keeps NORMAL locally and accepts a durable FULL cloud setting', () => {
  assert.equal(resolveSynchronousMode(), 'NORMAL');
  assert.equal(resolveSynchronousMode('full'), 'FULL');
  assert.equal(resolveSynchronousMode(' EXTRA '), 'EXTRA');
});

test('rejects values before interpolating them into a PRAGMA', () => {
  assert.throws(() => resolveSynchronousMode('FULL; DROP TABLE x'), /must be one of/);
});

test('uses a thirty-second SQLite writer wait by default', () => {
  assert.equal(DEFAULT_BUSY_TIMEOUT_MS, 30_000);
  assert.equal(resolveBusyTimeoutMs(), 30_000);
  assert.equal(resolveBusyTimeoutMs(' 45000 '), 45_000);
  assert.equal(resolveBusyTimeoutMs(0), 0);
});

test('validates SQLite busy timeouts before PRAGMA interpolation', () => {
  assert.equal(MAX_BUSY_TIMEOUT_MS, 300_000);
  for (const value of [-1, 1.5, 300_001, '30s', '1; DROP TABLE x']) {
    assert.throws(() => resolveBusyTimeoutMs(value), /must be an integer/);
  }
});
