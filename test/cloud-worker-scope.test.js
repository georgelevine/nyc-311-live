'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseLegacyCollectorScope } = require('../cloud/collector-scope');

test('legacy PostgreSQL collection requires an explicit citywide scope', () => {
  assert.equal(
    parseLegacyCollectorScope({ COLLECTOR_SCOPE: '  CITYWIDE  ' }),
    'citywide'
  );
  for (const environment of [{}, { COLLECTOR_SCOPE: '' }, { COLLECTOR_SCOPE: 'other' }]) {
    assert.throws(
      () => parseLegacyCollectorScope(environment),
      /COLLECTOR_SCOPE must be.*citywide/i
    );
  }
  assert.throws(
    () => parseLegacyCollectorScope({ COLLECTOR_SCOPE: 'bid_only' }),
    /SQLite\/Lightsail collector only.*will not fall back to citywide/i
  );
});
