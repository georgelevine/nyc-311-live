'use strict';

const { geometryBounds } = require('./police-precincts');

class BoundaryLookupError extends Error {
  constructor(message, statusCode, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BoundaryLookupError';
    this.statusCode = statusCode;
  }
}

function strictPositiveId(raw, { label, maxDigits }) {
  const value = String(raw == null ? '' : raw);
  if (!new RegExp(`^\\d{1,${maxDigits}}$`).test(value)) {
    throw new BoundaryLookupError(`${label} must be a positive integer`, 400);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new BoundaryLookupError(`${label} must be a positive integer`, 400);
  }
  return number;
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name));
}

function validPosition(position) {
  return Array.isArray(position) && position.length >= 2
    && position.every(ordinate => typeof ordinate === 'number' && Number.isFinite(ordinate))
    && position[0] >= -180 && position[0] <= 180
    && position[1] >= -90 && position[1] <= 90;
}

function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4 || !ring.every(validPosition)) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

function validPolygon(polygon) {
  return Array.isArray(polygon) && polygon.length > 0 && polygon.every(validRing);
}

function parseGeometry(value) {
  let geometry;
  try {
    geometry = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error('Stored boundary geometry is not valid JSON', { cause: error });
  }
  const valid = geometry && (
    (geometry.type === 'Polygon' && validPolygon(geometry.coordinates))
    || (geometry.type === 'MultiPolygon'
      && Array.isArray(geometry.coordinates)
      && geometry.coordinates.length > 0
      && geometry.coordinates.every(validPolygon))
  );
  if (!valid) throw new Error('Stored boundary geometry is not valid Polygon GeoJSON');
  return geometry;
}

function validatedBbox(row, geometry) {
  const bbox = [
    Number(row.min_longitude),
    Number(row.min_latitude),
    Number(row.max_longitude),
    Number(row.max_latitude)
  ];
  if (!bbox.every(Number.isFinite) || bbox[0] > bbox[2] || bbox[1] > bbox[3]) {
    throw new Error('Stored boundary bounding box is invalid');
  }
  const bounds = geometryBounds(geometry.coordinates);
  const calculated = [
    bounds.minLongitude,
    bounds.minLatitude,
    bounds.maxLongitude,
    bounds.maxLatitude
  ];
  if (calculated.some((value, index) => Math.abs(value - bbox[index]) > 1e-9)) {
    throw new Error('Stored boundary bounding box does not match its geometry');
  }
  return bbox;
}

function boundaryFeatureFromRow(row, kind) {
  if (!row) throw new TypeError('A boundary row is required');
  const geometry = parseGeometry(row.geometry_json);
  const bbox = validatedBbox(row, geometry);
  if (kind === 'police_precinct') {
    const precinctNumber = Number(row.precinct_number);
    if (!Number.isSafeInteger(precinctNumber) || precinctNumber <= 0
        || !String(row.label || '').trim() || !String(row.boundary_version || '').trim()) {
      throw new Error('Stored police precinct metadata is invalid');
    }
    return {
      type: 'Feature',
      id: `police-precinct:${precinctNumber}`,
      bbox,
      properties: {
        boundary_type: kind,
        boundary_version: String(row.boundary_version),
        precinct_number: precinctNumber,
        label: String(row.label)
      },
      geometry
    };
  }
  if (kind === 'business_improvement_district') {
    const bidId = Number(row.bid_id);
    const boroughCode = Number(row.borough_code);
    if (!Number.isSafeInteger(bidId) || bidId <= 0
        || !Number.isInteger(boroughCode) || boroughCode < 1 || boroughCode > 5
        || !String(row.name || '').trim() || !String(row.borough_name || '').trim()
        || !String(row.boundary_version || '').trim()) {
      throw new Error('Stored business improvement district metadata is invalid');
    }
    return {
      type: 'Feature',
      id: `bid:${bidId}`,
      bbox,
      properties: {
        boundary_type: kind,
        boundary_version: String(row.boundary_version),
        bid_id: bidId,
        name: String(row.name),
        borough_code: boroughCode,
        borough_name: String(row.borough_name)
      },
      geometry
    };
  }
  throw new TypeError(`Unsupported boundary type: ${kind}`);
}

function requireTables(database, tables, unavailableMessage) {
  if (!database || typeof database.prepare !== 'function'
      || tables.some(table => !tableExists(database, table))) {
    throw new BoundaryLookupError(unavailableMessage, 503);
  }
}

function activeCompleteVersion(database, {
  versionTable,
  boundaryTable,
  unavailableMessage
}) {
  const active = database.prepare(`
    SELECT version,feature_count FROM ${versionTable} WHERE active=1
  `).get();
  const expectedCount = active && Number(active.feature_count);
  if (!active || !Number.isSafeInteger(expectedCount) || expectedCount <= 0) {
    throw new BoundaryLookupError(unavailableMessage, 503);
  }
  const installed = database.prepare(`
    SELECT COUNT(*) AS count FROM ${boundaryTable} WHERE boundary_version=?
  `).get(active.version);
  if (!installed || Number(installed.count) !== expectedCount) {
    throw new BoundaryLookupError(unavailableMessage, 503);
  }
  return active;
}

function loadActivePolicePrecinctFeature(database, rawPrecinct) {
  const precinct = strictPositiveId(rawPrecinct, {
    label: 'Police precinct',
    maxDigits: 3
  });
  const unavailable = 'Police precinct boundaries are temporarily unavailable';
  requireTables(database, [
    'police_precincts',
    'police_precinct_boundary_versions'
  ], unavailable);
  try {
    activeCompleteVersion(database, {
      versionTable: 'police_precinct_boundary_versions',
      boundaryTable: 'police_precincts',
      unavailableMessage: unavailable
    });
    const row = database.prepare(`
      SELECT precinct.precinct_number,precinct.label,precinct.boundary_version,
             precinct.geometry_json,precinct.min_longitude,precinct.min_latitude,
             precinct.max_longitude,precinct.max_latitude
      FROM police_precincts AS precinct
      JOIN police_precinct_boundary_versions AS version
        ON version.version=precinct.boundary_version AND version.active=1
      WHERE precinct.precinct_number=?
    `).get(precinct);
    if (!row) {
      throw new BoundaryLookupError(
        `Police precinct ${precinct} is not in the active boundary release`,
        404
      );
    }
    return boundaryFeatureFromRow(row, 'police_precinct');
  } catch (error) {
    if (error instanceof BoundaryLookupError) throw error;
    throw new BoundaryLookupError(unavailable, 503, error);
  }
}

function loadActiveBusinessImprovementDistrictFeature(database, rawBidId) {
  const bidId = strictPositiveId(rawBidId, {
    label: 'Business improvement district ID',
    maxDigits: 6
  });
  const unavailable = 'Business improvement district boundaries are temporarily unavailable';
  requireTables(database, [
    'business_improvement_districts',
    'business_improvement_district_boundary_versions'
  ], unavailable);
  try {
    activeCompleteVersion(database, {
      versionTable: 'business_improvement_district_boundary_versions',
      boundaryTable: 'business_improvement_districts',
      unavailableMessage: unavailable
    });
    const row = database.prepare(`
      SELECT district.bid_id,district.name,district.borough_code,district.borough_name,
             district.boundary_version,district.geometry_json,
             district.min_longitude,district.min_latitude,
             district.max_longitude,district.max_latitude
      FROM business_improvement_districts AS district
      JOIN business_improvement_district_boundary_versions AS version
        ON version.version=district.boundary_version AND version.active=1
      WHERE district.bid_id=?
    `).get(bidId);
    if (!row) {
      throw new BoundaryLookupError(
        `BID ${bidId} is not in the active boundary release`,
        404
      );
    }
    return boundaryFeatureFromRow(row, 'business_improvement_district');
  } catch (error) {
    if (error instanceof BoundaryLookupError) throw error;
    throw new BoundaryLookupError(unavailable, 503, error);
  }
}

module.exports = {
  BoundaryLookupError,
  boundaryFeatureFromRow,
  loadActiveBusinessImprovementDistrictFeature,
  loadActivePolicePrecinctFeature,
  strictPositiveId
};
