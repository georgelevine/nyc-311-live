'use strict';

const { geometryBounds, geometryCovers } = require('./police-precincts');

const ACTIVE_VERSION_SQL = `
  SELECT version,source_url,source_sha256,source_date,imported_at,feature_count
  FROM business_improvement_district_boundary_versions WHERE active=1 LIMIT 1
`;

const BOROUGH_NAMES = Object.freeze({
  1: 'Manhattan',
  2: 'Bronx',
  3: 'Brooklyn',
  4: 'Queens',
  5: 'Staten Island'
});

function ensureSqliteBusinessImprovementDistrictSchema(database) {
  const columns = new Set(database.prepare('PRAGMA table_info(live_portal_requests)').all()
    .map(column => column.name));
  if (!columns.has('business_improvement_district_boundary_version')) {
    database.exec('ALTER TABLE live_portal_requests ADD COLUMN business_improvement_district_boundary_version TEXT');
  }
  if (!columns.has('business_improvement_district_matched_at')) {
    database.exec('ALTER TABLE live_portal_requests ADD COLUMN business_improvement_district_matched_at TEXT');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS business_improvement_district_boundary_versions (
      version TEXT PRIMARY KEY,
      source_url TEXT NOT NULL,
      source_sha256 TEXT NOT NULL UNIQUE CHECK(length(source_sha256)=64),
      source_date TEXT,
      imported_at TEXT NOT NULL,
      feature_count INTEGER NOT NULL CHECK(feature_count>0),
      active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS business_improvement_district_one_active_version_idx
      ON business_improvement_district_boundary_versions(active) WHERE active=1;

    CREATE TABLE IF NOT EXISTS business_improvement_districts (
      boundary_version TEXT NOT NULL,
      bid_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      borough_code INTEGER NOT NULL CHECK(borough_code BETWEEN 1 AND 5),
      borough_name TEXT NOT NULL,
      geometry_json TEXT NOT NULL CHECK(json_valid(geometry_json)),
      min_longitude REAL NOT NULL,
      min_latitude REAL NOT NULL,
      max_longitude REAL NOT NULL,
      max_latitude REAL NOT NULL,
      PRIMARY KEY(boundary_version,bid_id),
      FOREIGN KEY(boundary_version)
        REFERENCES business_improvement_district_boundary_versions(version) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS live_request_bid_memberships (
      srnumber TEXT NOT NULL,
      boundary_version TEXT NOT NULL,
      bid_id INTEGER NOT NULL,
      matched_at TEXT NOT NULL,
      PRIMARY KEY(srnumber,boundary_version,bid_id),
      FOREIGN KEY(srnumber)
        REFERENCES live_portal_requests(srnumber) ON DELETE CASCADE,
      FOREIGN KEY(boundary_version,bid_id)
        REFERENCES business_improvement_districts(boundary_version,bid_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS business_improvement_district_bbox_idx
      ON business_improvement_districts(
        boundary_version,min_longitude,max_longitude,min_latitude,max_latitude
      );
    CREATE INDEX IF NOT EXISTS live_request_bid_memberships_district_idx
      ON live_request_bid_memberships(boundary_version,bid_id,srnumber);
  `);
}

function cleanName(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizeBusinessImprovementDistrictCollection(collection, { expectedCount = 78 } = {}) {
  if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('Business improvement district source must be a GeoJSON FeatureCollection');
  }
  if (collection.features.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} business improvement district features, received ${collection.features.length}`
    );
  }
  const seen = new Set();
  const normalized = collection.features.map((feature, index) => {
    const properties = feature && feature.properties || {};
    const bidId = Number(properties.BIDID);
    const name = cleanName(properties.BID);
    const boroughCode = Number(properties.BOROUGH);
    const geometry = feature && feature.geometry;
    if (!Number.isInteger(bidId) || bidId <= 0) {
      throw new Error(`Feature ${index + 1} has an invalid BIDID`);
    }
    if (seen.has(bidId)) throw new Error(`Duplicate BIDID ${bidId}`);
    seen.add(bidId);
    if (!name) throw new Error(`BID ${bidId} has no name`);
    if (!Object.hasOwn(BOROUGH_NAMES, boroughCode)) {
      throw new Error(`BID ${bidId} has an invalid BOROUGH code`);
    }
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
      throw new Error(`BID ${bidId} has unsupported geometry`);
    }
    const bounds = geometryBounds(geometry.coordinates);
    if (bounds.minLongitude < -75 || bounds.maxLongitude > -73
        || bounds.minLatitude < 39.5 || bounds.maxLatitude > 41.5) {
      throw new Error(`BID ${bidId} coordinates are outside the expected NYC area`);
    }
    return {
      bidId,
      name,
      boroughCode,
      boroughName: BOROUGH_NAMES[boroughCode],
      geometry,
      ...bounds
    };
  });
  return normalized.sort((first, second) => first.bidId - second.bidId);
}

class BusinessImprovementDistrictMatcher {
  constructor(version, districts) {
    this.version = version;
    this.districts = districts.map(district => ({
      ...district,
      geometry: typeof district.geometry_json === 'string'
        ? JSON.parse(district.geometry_json)
        : district.geometry
    }));
  }

  match(latitude, longitude) {
    if (latitude == null || longitude == null
        || String(latitude).trim() === '' || String(longitude).trim() === '') return null;
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const matches = this.districts.filter(district =>
      lon >= district.min_longitude && lon <= district.max_longitude
      && lat >= district.min_latitude && lat <= district.max_latitude
      && geometryCovers(district.geometry, lon, lat));
    matches.sort((first, second) => first.bid_id - second.bid_id);
    return {
      boundaryVersion: this.version,
      ambiguous: matches.length > 1,
      districts: matches.map(district => ({
        bidId: district.bid_id,
        name: district.name,
        boroughCode: district.borough_code,
        boroughName: district.borough_name
      }))
    };
  }
}

function loadActiveBusinessImprovementDistrictMatcher(database) {
  ensureSqliteBusinessImprovementDistrictSchema(database);
  const active = database.prepare(ACTIVE_VERSION_SQL).get();
  if (!active) return null;
  const rows = database.prepare(`
    SELECT bid_id,name,borough_code,borough_name,geometry_json,
           min_longitude,min_latitude,max_longitude,max_latitude
    FROM business_improvement_districts
    WHERE boundary_version=? ORDER BY bid_id
  `).all(active.version);
  if (rows.length !== Number(active.feature_count)) {
    throw new Error(`Active business improvement district boundary ${active.version} is incomplete`);
  }
  return new BusinessImprovementDistrictMatcher(active.version, rows);
}

module.exports = {
  ACTIVE_VERSION_SQL,
  BOROUGH_NAMES,
  BusinessImprovementDistrictMatcher,
  cleanName,
  ensureSqliteBusinessImprovementDistrictSchema,
  loadActiveBusinessImprovementDistrictMatcher,
  normalizeBusinessImprovementDistrictCollection
};
