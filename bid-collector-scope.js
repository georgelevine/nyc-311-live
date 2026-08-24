'use strict';

const crypto = require('node:crypto');
const { normalizePortalTimestamp } = require('./portal-timestamp');

const DEFAULT_COLLECTOR_SCOPE = 'bid_only';
const DEFAULT_ZONE_TARGET = 12;
const DEFAULT_PORTAL_CAP = 100;
const DEFAULT_NEARLY_ALL_RATIO = 0.9;

function collectorInteger(environment, name, {
  fallback,
  minimum,
  maximum
}) {
  const rawValue = environment && environment[name];
  const value = rawValue == null || String(rawValue).trim() === ''
    ? fallback
    : Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}`
    );
  }
  return value;
}

function parseCollectorScope(environment = process.env) {
  const rawValue = environment && typeof environment === 'object'
    ? environment.COLLECTOR_SCOPE
    : environment;
  if (rawValue == null || String(rawValue).trim() === '') return DEFAULT_COLLECTOR_SCOPE;
  const scope = String(rawValue).trim().toLowerCase();
  if (scope === 'citywide' || scope === 'bid_only') return scope;
  throw new Error(
    `Unsupported COLLECTOR_SCOPE ${JSON.stringify(rawValue)}; expected citywide or bid_only`
  );
}

function finiteNumber(value, label) {
  if (value == null || String(value).trim() === '') {
    throw new TypeError(`${label} must be a finite number`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number`);
  return number;
}

function districtValue(district, snakeName, camelName) {
  return district && district[snakeName] != null
    ? district[snakeName]
    : district && district[camelName];
}

function normalizeDistrictBounds(district, index) {
  const bidId = Number(districtValue(district, 'bid_id', 'bidId'));
  const boroughCode = Number(districtValue(district, 'borough_code', 'boroughCode'));
  if (!Number.isInteger(bidId) || bidId <= 0) {
    throw new TypeError(`BID district ${index + 1} has an invalid bid_id`);
  }
  if (!Number.isInteger(boroughCode) || boroughCode <= 0) {
    throw new TypeError(`BID ${bidId} has an invalid borough_code`);
  }
  const bbox = {
    minlongitude: finiteNumber(
      districtValue(district, 'min_longitude', 'minLongitude'),
      `BID ${bidId} min_longitude`
    ),
    minlatitude: finiteNumber(
      districtValue(district, 'min_latitude', 'minLatitude'),
      `BID ${bidId} min_latitude`
    ),
    maxlongitude: finiteNumber(
      districtValue(district, 'max_longitude', 'maxLongitude'),
      `BID ${bidId} max_longitude`
    ),
    maxlatitude: finiteNumber(
      districtValue(district, 'max_latitude', 'maxLatitude'),
      `BID ${bidId} max_latitude`
    )
  };
  if (bbox.minlongitude > bbox.maxlongitude || bbox.minlatitude > bbox.maxlatitude) {
    throw new RangeError(`BID ${bidId} has inverted bounding coordinates`);
  }
  return { bidId, boroughCode, bidIds: [bidId], boroughCodes: [boroughCode], bbox };
}

function normalizeZoneBounds(zone, index) {
  const source = zone && zone.bbox || zone;
  const label = zone && zone.zoneId || `zone ${index + 1}`;
  const bbox = {
    minlongitude: finiteNumber(
      source && (source.minlongitude ?? source.min_longitude ?? source.minLongitude),
      `${label} minlongitude`
    ),
    minlatitude: finiteNumber(
      source && (source.minlatitude ?? source.min_latitude ?? source.minLatitude),
      `${label} minlatitude`
    ),
    maxlongitude: finiteNumber(
      source && (source.maxlongitude ?? source.max_longitude ?? source.maxLongitude),
      `${label} maxlongitude`
    ),
    maxlatitude: finiteNumber(
      source && (source.maxlatitude ?? source.max_latitude ?? source.maxLatitude),
      `${label} maxlatitude`
    )
  };
  if (bbox.minlongitude > bbox.maxlongitude || bbox.minlatitude > bbox.maxlatitude) {
    throw new RangeError(`${label} has inverted bounding coordinates`);
  }
  return bbox;
}

function bboxArea(bbox) {
  return (bbox.maxlongitude - bbox.minlongitude) * (bbox.maxlatitude - bbox.minlatitude);
}

function bboxIntersectionArea(first, second) {
  const width = Math.max(
    0,
    Math.min(first.maxlongitude, second.maxlongitude)
      - Math.max(first.minlongitude, second.minlongitude)
  );
  const height = Math.max(
    0,
    Math.min(first.maxlatitude, second.maxlatitude)
      - Math.max(first.minlatitude, second.minlatitude)
  );
  return width * height;
}

function mergeBboxes(first, second) {
  return {
    minlongitude: Math.min(first.minlongitude, second.minlongitude),
    minlatitude: Math.min(first.minlatitude, second.minlatitude),
    maxlongitude: Math.max(first.maxlongitude, second.maxlongitude),
    maxlatitude: Math.max(first.maxlatitude, second.maxlatitude)
  };
}

function mergeCost(first, second) {
  const merged = mergeBboxes(first.bbox, second.bbox);
  const coveredArea = bboxArea(first.bbox) + bboxArea(second.bbox)
    - bboxIntersectionArea(first.bbox, second.bbox);
  return bboxArea(merged) - coveredArea;
}

function compareNumbers(first, second) {
  return first - second;
}

function compareArrays(first, second) {
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index += 1) {
    if (first[index] !== second[index]) return first[index] - second[index];
  }
  return first.length - second.length;
}

function compareBboxes(first, second) {
  return first.minlongitude - second.minlongitude
    || first.minlatitude - second.minlatitude
    || first.maxlongitude - second.maxlongitude
    || first.maxlatitude - second.maxlatitude;
}

function compareWorkingZones(first, second) {
  return compareArrays(first.boroughCodes, second.boroughCodes)
    || compareBboxes(first.bbox, second.bbox)
    || compareArrays(first.bidIds, second.bidIds);
}

function mergeWorkingZones(first, second) {
  const boroughCodes = [...new Set([...first.boroughCodes, ...second.boroughCodes])]
    .sort(compareNumbers);
  const bidIds = [...new Set([...first.bidIds, ...second.bidIds])].sort(compareNumbers);
  return {
    boroughCode: boroughCodes.length === 1 ? boroughCodes[0] : null,
    boroughCodes,
    bidIds,
    bbox: mergeBboxes(first.bbox, second.bbox)
  };
}

function pairTieKey(first, second) {
  return [
    ...first.boroughCodes,
    -1,
    ...first.bidIds,
    -2,
    ...second.boroughCodes,
    -3,
    ...second.bidIds
  ];
}

function compareCandidates(first, second) {
  const costDifference = first.cost - second.cost;
  if (Math.abs(costDifference) > Number.EPSILON) return costDifference;
  return compareArrays(first.tieKey, second.tieKey);
}

function buildBidQueryZones(districts, { targetCount = DEFAULT_ZONE_TARGET } = {}) {
  if (!Array.isArray(districts) || districts.length === 0) {
    throw new TypeError('At least one BID district is required to build query zones');
  }
  if (!Number.isInteger(targetCount) || targetCount <= 0) {
    throw new TypeError('targetCount must be a positive integer');
  }

  let zones = districts.map(normalizeDistrictBounds).sort(compareWorkingZones);
  const uniqueIds = new Set(zones.map(zone => zone.bidIds[0]));
  if (uniqueIds.size !== zones.length) throw new Error('BID district rows contain duplicate bid_id values');

  while (zones.length > targetCount) {
    let candidates = [];
    for (let firstIndex = 0; firstIndex < zones.length - 1; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < zones.length; secondIndex += 1) {
        const first = zones[firstIndex];
        const second = zones[secondIndex];
        if (first.boroughCode == null || first.boroughCode !== second.boroughCode) continue;
        candidates.push({
          firstIndex,
          secondIndex,
          cost: mergeCost(first, second),
          tieKey: pairTieKey(first, second)
        });
      }
    }

    // A target below the number of boroughs necessarily needs cross-borough envelopes.
    if (candidates.length === 0) {
      for (let firstIndex = 0; firstIndex < zones.length - 1; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < zones.length; secondIndex += 1) {
          const first = zones[firstIndex];
          const second = zones[secondIndex];
          candidates.push({
            firstIndex,
            secondIndex,
            cost: mergeCost(first, second),
            tieKey: pairTieKey(first, second)
          });
        }
      }
    }

    candidates.sort(compareCandidates);
    const selected = candidates[0];
    const merged = mergeWorkingZones(zones[selected.firstIndex], zones[selected.secondIndex]);
    zones = zones.filter((_, index) => (
      index !== selected.firstIndex && index !== selected.secondIndex
    ));
    zones.push(merged);
    zones.sort(compareWorkingZones);
  }

  return zones.sort(compareWorkingZones).map((zone, index) => ({
    zoneId: `bid-zone-${String(index + 1).padStart(2, '0')}`,
    boroughCode: zone.boroughCode,
    bidIds: zone.bidIds,
    bbox: zone.bbox
  }));
}

function verifyZoneCoverage(districts, zones) {
  if (!Array.isArray(districts)) throw new TypeError('districts must be an array');
  if (!Array.isArray(zones)) throw new TypeError('zones must be an array');
  const normalizedZones = zones.map(normalizeZoneBounds);
  const coveredBidIds = [];
  const uncoveredBidIds = [];
  districts.map(normalizeDistrictBounds).forEach(district => {
    const covered = normalizedZones.some(zone => (
      zone.minlongitude <= district.bbox.minlongitude
      && zone.minlatitude <= district.bbox.minlatitude
      && zone.maxlongitude >= district.bbox.maxlongitude
      && zone.maxlatitude >= district.bbox.maxlatitude
    ));
    (covered ? coveredBidIds : uncoveredBidIds).push(district.bidId);
  });
  coveredBidIds.sort(compareNumbers);
  uncoveredBidIds.sort(compareNumbers);
  return {
    ok: uncoveredBidIds.length === 0,
    coveredBidIds,
    uncoveredBidIds
  };
}

function canonicalPlan(boundaryVersion, zones) {
  if (boundaryVersion == null || String(boundaryVersion).trim() === '') {
    throw new TypeError('boundaryVersion is required for a query-plan hash');
  }
  if (!Array.isArray(zones)) throw new TypeError('zones must be an array');
  return {
    boundaryVersion: String(boundaryVersion).trim(),
    zones: zones.map((zone, index) => ({
      zoneId: String(zone && zone.zoneId || ''),
      boroughCode: zone && zone.boroughCode == null ? null : Number(zone.boroughCode),
      bidIds: [...new Set((zone && zone.bidIds || []).map(Number))].sort(compareNumbers),
      bbox: normalizeZoneBounds(zone, index)
    })).sort((first, second) => first.zoneId.localeCompare(second.zoneId)
      || compareBboxes(first.bbox, second.bbox)
      || compareArrays(first.bidIds, second.bidIds))
  };
}

function queryPlanHash(boundaryVersion, zones) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalPlan(boundaryVersion, zones)))
    .digest('hex');
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new TypeError('concurrency must be a positive integer');
  }
  if (typeof mapper !== 'function') throw new TypeError('mapper must be a function');
  if (items.length === 0) return [];

  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

function normalizeSrNumber(value) {
  if (value == null) return null;
  const match = String(value).trim().match(/^311(?:-|\s)?(\d{8})$/i);
  return match ? `311-${match[1]}` : null;
}

function pinSrNumber(pin) {
  const data = pin && pin.data || {};
  return normalizeSrNumber(
    data.srnumber
      ?? data.sr_number
      ?? (pin && pin.srnumber)
      ?? (pin && pin.sr_number)
  );
}

function canonicalizePortalPin(pin) {
  const srNumber = pinSrNumber(pin);
  if (!srNumber) return null;
  const data = pin && pin.data && typeof pin.data === 'object' ? pin.data : {};
  if (data.srnumber === srNumber) return pin;
  return { ...pin, data: { ...data, srnumber: srNumber } };
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}

const SNAPSHOT_TIME_FIELDS = Object.freeze([
  'updateddate',
  'updated_date',
  'updatedon',
  'updated_on',
  'modifiedon',
  'modified_on',
  'lastupdateddate',
  'last_updated_at',
  'submitteddate',
  'submitted_at'
]);

function parseTimestamp(value) {
  if (value == null || String(value).trim() === '') return null;
  const normalized = normalizePortalTimestamp(value);
  const timestamp = normalized == null ? Number.NaN : Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function pinSnapshotTimestamp(pin) {
  const data = pin && pin.data || {};
  const timestamps = [];
  for (const field of SNAPSHOT_TIME_FIELDS) {
    const nested = parseTimestamp(data[field]);
    const topLevel = parseTimestamp(pin && pin[field]);
    if (nested != null) timestamps.push(nested);
    if (topLevel != null) timestamps.push(topLevel);
  }
  return timestamps.length ? Math.max(...timestamps) : null;
}

function comparePinSnapshots(first, second) {
  const firstTime = pinSnapshotTimestamp(first);
  const secondTime = pinSnapshotTimestamp(second);
  if (firstTime != null || secondTime != null) {
    if (firstTime == null) return -1;
    if (secondTime == null) return 1;
    if (firstTime !== secondTime) return firstTime - secondTime;
  }
  return stableStringify(first).localeCompare(stableStringify(second));
}

function deduplicatePortalPins(pins) {
  if (!Array.isArray(pins)) throw new TypeError('pins must be an array');
  const pinsBySr = new Map();
  for (const pin of pins) {
    const canonical = canonicalizePortalPin(pin);
    if (!canonical) continue;
    const srNumber = canonical.data.srnumber;
    const prior = pinsBySr.get(srNumber);
    if (!prior || comparePinSnapshots(prior, canonical) < 0) {
      pinsBySr.set(srNumber, canonical);
    }
  }
  return [...pinsBySr.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([, pin]) => pin);
}

function optionalFiniteCoordinate(value) {
  if (value == null || String(value).trim() === '') return null;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) ? coordinate : null;
}

function filterPinsToBids(pins, matcher) {
  if (!Array.isArray(pins)) throw new TypeError('pins must be an array');
  if (!matcher || typeof matcher.match !== 'function') {
    throw new TypeError('An active BID matcher is required');
  }
  const accepted = [];
  for (const pin of pins) {
    if (!pinSrNumber(pin)) continue;
    const latitude = optionalFiniteCoordinate(pin && pin.latitude);
    const longitude = optionalFiniteCoordinate(pin && pin.longitude);
    if (latitude == null || longitude == null) continue;
    const bidMatch = matcher.match(latitude, longitude);
    if (!bidMatch || !Array.isArray(bidMatch.districts) || bidMatch.districts.length === 0) {
      continue;
    }
    accepted.push({ pin, bidMatch });
  }
  return accepted;
}

function resultPins(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.pins)) return result.pins;
  if (result && Array.isArray(result.records)) return result.records;
  return [];
}

function stateWatermark(priorState) {
  if (priorState == null) return null;
  if (typeof priorState !== 'object') return parseTimestamp(priorState);
  return parseTimestamp(
    priorState.successWatermark
      ?? priorState.watermark
      ?? priorState.last_success_watermark
      ?? priorState.lastSuccessAt
  );
}

function zoneNeedsCatchup(result, priorState = null) {
  const pins = resultPins(result);
  const cap = Number(result && !Array.isArray(result) && (result.cap ?? result.limit))
    || DEFAULT_PORTAL_CAP;
  if (result && !Array.isArray(result) && result.capped === true) return true;
  if (pins.length < cap) return false;

  const watermark = stateWatermark(priorState);
  if (watermark == null) return true;
  const ratio = Number(result && !Array.isArray(result) && result.nearlyAllRatio)
    || DEFAULT_NEARLY_ALL_RATIO;
  let newer = 0;
  let comparable = 0;
  for (const pin of pins) {
    const timestamp = pinSnapshotTimestamp(pin);
    if (timestamp == null) continue;
    comparable += 1;
    if (timestamp > watermark) newer += 1;
  }
  if (comparable < pins.length) return true;
  return newer / pins.length >= ratio;
}

function errorMessage(error) {
  return String(error && error.message || error || 'unknown error');
}

async function collectBidZonePins({
  portalClient,
  bbox,
  priorState = null,
  attemptedAt = new Date(),
  pollIntervalSeconds = 60,
  cap = DEFAULT_PORTAL_CAP,
  preferBounded = false,
  resolveRecoveryRange
}) {
  if (!portalClient || typeof portalClient.query !== 'function'
      || typeof portalClient.collectRange !== 'function') {
    throw new TypeError('portalClient must provide query and collectRange functions');
  }
  if (typeof resolveRecoveryRange !== 'function') {
    throw new TypeError('resolveRecoveryRange must be a function');
  }
  const attempted = attemptedAt instanceof Date ? attemptedAt : new Date(attemptedAt);
  if (!Number.isFinite(attempted.getTime())) {
    throw new TypeError('attemptedAt must be a valid date');
  }
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    throw new TypeError('pollIntervalSeconds must be positive');
  }

  async function recoverBounded({
    initialCount = null,
    saturated = false,
    offlineGap = false,
    recoveryReason,
    initialQueryError = null
  }) {
    const range = resolveRecoveryRange(priorState, attempted);
    let recoveredPins;
    try {
      recoveredPins = await portalClient.collectRange({
        bbox,
        from: range.from,
        to: range.to
      });
      if (!Array.isArray(recoveredPins)) {
        throw new TypeError('Portal bounded recovery must return an array');
      }
    } catch (error) {
      error.bidZoneRecovery = {
        initialCount,
        saturated,
        offlineGap,
        recoveryReason
      };
      throw error;
    }
    const watermark = parseTimestamp(range.watermark_at);
    return {
      pins: recoveredPins,
      initialCount,
      saturated,
      offlineGap,
      recovered: true,
      recoveryReason,
      initialQueryError,
      ...(watermark == null ? {} : {
        watermarkAt: new Date(watermark).toISOString(),
        caughtUp: range.caught_up !== false
      })
    };
  }

  if (preferBounded) {
    return recoverBounded({ recoveryReason: 'preferred_bounded' });
  }

  let pins;
  let initialCount = null;
  let initialQueryError = null;
  try {
    pins = await portalClient.query({ bbox });
    if (!Array.isArray(pins)) throw new TypeError('Portal zone query must return an array');
    initialCount = pins.length;
  } catch (error) {
    initialQueryError = error;
    try {
      return await recoverBounded({
        initialCount,
        recoveryReason: 'initial_query_failed',
        initialQueryError: errorMessage(initialQueryError)
      });
    } catch (recoveryError) {
      const combinedError = new Error(
        `Undated zone query failed (${errorMessage(initialQueryError)}); `
        + `bounded date recovery failed (${errorMessage(recoveryError)})`,
        { cause: recoveryError }
      );
      combinedError.bidZoneRecovery = {
        initialCount,
        saturated: false,
        offlineGap: false,
        recoveryReason: 'initial_query_failed'
      };
      throw combinedError;
    }
  }

  const saturated = zoneNeedsCatchup(
    { pins, cap },
    priorState && { successWatermark: priorState.last_successful_poll_at }
  );
  const priorSuccessMs = Date.parse(priorState && priorState.last_successful_poll_at);
  const offlineGap = Number.isFinite(priorSuccessMs)
    && attempted.getTime() - priorSuccessMs > pollIntervalSeconds * 2_000;
  if (saturated || offlineGap) {
    return recoverBounded({
      initialCount,
      saturated,
      offlineGap,
      recoveryReason: saturated ? 'saturated' : 'offline_gap'
    });
  }
  return {
    pins,
    initialCount,
    saturated,
    offlineGap,
    recovered: saturated || offlineGap,
    recoveryReason: saturated ? 'saturated' : offlineGap ? 'offline_gap' : null,
    initialQueryError: null,
    watermarkAt: attempted.toISOString(),
    caughtUp: true
  };
}

module.exports = {
  DEFAULT_COLLECTOR_SCOPE,
  buildBidQueryZones,
  canonicalizePortalPin,
  collectBidZonePins,
  collectorInteger,
  deduplicatePortalPins,
  filterPinsToBids,
  mapWithConcurrency,
  normalizeSrNumber,
  parseCollectorScope,
  queryPlanHash,
  verifyZoneCoverage,
  zoneNeedsCatchup
};
