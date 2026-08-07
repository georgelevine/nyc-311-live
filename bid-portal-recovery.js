'use strict';

const fetch = require('node-fetch');

const PORTAL_URL = 'https://portal.311.nyc.gov/entity-pin-fetch-service-requests/';
const PROBLEM_AREA_OPTIONS_URL = 'https://portal.311.nyc.gov/get-optionset-filter-options/';
const PROBLEM_OPTIONS_URL = 'https://portal.311.nyc.gov/get-lookup-filter-options/';
const PORTAL_CAP = 100;
const DEFAULT_HEADERS = Object.freeze({
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Live/1.0)',
  Referer: 'https://portal.311.nyc.gov/check-status/',
  Origin: 'https://portal.311.nyc.gov'
});

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function parsePortalArray(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {
    // Some Portal responses wrap the JSON array in otherwise non-JSON text.
  }
  const match = String(text || '').match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Portal response did not contain a record list');
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) throw new Error('Portal response was not a record list');
  return parsed;
}

function createSemaphore(limit) {
  const maximum = Math.max(1, Math.trunc(Number(limit) || 1));
  let active = 0;
  const waiting = [];
  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }
  return async operation => {
    if (active >= maximum) await new Promise(resolve => waiting.push(resolve));
    active += 1;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

function pinKey(pin) {
  const data = pin && pin.data || {};
  return String(data.srnumber || pin && pin.id || [
    pin && pin.latitude,
    pin && pin.longitude,
    data.submitteddate,
    data.problem || pin && pin.label
  ].join('|'));
}

function uniquePins(pins) {
  const unique = new Map();
  for (const pin of pins || []) unique.set(pinKey(pin), pin);
  return [...unique.values()];
}

function addDays(day, amount) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dayDistance(from, to) {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000
  );
}

function splitDateRange(from, to) {
  const leftEnd = addDays(from, Math.floor(dayDistance(from, to) / 2));
  return [
    { from, to: leftEnd },
    { from: addDays(leftEnd, 1), to }
  ];
}

function splitBbox(bbox) {
  const middleLatitude = (bbox.minlatitude + bbox.maxlatitude) / 2;
  const middleLongitude = (bbox.minlongitude + bbox.maxlongitude) / 2;
  return [
    { ...bbox, maxlatitude: middleLatitude, maxlongitude: middleLongitude },
    { ...bbox, minlongitude: middleLongitude, maxlatitude: middleLatitude },
    { ...bbox, minlatitude: middleLatitude, maxlongitude: middleLongitude },
    { ...bbox, minlatitude: middleLatitude, minlongitude: middleLongitude }
  ];
}

function nycCalendarDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('value must be a valid date');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function bidRecoveryRange(zoneState, now = new Date(), { maxDays = 2 } = {}) {
  if (!Number.isSafeInteger(maxDays) || maxDays < 1 || maxDays > 31) {
    throw new TypeError('maxDays must be an integer from 1 through 31');
  }
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) throw new TypeError('now must be a valid date');
  const prior = zoneState && zoneState.last_successful_poll_at
    ? new Date(zoneState.last_successful_poll_at)
    : null;
  if (prior && Number.isFinite(prior.getTime())) {
    const gapDays = (current.getTime() - prior.getTime()) / 86_400_000;
    if (gapDays > maxDays) {
      throw new Error(
        `Zone has been offline for ${gapDays.toFixed(2)} days; `
        + `automatic catch-up is limited to ${maxDays} days`
      );
    }
  }
  return {
    from: prior && Number.isFinite(prior.getTime())
      ? nycCalendarDay(prior)
      : nycCalendarDay(current),
    to: nycCalendarDay(current)
  };
}

function portalMapUrl({ bbox = null, from = null, to = null, filters = {} } = {}) {
  const url = new URL(PORTAL_URL);
  const parameters = { ...(bbox || {}) };
  if (from) parameters.fromdate = from;
  if (to) parameters.todate = to;
  Object.assign(parameters, filters || {});
  for (const [name, value] of Object.entries(parameters)) {
    if (value != null && String(value).trim() !== '') {
      url.searchParams.set(name, String(value));
    }
  }
  return url;
}

function createBidPortalClient({
  fetchImpl = fetch,
  headers = DEFAULT_HEADERS,
  timeoutMs = 30_000,
  concurrency = 3,
  retries = 4,
  retryBaseMs = 1000,
  onRequest = null
} = {}) {
  const withSlot = createSemaphore(concurrency);
  const diagnostics = {
    portalCalls: 0,
    retries: 0,
    cappedQueries: 0,
    spatialSplits: 0,
    problemSplits: 0
  };

  async function requestArray(url) {
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        return await withSlot(async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          try {
            diagnostics.portalCalls += 1;
            if (onRequest) onRequest(url, attempt);
            const response = await fetchImpl(url, { headers, signal: controller.signal });
            const text = await response.text();
            if (response.status === 429 || response.status >= 500) {
              const error = new Error(`Portal returned HTTP ${response.status}`);
              error.retryable = true;
              throw error;
            }
            if (!response.ok) throw new Error(`Portal returned HTTP ${response.status}`);
            return parsePortalArray(text);
          } finally {
            clearTimeout(timeout);
          }
        });
      } catch (error) {
        lastError = error;
        if (attempt >= retries) break;
        diagnostics.retries += 1;
        await sleep(retryBaseMs * (2 ** (attempt - 1)));
      }
    }
    throw lastError || new Error('Portal request failed');
  }

  async function query({ bbox = null, from = null, to = null, filters = {} } = {}) {
    return requestArray(portalMapUrl({ bbox, from, to, filters }));
  }

  let problemAreasPromise = null;
  function loadProblemAreas() {
    if (!problemAreasPromise) {
      const url = new URL(PROBLEM_AREA_OPTIONS_URL);
      url.searchParams.set('entity', 'n311_srproblem');
      url.searchParams.set('attribute', 'n311_problemareaglobal');
      problemAreasPromise = requestArray(url).then(rows => {
        const valid = rows.filter(row => row && row.value != null);
        if (!valid.length) throw new Error('Portal returned no problem-area options');
        return valid;
      });
    }
    return problemAreasPromise;
  }

  const problemOptions = new Map();
  function loadProblems(area) {
    const key = String(area.value);
    if (!problemOptions.has(key)) {
      const url = new URL(PROBLEM_OPTIONS_URL);
      const parameters = {
        lookupentity: 'n311_srproblem',
        lookupidattribute: 'n311_srproblemid',
        lookupdisplayattribute: 'n311_name',
        parentfilterattribute: 'n311_problemareaglobal',
        parentfiltervalue: key,
        type: 'problem'
      };
      for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
      problemOptions.set(key, requestArray(url).then(rows =>
        rows.filter(row => row && row.value != null)));
    }
    return problemOptions.get(key);
  }

  async function collectProblemArea(bbox, day, area) {
    const pins = await query({
      bbox, from: day, to: day, filters: { problemarea: area.value }
    });
    if (pins.length < PORTAL_CAP) return pins;
    diagnostics.cappedQueries += 1;
    const problems = await loadProblems(area);
    if (!problems.length) throw new Error(`Portal returned no problems for area ${area.value}`);
    const parts = await Promise.all(problems.map(problem => query({
      bbox,
      from: day,
      to: day,
      filters: { problemarea: area.value, problem: problem.value }
    })));
    if (parts.some(part => part.length >= PORTAL_CAP)) {
      throw new Error(`Portal problem filter remained capped on ${day}`);
    }
    const recovered = uniquePins(parts.flat());
    if (recovered.length < PORTAL_CAP) {
      throw new Error(
        `Portal problem filters recovered only ${recovered.length} capped records on ${day}`
      );
    }
    return recovered;
  }

  async function collectByProblemArea(bbox, day) {
    diagnostics.problemSplits += 1;
    const areas = await loadProblemAreas();
    const parts = await Promise.all(areas.map(area => collectProblemArea(bbox, day, area)));
    const pins = uniquePins(parts.flat());
    if (pins.length < PORTAL_CAP) {
      throw new Error(`Portal problem filters recovered only ${pins.length} capped records on ${day}`);
    }
    return pins;
  }

  async function collectTile(bbox, day, depth = 0, initialPins = null) {
    const pins = initialPins || await query({ bbox, from: day, to: day });
    if (pins.length < PORTAL_CAP) return pins;
    diagnostics.cappedQueries += 1;
    const coordinateCount = new Set(pins.map(pin => `${pin.longitude}|${pin.latitude}`)).size;
    if (coordinateCount === 1 || depth >= 7) return collectByProblemArea(bbox, day);
    diagnostics.spatialSplits += 1;
    return (await Promise.all(
      splitBbox(bbox).map(tile => collectTile(tile, day, depth + 1))
    )).flat();
  }

  async function collectRange({ bbox, from, to, initialPins = null }) {
    const pins = initialPins || await query({ bbox, from, to });
    if (pins.length < PORTAL_CAP) return uniquePins(pins);
    diagnostics.cappedQueries += 1;
    if (from === to) return uniquePins(await collectTile(bbox, from, 0, pins));
    return uniquePins((await Promise.all(
      splitDateRange(from, to).map(range => collectRange({ bbox, ...range }))
    )).flat());
  }

  return { collectRange, diagnostics, query };
}

module.exports = {
  DEFAULT_HEADERS,
  PORTAL_CAP,
  PORTAL_URL,
  addDays,
  bidRecoveryRange,
  createBidPortalClient,
  nycCalendarDay,
  parsePortalArray,
  portalMapUrl,
  splitBbox,
  splitDateRange,
  uniquePins
};
