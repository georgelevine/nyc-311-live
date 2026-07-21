'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { originMatchesHost } = require('../request-security');

test('allows same-host settings changes and non-browser clients without Origin', () => {
  assert.equal(originMatchesHost('https://311.example.org', '311.example.org'), true);
  assert.equal(originMatchesHost('https://311.example.org', '311.example.org', 'https'), true);
  assert.equal(originMatchesHost('http://127.0.0.1:3114', '127.0.0.1:3114'), true);
  assert.equal(originMatchesHost(null, '311.example.org'), true);
});

test('rejects cross-origin and malformed Origin values', () => {
  assert.equal(originMatchesHost('https://attacker.example', '311.example.org'), false);
  assert.equal(originMatchesHost('http://311.example.org', '311.example.org', 'https'), false);
  assert.equal(originMatchesHost('not a URL', '311.example.org'), false);
  assert.equal(originMatchesHost('https://311.example.org', ''), false);
});
