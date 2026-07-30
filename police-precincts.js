'use strict';

const ACTIVE_VERSION_SQL = `
  SELECT version,source_url,source_sha256,source_date,imported_at,feature_count
  FROM police_precinct_boundary_versions WHERE active=1 LIMIT 1
`;

function ensureSqlitePolicePrecinctSchema(database) {
  const columns = new Set(database.prepare('PRAGMA table_info(live_portal_requests)').all()
    .map(column => column.name));
  if (!columns.has('police_precinct')) {
    database.exec('ALTER TABLE live_portal_requests ADD COLUMN police_precinct INTEGER');
  }
  if (!columns.has('police_precinct_boundary_version')) {
    database.exec('ALTER TABLE live_portal_requests ADD COLUMN police_precinct_boundary_version TEXT');
  }
  if (!columns.has('police_precinct_matched_at')) {
    database.exec('ALTER TABLE live_portal_requests ADD COLUMN police_precinct_matched_at TEXT');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS police_precinct_boundary_versions (
      version TEXT PRIMARY KEY,
      source_url TEXT NOT NULL,
      source_sha256 TEXT NOT NULL UNIQUE CHECK(length(source_sha256)=64),
      source_date TEXT,
      imported_at TEXT NOT NULL,
      feature_count INTEGER NOT NULL CHECK(feature_count>0),
      active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS police_precinct_one_active_version_idx
      ON police_precinct_boundary_versions(active) WHERE active=1;

    CREATE TABLE IF NOT EXISTS police_precincts (
      boundary_version TEXT NOT NULL,
      precinct_number INTEGER NOT NULL,
      label TEXT NOT NULL,
      geometry_json TEXT NOT NULL CHECK(json_valid(geometry_json)),
      min_longitude REAL NOT NULL,
      min_latitude REAL NOT NULL,
      max_longitude REAL NOT NULL,
      max_latitude REAL NOT NULL,
      PRIMARY KEY(boundary_version,precinct_number),
      FOREIGN KEY(boundary_version)
        REFERENCES police_precinct_boundary_versions(version) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS live_request_police_precinct_assignments (
      srnumber TEXT NOT NULL,
      boundary_version TEXT NOT NULL,
      precinct_number INTEGER,
      matched_at TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      PRIMARY KEY(srnumber,boundary_version),
      FOREIGN KEY(srnumber)
        REFERENCES live_portal_requests(srnumber) ON DELETE CASCADE,
      FOREIGN KEY(boundary_version)
        REFERENCES police_precinct_boundary_versions(version) ON DELETE CASCADE,
      FOREIGN KEY(boundary_version,precinct_number)
        REFERENCES police_precincts(boundary_version,precinct_number) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS police_precinct_bbox_idx
      ON police_precincts(boundary_version,min_longitude,max_longitude,min_latitude,max_latitude);
    CREATE INDEX IF NOT EXISTS live_request_police_precinct_assignments_version_idx
      ON live_request_police_precinct_assignments(boundary_version,srnumber);
    CREATE INDEX IF NOT EXISTS live_portal_requests_police_precinct_idx
      ON live_portal_requests(police_precinct,suffix DESC);
  `);
}

function ordinal(number) {
  const value = Number(number);
  const remainder100 = value % 100;
  const suffix = remainder100 >= 11 && remainder100 <= 13
    ? 'th'
    : value % 10 === 1 ? 'st' : value % 10 === 2 ? 'nd' : value % 10 === 3 ? 'rd' : 'th';
  return `${value}${suffix} Precinct`;
}

function geometryBounds(coordinates) {
  const bounds = {
    minLongitude: Infinity,
    minLatitude: Infinity,
    maxLongitude: -Infinity,
    maxLatitude: -Infinity
  };
  let positions = 0;
  function visit(value) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      const longitude = Number(value[0]);
      const latitude = Number(value[1]);
      bounds.minLongitude = Math.min(bounds.minLongitude, longitude);
      bounds.minLatitude = Math.min(bounds.minLatitude, latitude);
      bounds.maxLongitude = Math.max(bounds.maxLongitude, longitude);
      bounds.maxLatitude = Math.max(bounds.maxLatitude, latitude);
      positions += 1;
      return;
    }
    for (const child of value) visit(child);
  }
  visit(coordinates);
  if (!positions) throw new Error('Geometry has no valid coordinate positions');
  return bounds;
}

function normalizePrecinctCollection(collection, { expectedCount = 78 } = {}) {
  if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('Police precinct source must be a GeoJSON FeatureCollection');
  }
  if (collection.features.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} police precinct features, received ${collection.features.length}`);
  }
  const seen = new Set();
  const normalized = collection.features.map((feature, index) => {
    const precinctNumber = Number(feature && feature.properties && feature.properties.Precinct);
    const geometry = feature && feature.geometry;
    if (!Number.isInteger(precinctNumber) || precinctNumber <= 0) {
      throw new Error(`Feature ${index + 1} has an invalid Precinct identifier`);
    }
    if (seen.has(precinctNumber)) throw new Error(`Duplicate precinct ${precinctNumber}`);
    seen.add(precinctNumber);
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
      throw new Error(`Precinct ${precinctNumber} has unsupported geometry`);
    }
    const bounds = geometryBounds(geometry.coordinates);
    if (bounds.minLongitude < -75 || bounds.maxLongitude > -73
        || bounds.minLatitude < 39.5 || bounds.maxLatitude > 41.5) {
      throw new Error(`Precinct ${precinctNumber} coordinates are outside the expected NYC area`);
    }
    return {
      precinctNumber,
      label: ordinal(precinctNumber),
      geometry,
      ...bounds
    };
  });
  return normalized.sort((first, second) => first.precinctNumber - second.precinctNumber);
}

function pointOnSegment(longitude, latitude, first, second) {
  const dx = second[0] - first[0];
  const dy = second[1] - first[1];
  const cross = (longitude - first[0]) * dy - (latitude - first[1]) * dx;
  const tolerance = 1e-11 * Math.max(1, Math.abs(dx), Math.abs(dy));
  if (Math.abs(cross) > tolerance) return false;
  return longitude >= Math.min(first[0], second[0]) - tolerance
    && longitude <= Math.max(first[0], second[0]) + tolerance
    && latitude >= Math.min(first[1], second[1]) - tolerance
    && latitude <= Math.max(first[1], second[1]) + tolerance;
}

// Returns 1 inside, 0 on the boundary, and -1 outside.
function ringLocation(longitude, latitude, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const first = ring[previous];
    const second = ring[index];
    if (pointOnSegment(longitude, latitude, first, second)) return 0;
    const crosses = (first[1] > latitude) !== (second[1] > latitude)
      && longitude < ((second[0] - first[0]) * (latitude - first[1]))
        / (second[1] - first[1]) + first[0];
    if (crosses) inside = !inside;
  }
  return inside ? 1 : -1;
}

function polygonCovers(longitude, latitude, rings) {
  if (!Array.isArray(rings) || !rings.length) return false;
  const exterior = ringLocation(longitude, latitude, rings[0]);
  if (exterior === -1) return false;
  if (exterior === 0) return true;
  for (const hole of rings.slice(1)) {
    const location = ringLocation(longitude, latitude, hole);
    if (location === 0) return true;
    if (location === 1) return false;
  }
  return true;
}

function geometryCovers(geometry, longitude, latitude) {
  if (geometry.type === 'Polygon') {
    return polygonCovers(longitude, latitude, geometry.coordinates);
  }
  return geometry.coordinates.some(polygon => polygonCovers(longitude, latitude, polygon));
}

class PolicePrecinctMatcher {
  constructor(version, precincts) {
    this.version = version;
    this.precincts = precincts.map(precinct => ({
      ...precinct,
      geometry: typeof precinct.geometry_json === 'string'
        ? JSON.parse(precinct.geometry_json)
        : precinct.geometry
    }));
  }

  match(latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const matches = this.precincts.filter(precinct =>
      lon >= precinct.min_longitude && lon <= precinct.max_longitude
      && lat >= precinct.min_latitude && lat <= precinct.max_latitude
      && geometryCovers(precinct.geometry, lon, lat));
    if (!matches.length) return null;
    matches.sort((first, second) => first.precinct_number - second.precinct_number);
    return {
      precinctNumber: matches[0].precinct_number,
      boundaryVersion: this.version,
      ambiguous: matches.length > 1
    };
  }
}

function loadActivePolicePrecinctMatcher(database) {
  ensureSqlitePolicePrecinctSchema(database);
  const active = database.prepare(ACTIVE_VERSION_SQL).get();
  if (!active) return null;
  const rows = database.prepare(`
    SELECT precinct_number,geometry_json,min_longitude,min_latitude,max_longitude,max_latitude
    FROM police_precincts WHERE boundary_version=? ORDER BY precinct_number
  `).all(active.version);
  if (rows.length !== Number(active.feature_count)) {
    throw new Error(`Active precinct boundary ${active.version} is incomplete`);
  }
  return new PolicePrecinctMatcher(active.version, rows);
}

module.exports = {
  ACTIVE_VERSION_SQL,
  PolicePrecinctMatcher,
  ensureSqlitePolicePrecinctSchema,
  geometryBounds,
  geometryCovers,
  loadActivePolicePrecinctMatcher,
  normalizePrecinctCollection,
  ordinal
};
