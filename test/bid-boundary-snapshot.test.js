'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SNAPSHOT_PATH = path.join(
  __dirname,
  '..',
  'exports',
  'nyc-bid-boundaries-2026-04-28.geojson'
);
const SNAPSHOT_SHA256 = 'c8c06c9ecb8b733aa829c9907e918e153c9a4230fa796d228ad3f27042208a9f';

test('pinned BID boundary snapshot matches the verified April 28 release', () => {
  const bytes = fs.readFileSync(SNAPSHOT_PATH);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const collection = JSON.parse(bytes.toString('utf8'));

  assert.equal(digest, SNAPSHOT_SHA256);
  assert.equal(collection.type, 'FeatureCollection');
  assert.equal(collection.metadata.boundary_version, '2026-04-28');
  assert.equal(collection.metadata.coordinate_reference_system, 'EPSG:4326');
  assert.equal(collection.features.length, 78);

  const ids = new Set();
  for (const feature of collection.features) {
    assert.equal(feature.type, 'Feature');
    assert.ok(['Polygon', 'MultiPolygon'].includes(feature.geometry.type));
    assert.equal(feature.properties.boundary_version, '2026-04-28');
    assert.ok(Number.isInteger(feature.properties.bid_id));
    assert.ok(feature.properties.name);
    assert.ok(feature.properties.borough);
    ids.add(feature.properties.bid_id);
  }
  assert.equal(ids.size, 78);
});
