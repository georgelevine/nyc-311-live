'use strict';

const { currentLifecycleProjection } = require('./record-availability');

const MAP_RECORD_FIELDS = Object.freeze([
  'srnumber',
  'suffix',
  'problem',
  'problem_details',
  'address',
  'borough',
  'incident_zip',
  'police_precinct',
  'police_precinct_boundary_version',
  'business_improvement_district_ids',
  'business_improvement_district_boundary_version',
  'latitude',
  'longitude',
  'submitted_at',
  'status',
  'portal_url',
  'first_seen_at',
  'last_seen_at',
  'details_fetched_at',
  'followup_state',
  'next_check_at',
  'finalized_at'
]);

function textValue(...values) {
  for (const value of values) {
    if (value == null || String(value).trim() === '') continue;
    return String(value).trim();
  }
  return null;
}

function timestampValue(...values) {
  for (const value of values) {
    if (value == null || String(value).trim() === '') continue;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    return String(value).trim();
  }
  return null;
}

function validTimestampValue(...values) {
  for (const value of values) {
    if (value == null || String(value).trim() === '') continue;
    if (value instanceof Date) {
      if (!Number.isNaN(value.getTime())) return value.toISOString();
      continue;
    }
    const text = String(value).trim();
    if (!Number.isNaN(Date.parse(text))) return text;
  }
  return null;
}

function mapSubmittedSince(value) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) {
    throw new TypeError('submitted_since must be an ISO UTC timestamp');
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    throw new TypeError('submitted_since must be an ISO UTC timestamp');
  }
  return text;
}

function suffixValue(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function precinctValue(value) {
  const number = suffixValue(value);
  return number != null && number > 0 ? number : null;
}

function businessImprovementDistrictIds(value) {
  let items = value;
  if (typeof value === 'string') {
    try {
      items = JSON.parse(value);
    } catch (_) {
      items = [];
    }
  }
  if (!Array.isArray(items)) return [];
  return [...new Set(items.map(suffixValue).filter(number => number != null && number > 0))]
    .sort((first, second) => first - second);
}

function coordinateValue(value, minimum, maximum) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : null;
}

function portalUrl(row) {
  const stored = textValue(row.portal_url, row.detail_portal_url);
  if (stored) return stored;
  const portalId = textValue(row.portal_id, row.detail_portal_id);
  return portalId
    ? `https://portal.311.nyc.gov/sr-details/?id=${encodeURIComponent(portalId)}`
    : null;
}

function projectLiveMapRow(row) {
  const latitude = coordinateValue(row && row.latitude, -90, 90);
  const longitude = coordinateValue(row && row.longitude, -180, 180);
  if (latitude == null || longitude == null) return null;

  const rawStatus = textValue(row.status, row.detail_status);
  const lifecycle = currentLifecycleProjection({
    status: rawStatus,
    followup_state: row.followup_state,
    date_closed: timestampValue(row.detail_date_closed),
    closure_cycle_tracking: row.closure_cycle_tracking === true
      || row.closure_cycle_tracking === 1,
    current_cycle_date_closed: timestampValue(row.current_cycle_date_closed)
  });

  return {
    srnumber: textValue(row.srnumber),
    suffix: suffixValue(row.suffix),
    problem: textValue(row.problem, row.detail_problem),
    problem_details: textValue(row.problem_details),
    address: textValue(row.address, row.detail_address),
    borough: textValue(row.borough),
    incident_zip: textValue(row.incident_zip),
    police_precinct: precinctValue(row.police_precinct),
    police_precinct_boundary_version: textValue(row.police_precinct_boundary_version),
    business_improvement_district_ids: businessImprovementDistrictIds(
      row.business_improvement_district_ids
    ),
    business_improvement_district_boundary_version: textValue(
      row.business_improvement_district_boundary_version
    ),
    latitude,
    longitude,
    submitted_at: validTimestampValue(row.submitted_at, row.detail_date_reported),
    status: textValue(lifecycle.status),
    portal_url: portalUrl(row),
    first_seen_at: timestampValue(row.first_seen_at),
    last_seen_at: timestampValue(row.last_seen_at),
    details_fetched_at: timestampValue(row.details_fetched_at),
    followup_state: textValue(row.followup_state),
    next_check_at: timestampValue(row.next_check_at),
    finalized_at: timestampValue(row.finalized_at)
  };
}

function compareMapRecords(first, second) {
  const firstSuffix = first.suffix == null ? Number.NEGATIVE_INFINITY : first.suffix;
  const secondSuffix = second.suffix == null ? Number.NEGATIVE_INFINITY : second.suffix;
  if (firstSuffix !== secondSuffix) return secondSuffix - firstSuffix;
  return String(first.srnumber || '').localeCompare(String(second.srnumber || ''));
}

/**
 * `/api/live-map` projects coordinate-bearing archive rows. The endpoint may
 * apply an explicit caller-supplied submitted-time floor and cursor, but it
 * never invents coordinates or silently caps the requested window.
 */
function nonNegativeCount(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function buildLiveMapPayload(rows, suppliedStats = null) {
  const source = Array.isArray(rows) ? rows : [];
  const records = source.map(projectLiveMapRow).filter(Boolean).sort(compareMapRecords);
  const total = nonNegativeCount(suppliedStats && suppliedStats.total, source.length);
  const mappedTotal = nonNegativeCount(
    suppliedStats && suppliedStats.mapped_total,
    records.length
  );
  return {
    records,
    stats: {
      total,
      mapped_total: mappedTotal,
      unmapped_total: nonNegativeCount(
        suppliedStats && suppliedStats.unmapped_total,
        Math.max(0, total - mappedTotal)
      )
    }
  };
}

module.exports = {
  MAP_RECORD_FIELDS,
  businessImprovementDistrictIds,
  buildLiveMapPayload,
  coordinateValue,
  mapSubmittedSince,
  projectLiveMapRow,
  suffixValue,
  timestampValue,
  validTimestampValue
};
