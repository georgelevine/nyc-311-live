'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  featureContainsPoint,
  parseArguments,
  splitDateRange
} = require('../scripts/export-sr-bids');

test('splitDateRange produces adjacent inclusive ranges', () => {
  assert.deepEqual(splitDateRange('2026-01-01', '2026-01-04'), [
    { from: '2026-01-01', to: '2026-01-02' },
    { from: '2026-01-03', to: '2026-01-04' }
  ]);
});

test('featureContainsPoint respects polygon holes and multipolygons', () => {
  const polygon = {
    geometry: {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
      ]
    }
  };
  assert.equal(featureContainsPoint(polygon, 2, 2), true);
  assert.equal(featureContainsPoint(polygon, 5, 5), false);
  assert.equal(featureContainsPoint(polygon, 12, 2), false);

  const multiPolygon = {
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        [[[3, 3], [4, 3], [4, 4], [3, 4], [3, 3]]]
      ]
    }
  };
  assert.equal(featureContainsPoint(multiPolygon, 3.5, 3.5), true);
});

test('parseArguments builds a dated default output and validates the range', () => {
  const options = parseArguments([], new Date('2026-08-04T12:00:00.000Z'));
  assert.equal(options.from, '2026-01-01');
  assert.equal(options.to, '2026-08-04');
  assert.match(options.output, /sr-bid-memberships-2026-01-01-to-2026-08-04\.csv$/);
  assert.throws(
    () => parseArguments(['--from', '2026-08-05', '--to', '2026-08-04']),
    /must not be after/
  );
});
