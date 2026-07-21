'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { geographyFromPortalAddress } = require('../address-geography');

test('extracts normalized borough and ZIP from Portal addresses', () => {
  assert.deepEqual(
    geographyFromPortalAddress('238 EAST 116 STREET, MANHATTAN (NEW YORK), NY, 10029'),
    { borough: 'Manhattan', incident_zip: '10029' }
  );
  assert.deepEqual(
    geographyFromPortalAddress('860 DEKALB AVENUE, BROOKLYN, NY, 11221'),
    { borough: 'Brooklyn', incident_zip: '11221' }
  );
  assert.deepEqual(
    geographyFromPortalAddress('103 MAIN STREET, STATEN IS (STATEN ISLAND), NY, 10307'),
    { borough: 'Staten Island', incident_zip: '10307' }
  );
});

test('does not guess when the Portal address is incomplete', () => {
  assert.deepEqual(geographyFromPortalAddress('Location unavailable'), {
    borough: null,
    incident_zip: null
  });
});

test('stores the five-digit portion of ZIP+4', () => {
  assert.equal(
    geographyFromPortalAddress('1 CENTRE ST, MANHATTAN (NEW YORK), NY, 10007-1602').incident_zip,
    '10007'
  );
});
