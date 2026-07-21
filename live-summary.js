'use strict';

const { coordinateValue } = require('./live-map-data');
const { normalizePortalTimestamp } = require('./portal-timestamp');

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const BOROUGH_NAMES = Object.freeze({
  manhattan: 'Manhattan',
  bronx: 'Bronx',
  brooklyn: 'Brooklyn',
  queens: 'Queens',
  'staten is': 'Staten Island',
  'staten island': 'Staten Island'
});
const nameCollator = new Intl.Collator('en-US', {
  numeric: true,
  sensitivity: 'base'
});

function finiteTimestamp(value) {
  const normalized = normalizePortalTimestamp(value);
  if (!normalized) return null;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function positiveNumber(value, name, { allowZero = false, integer = false } = {}) {
  const number = Number(value);
  const minimumOkay = allowZero ? number >= 0 : number > 0;
  if (!Number.isFinite(number) || !minimumOkay || (integer && !Number.isInteger(number))) {
    throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'}${integer ? ' integer' : ''} number`);
  }
  return number;
}

function compareNames(first, second) {
  return nameCollator.compare(first, second) || String(first).localeCompare(String(second), 'en-US');
}

function normalizedText(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

function representativeLabel(variants) {
  return [...variants.entries()]
    .sort((first, second) => second[1] - first[1] || compareNames(first[0], second[0]))[0][0];
}

function distribution(rows, valueForRow, limit) {
  const groups = new Map();
  let unknown = 0;

  for (const row of rows) {
    const value = normalizedText(valueForRow(row));
    if (value == null) {
      unknown += 1;
      continue;
    }
    const key = value.toLocaleLowerCase('en-US');
    let group = groups.get(key);
    if (!group) {
      group = { count: 0, variants: new Map() };
      groups.set(key, group);
    }
    group.count += 1;
    group.variants.set(value, (group.variants.get(value) || 0) + 1);
  }

  const ranked = [...groups.entries()].map(([key, group]) => ({
    name: representativeLabel(group.variants),
    count: group.count
  })).sort((first, second) => second.count - first.count || compareNames(first.name, second.name));

  const top = ranked.slice(0, limit);
  const remainder = ranked.slice(limit);
  return {
    top,
    other: {
      requests: remainder.reduce((total, item) => total + item.count, 0),
      categories: remainder.length
    },
    distinct: ranked.length,
    unknown
  };
}

function explicitPortalBorough(address) {
  const text = normalizedText(address);
  if (!text) return null;
  const match = text.match(/,\s*(MANHATTAN|BRONX|BROOKLYN|QUEENS|STATEN IS(?:LAND)?)\s*(?:\([^()]+\))?\s*,\s*NY(?=\s*(?:,|$))/i);
  return match ? BOROUGH_NAMES[match[1].toLocaleLowerCase('en-US')] : null;
}

function isMapSource(row) {
  return normalizedText(row && row.source)?.toLocaleLowerCase('en-US') === 'map';
}

function hasLoadedDetails(row) {
  const value = row && row.details_loaded;
  const text = String(value == null ? '' : value).trim().toLocaleLowerCase('en-US');
  return value === true || value === 1 || text === '1' || text === 'true';
}

function hasDisplayableMapPin(row) {
  return coordinateValue(row && row.latitude, -90, 90) != null
    && coordinateValue(row && row.longitude, -180, 180) != null;
}

function coverage(rows) {
  const total = rows.length;
  const detailsLoaded = rows.reduce((count, row) => count + Number(hasLoadedDetails(row)), 0);
  const mapped = rows.reduce((count, row) => count + Number(hasDisplayableMapPin(row)), 0);
  return {
    details: {
      loaded: detailsLoaded,
      pending: total - detailsLoaded,
      rate: total ? detailsLoaded / total : null
    },
    map: {
      mapped,
      unmapped: total - mapped,
      rate: total ? mapped / total : null
    }
  };
}

function windowDescriptor(start, end, rows, { completeness, sourceScope }) {
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    requests: rows.length,
    provisional: completeness !== 'complete',
    completeness,
    source_scope: sourceScope
  };
}

function change(currentCount, previousCount) {
  const absolute = currentCount - previousCount;
  return {
    absolute,
    percent: previousCount === 0
      ? null
      : Math.round((absolute / previousCount) * 1000) / 10,
    direction: absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat'
  };
}

function profile(rows, { topCategoryLimit, topBoroughLimit }) {
  return {
    categories: distribution(rows, row => row && row.problem, topCategoryLimit),
    boroughs: distribution(rows, row => explicitPortalBorough(row && row.address), topBoroughLimit),
    coverage: coverage(rows)
  };
}

function archiveHistory(oldestSubmittedAt, asOf, targetDays) {
  const oldest = finiteTimestamp(oldestSubmittedAt);
  const elapsed = oldest == null ? 0 : Math.max(0, asOf - oldest);
  const spanDays = Math.floor(elapsed / DAY_MS);
  return {
    span_days: spanDays,
    target_days: targetDays,
    target_reached: spanDays >= targetDays,
    continuity_verified: false
  };
}

/**
 * Build deterministic rolling statistics from effective Portal records.
 *
 * Recent windows intentionally include only map discoveries. Number-audit
 * discoveries arrive later and would otherwise make the newest window look
 * artificially quiet. The delayed window includes both captured Portal
 * discovery sources after the normal audit delay, but it is not described as
 * complete because an audit backlog or an offline period can extend that lag.
 */
function buildLiveSummary(rows, {
  asOf,
  windowMinutes = 15,
  topCategoryLimit = 3,
  topBoroughLimit = 3,
  oldestSubmittedAt = null,
  historyTargetDays = 14,
  auditDelayMinutes = 35,
  maturityBufferMinutes = 10
} = {}) {
  const asOfMs = finiteTimestamp(asOf);
  if (asOfMs == null) throw new TypeError('asOf must be a valid timestamp');

  const durationMs = positiveNumber(windowMinutes, 'windowMinutes') * MINUTE_MS;
  const categoryLimit = positiveNumber(topCategoryLimit, 'topCategoryLimit', {
    allowZero: true,
    integer: true
  });
  const boroughLimit = positiveNumber(topBoroughLimit, 'topBoroughLimit', {
    allowZero: true,
    integer: true
  });
  const targetDays = positiveNumber(historyTargetDays, 'historyTargetDays', {
    allowZero: true,
    integer: true
  });
  const auditDelay = positiveNumber(auditDelayMinutes, 'auditDelayMinutes', { allowZero: true });
  const maturityBuffer = positiveNumber(maturityBufferMinutes, 'maturityBufferMinutes', { allowZero: true });

  const currentStart = asOfMs - durationMs;
  const previousStart = currentStart - durationMs;
  const delayedLagMs = (auditDelay + maturityBuffer) * MINUTE_MS;
  const delayedEnd = asOfMs - delayedLagMs;
  const delayedStart = delayedEnd - durationMs;
  const currentRows = [];
  const previousRows = [];
  const delayedRows = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const submittedAt = finiteTimestamp(row && row.submitted_at);
    if (submittedAt == null) continue;

    if (isMapSource(row)) {
      if (submittedAt >= currentStart && submittedAt < asOfMs) currentRows.push(row);
      else if (submittedAt >= previousStart && submittedAt < currentStart) previousRows.push(row);
    }
    if (submittedAt >= delayedStart && submittedAt < delayedEnd) delayedRows.push(row);
  }

  const currentProfile = profile(currentRows, {
    topCategoryLimit: categoryLimit,
    topBoroughLimit: boroughLimit
  });
  const delayedProfile = profile(delayedRows, {
    topCategoryLimit: categoryLimit,
    topBoroughLimit: boroughLimit
  });

  return {
    as_of: new Date(asOfMs).toISOString(),
    basis: 'submitted_at',
    window_minutes: durationMs / MINUTE_MS,
    current: windowDescriptor(currentStart, asOfMs, currentRows, {
      completeness: 'provisional_map_feed',
      sourceScope: 'portal_map_feed'
    }),
    previous: windowDescriptor(previousStart, currentStart, previousRows, {
      completeness: 'provisional_map_feed',
      sourceScope: 'portal_map_feed'
    }),
    change: change(currentRows.length, previousRows.length),
    ...currentProfile,
    delayed: {
      ...windowDescriptor(delayedStart, delayedEnd, delayedRows, {
        completeness: 'audit_eligible_unverified',
        sourceScope: 'portal_map_and_number_audit'
      }),
      ...delayedProfile
    },
    completeness: {
      current: 'provisional_map_feed',
      previous: 'provisional_map_feed',
      delayed: 'audit_eligible_unverified',
      audit_delay_minutes: auditDelay,
      maturity_buffer_minutes: maturityBuffer
    },
    history: archiveHistory(oldestSubmittedAt, asOfMs, targetDays)
  };
}

module.exports = {
  buildLiveSummary,
  explicitPortalBorough
};
