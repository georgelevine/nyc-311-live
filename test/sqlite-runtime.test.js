'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveSynchronousMode } = require('../sqlite-runtime');

test('keeps NORMAL locally and accepts a durable FULL cloud setting', () => {
  assert.equal(resolveSynchronousMode(), 'NORMAL');
  assert.equal(resolveSynchronousMode('full'), 'FULL');
  assert.equal(resolveSynchronousMode(' EXTRA '), 'EXTRA');
});

test('rejects values before interpolating them into a PRAGMA', () => {
  assert.throws(() => resolveSynchronousMode('FULL; DROP TABLE x'), /must be one of/);
});
