'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  BusinessImprovementDistrictMatcher
} = require('../business-improvement-districts');
const {
  buildBidQueryZones,
  collectorInteger,
  deduplicatePortalPins,
  filterPinsToBids,
  mapWithConcurrency,
  parseCollectorScope,
  queryPlanHash,
  verifyZoneCoverage,
  zoneNeedsCatchup
} = require('../bid-collector-scope');
const { geometryBounds } = require('../police-precincts');

const BID_SNAPSHOT_PATH = path.join(
  __dirname,
  '..',
  'exports',
  'nyc-bid-boundaries-2026-04-28.geojson'
);

function snapshotDistrictRows() {
  const collection = JSON.parse(fs.readFileSync(BID_SNAPSHOT_PATH, 'utf8'));
  return collection.features.map(feature => {
    const bounds = geometryBounds(feature.geometry.coordinates);
    return {
      bid_id: feature.properties.bid_id,
      name: feature.properties.name,
      borough_code: feature.properties.borough_code,
      borough_name: feature.properties.borough,
      geometry: feature.geometry,
      min_longitude: bounds.minLongitude,
      min_latitude: bounds.minLatitude,
      max_longitude: bounds.maxLongitude,
      max_latitude: bounds.maxLatitude
    };
  });
}

function square(west, south, east, north) {
  return [[
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south]
  ]];
}

function testMatcher() {
  return new BusinessImprovementDistrictMatcher('test-boundaries', [
    {
      bid_id: 1,
      name: 'First BID',
      borough_code: 1,
      borough_name: 'Manhattan',
      geometry: { type: 'Polygon', coordinates: square(-74.01, 40.70, -74.00, 40.71) },
      min_longitude: -74.01,
      min_latitude: 40.70,
      max_longitude: -74.00,
      max_latitude: 40.71
    },
    {
      bid_id: 2,
      name: 'Overlapping BID',
      borough_code: 1,
      borough_name: 'Manhattan',
      geometry: { type: 'Polygon', coordinates: square(-74.005, 40.705, -73.995, 40.715) },
      min_longitude: -74.005,
      min_latitude: 40.705,
      max_longitude: -73.995,
      max_latitude: 40.715
    }
  ]);
}

function portalPin(srnumber, latitude, longitude, overrides = {}) {
  return {
    id: overrides.id || srnumber,
    latitude,
    longitude,
    data: {
      srnumber,
      submitteddate: overrides.submitteddate || '2026-08-06T12:00:00.000Z',
      updateddate: overrides.updateddate,
      status: overrides.status || 'In Progress'
    }
  };
}

test('collector scope is citywide by default and BID-only is explicit', () => {
  assert.equal(parseCollectorScope({}), 'citywide');
  assert.equal(parseCollectorScope({ COLLECTOR_SCOPE: '  BID_ONLY ' }), 'bid_only');
  assert.equal(parseCollectorScope('citywide'), 'citywide');
  assert.throws(
    () => parseCollectorScope({ COLLECTOR_SCOPE: 'bids' }),
    /Unsupported COLLECTOR_SCOPE/
  );
});

test('BID collector numeric settings reject unsafe or ambiguous values', () => {
  const options = { fallback: 60, minimum: 30, maximum: 3600 };
  assert.equal(collectorInteger({}, 'BID_POLL_INTERVAL_SECONDS', options), 60);
  assert.equal(collectorInteger({ BID_POLL_INTERVAL_SECONDS: '120' },
    'BID_POLL_INTERVAL_SECONDS', options), 120);
  for (const value of ['0', '29', '3601', '60.5', 'not-a-number']) {
    assert.throws(
      () => collectorInteger({ BID_POLL_INTERVAL_SECONDS: value },
        'BID_POLL_INTERVAL_SECONDS', options),
      /must be an integer from 30 through 3600/
    );
  }
});

test('the deterministic 12-zone plan covers all 78 pinned BID bounds', () => {
  const districts = snapshotDistrictRows();
  assert.equal(districts.length, 78);

  const zones = buildBidQueryZones(districts, { targetCount: 12 });
  const reversedZones = buildBidQueryZones([...districts].reverse(), { targetCount: 12 });
  assert.equal(zones.length, 12);
  assert.deepEqual(reversedZones, zones);
  assert.ok(zones.every(zone => zone.boroughCode != null));
  assert.deepEqual(
    [...new Set(zones.flatMap(zone => zone.bidIds))].sort((a, b) => a - b),
    districts.map(district => district.bid_id).sort((a, b) => a - b)
  );

  const coverage = verifyZoneCoverage(districts, zones);
  assert.equal(coverage.ok, true);
  assert.equal(coverage.coveredBidIds.length, 78);
  assert.deepEqual(coverage.uncoveredBidIds, []);

  const hash = queryPlanHash('2026-04-28', zones);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, queryPlanHash('2026-04-28', [...zones].reverse()));

  const damagedZones = structuredClone(zones);
  const firstDistrict = districts.find(district => district.bid_id === zones[0].bidIds[0]);
  damagedZones[0].bbox.minlongitude = firstDistrict.max_longitude;
  assert.equal(verifyZoneCoverage(districts, damagedZones).ok, false);
});

test('portal pins are deduplicated by normalized SR number using the newest snapshot', () => {
  const early = portalPin('311-00000002', 40.702, -74.008, {
    updateddate: '2026-08-06T12:01:00.000Z',
    status: 'In Progress'
  });
  const later = portalPin('31100000002', 40.702, -74.008, {
    updateddate: '2026-08-06T12:02:00.000Z',
    status: 'Closed'
  });
  const first = portalPin('311-00000001', 40.707, -74.003);
  const invalid = portalPin('not-an-sr', 40.707, -74.003);

  const result = deduplicatePortalPins([early, invalid, later, first]);
  assert.deepEqual(result, [first, {
    ...later,
    data: { ...later.data, srnumber: '311-00000002' }
  }]);
  assert.deepEqual(deduplicatePortalPins([first, later, early]), result);

  const tiedA = portalPin('311-00000003', 40.702, -74.008, {
    updateddate: '2026-08-06T12:03:00.000Z',
    status: 'Closed'
  });
  const tiedB = portalPin('31100000003', 40.702, -74.008, {
    updateddate: '2026-08-06T12:03:00.000Z',
    status: 'In Progress'
  });
  assert.deepEqual(
    deduplicatePortalPins([tiedA, tiedB]),
    deduplicatePortalPins([tiedB, tiedA])
  );

  const topLevel = { ...portalPin(null, 40.702, -74.008), data: {}, sr_number: '31100000004' };
  assert.equal(deduplicatePortalPins([topLevel])[0].data.srnumber, '311-00000004');
});

test('exact BID filtering preserves overlaps and rejects outside or invalid pins', () => {
  const matcher = testMatcher();
  const insideOne = portalPin('311-00000001', 40.702, -74.008);
  const overlap = portalPin('311-00000002', 40.707, -74.003);
  const outside = portalPin('311-00000003', 40.720, -74.020);
  const missingLatitude = portalPin('311-00000004', null, -74.003);
  const invalidLongitude = portalPin('311-00000005', 40.707, 'not-a-coordinate');
  const missingSr = portalPin(null, 40.707, -74.003);

  const accepted = filterPinsToBids([
    outside,
    overlap,
    missingLatitude,
    insideOne,
    invalidLongitude,
    missingSr
  ], matcher);

  assert.deepEqual(accepted.map(item => item.pin), [overlap, insideOne]);
  assert.deepEqual(
    accepted[0].bidMatch.districts.map(district => district.bidId),
    [1, 2]
  );
  assert.deepEqual(
    accepted[1].bidMatch.districts.map(district => district.bidId),
    [1]
  );
});

test('exact filtering covers outer and hole edges, rejects hole interiors, and supports MultiPolygon', () => {
  const matcher = new BusinessImprovementDistrictMatcher('shape-test', [
    {
      bid_id: 10,
      name: 'Holed BID',
      borough_code: 1,
      borough_name: 'Manhattan',
      geometry: {
        type: 'Polygon',
        coordinates: [
          square(-74.02, 40.70, -74.00, 40.72)[0],
          square(-74.015, 40.705, -74.005, 40.715)[0]
        ]
      },
      min_longitude: -74.02,
      min_latitude: 40.70,
      max_longitude: -74.00,
      max_latitude: 40.72
    },
    {
      bid_id: 11,
      name: 'Island BID',
      borough_code: 1,
      borough_name: 'Manhattan',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          square(-74.04, 40.70, -74.03, 40.71),
          square(-74.06, 40.72, -74.05, 40.73)
        ]
      },
      min_longitude: -74.06,
      min_latitude: 40.70,
      max_longitude: -74.03,
      max_latitude: 40.73
    }
  ]);
  const outerEdge = matcher.match(40.71, -74.02);
  const holeInterior = matcher.match(40.71, -74.01);
  const holeEdge = matcher.match(40.71, -74.015);
  const secondIsland = matcher.match(40.725, -74.055);
  assert.deepEqual(outerEdge.districts.map(item => item.bidId), [10]);
  assert.deepEqual(holeInterior.districts, []);
  assert.deepEqual(holeEdge.districts.map(item => item.bidId), [10]);
  assert.deepEqual(secondIsland.districts.map(item => item.bidId), [11]);
});

test('bounded-concurrency mapping preserves input order and honors its limit', async () => {
  let active = 0;
  let maximumActive = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async value => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, value % 2 ? 4 : 1));
    active -= 1;
    return value * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
  assert.equal(maximumActive, 2);
});

test('zone saturation triggers catch-up only when the cap may hide unseen pins', () => {
  const watermark = '2026-08-06T12:00:00.000Z';
  const newer = index => portalPin(
    `311-${String(index + 1).padStart(8, '0')}`,
    40.70,
    -74.00,
    { updateddate: '2026-08-06T12:01:00.000Z' }
  );
  const older = index => portalPin(
    `311-${String(index + 1).padStart(8, '0')}`,
    40.70,
    -74.00,
    { updateddate: '2026-08-06T11:59:00.000Z' }
  );

  assert.equal(zoneNeedsCatchup({ pins: Array.from({ length: 99 }, (_, i) => newer(i)) }), false);
  assert.equal(zoneNeedsCatchup({ pins: Array.from({ length: 100 }, (_, i) => newer(i)) }), true);
  assert.equal(zoneNeedsCatchup({
    pins: [
      ...Array.from({ length: 90 }, (_, i) => newer(i)),
      ...Array.from({ length: 10 }, (_, i) => older(i + 90))
    ]
  }, { successWatermark: watermark }), true);
  assert.equal(zoneNeedsCatchup({
    pins: [
      ...Array.from({ length: 89 }, (_, i) => newer(i)),
      ...Array.from({ length: 11 }, (_, i) => older(i + 89))
    ]
  }, { successWatermark: watermark }), false);
  assert.equal(zoneNeedsCatchup({ pins: [newer(1)], capped: true }), true);
});
