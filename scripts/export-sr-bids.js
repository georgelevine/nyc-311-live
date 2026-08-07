#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { normalizePortalTimestamp } = require('../portal-timestamp');

const PORTAL_URL = 'https://portal.311.nyc.gov/entity-pin-fetch-service-requests/';
const PROBLEM_AREA_OPTIONS_URL = 'https://portal.311.nyc.gov/get-optionset-filter-options/';
const PROBLEM_OPTIONS_URL = 'https://portal.311.nyc.gov/get-lookup-filter-options/';
const PORTAL_CAP = 100;
const DEFAULT_BOUNDARIES = path.resolve(
  __dirname,
  '..',
  'public',
  'data',
  'nyc-bid-boundaries-2026-04-28.geojson'
);
const PORTAL_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Export/1.0)',
  Referer: 'https://portal.311.nyc.gov/check-status/',
  Origin: 'https://portal.311.nyc.gov'
};

function usage() {
  return `Usage: node scripts/export-sr-bids.js [options]

Options:
  --from YYYY-MM-DD       First submitted day (default: January 1 this year)
  --to YYYY-MM-DD         Last submitted day, inclusive (default: today)
  --boundaries PATH       Official BID GeoJSON snapshot
  --output PATH           Destination CSV
  --concurrency NUMBER    Maximum simultaneous Portal requests (default: 8)
  --bid-workers NUMBER    BIDs processed simultaneously (default: 4)
  --request-timeout MS    Per-request timeout (default: 45000)
  --keep-checkpoint       Keep resumable per-BID files after success
  --help                  Show this help
`;
}

function isoDay(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new Error(`${label} must use YYYY-MM-DD format`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a valid calendar day`);
  }
  return value;
}

function positiveInteger(value, label, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return number;
}

function parseArguments(argv, now = new Date()) {
  const year = now.getUTCFullYear();
  const options = {
    from: `${year}-01-01`,
    to: now.toISOString().slice(0, 10),
    boundaries: DEFAULT_BOUNDARIES,
    output: null,
    concurrency: 8,
    bidWorkers: 4,
    requestTimeoutMs: 45000,
    keepCheckpoint: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value`);
      return argv[index];
    };
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--from') options.from = next();
    else if (argument === '--to') options.to = next();
    else if (argument === '--boundaries') options.boundaries = path.resolve(next());
    else if (argument === '--output') options.output = path.resolve(next());
    else if (argument === '--concurrency') options.concurrency = positiveInteger(next(), argument, 16);
    else if (argument === '--bid-workers') options.bidWorkers = positiveInteger(next(), argument, 16);
    else if (argument === '--request-timeout') {
      options.requestTimeoutMs = positiveInteger(next(), argument, 120000);
    } else if (argument === '--keep-checkpoint') options.keepCheckpoint = true;
    else throw new Error(`Unknown option: ${argument}`);
  }

  options.from = isoDay(options.from, '--from');
  options.to = isoDay(options.to, '--to');
  if (options.from > options.to) throw new Error('--from must not be after --to');
  if (!options.output) {
    options.output = path.resolve(
      'exports',
      `sr-bid-memberships-${options.from}-to-${options.to}.csv`
    );
  }
  return options;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function geometryPoints(value, points = []) {
  if (!Array.isArray(value)) return points;
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    points.push([Number(value[0]), Number(value[1])]);
    return points;
  }
  value.forEach(item => geometryPoints(item, points));
  return points;
}

function featureBbox(feature) {
  const points = geometryPoints(feature.geometry && feature.geometry.coordinates);
  if (!points.length) throw new Error(`BID ${feature.properties && feature.properties.bid_id} has no coordinates`);
  const longitudes = points.map(point => point[0]);
  const latitudes = points.map(point => point[1]);
  const epsilon = 0.000001;
  return {
    minlongitude: Math.min(...longitudes) - epsilon,
    minlatitude: Math.min(...latitudes) - epsilon,
    maxlongitude: Math.max(...longitudes) + epsilon,
    maxlatitude: Math.max(...latitudes) + epsilon
  };
}

function pointOnSegment(point, start, end) {
  const [x, y] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  if (Math.abs(cross) > 1e-11) return false;
  return x >= Math.min(x1, x2) - 1e-11
    && x <= Math.max(x1, x2) + 1e-11
    && y >= Math.min(y1, y2) - 1e-11
    && y <= Math.max(y1, y2) + 1e-11;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];
    if (pointOnSegment(point, previousPoint, currentPoint)) return true;
    const crosses = (currentPoint[1] > point[1]) !== (previousPoint[1] > point[1]);
    if (crosses) {
      const crossingLongitude = ((previousPoint[0] - currentPoint[0])
        * (point[1] - currentPoint[1]))
        / (previousPoint[1] - currentPoint[1]) + currentPoint[0];
      if (point[0] < crossingLongitude) inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(point, rings) {
  if (!rings.length || !pointInRing(point, rings[0])) return false;
  return !rings.slice(1).some(ring => pointInRing(point, ring));
}

function featureContainsPoint(feature, longitude, latitude) {
  const geometry = feature.geometry || {};
  const point = [longitude, latitude];
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates || []);
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates || []).some(polygon => pointInPolygon(point, polygon));
  }
  return false;
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
  const distance = dayDistance(from, to);
  const leftEnd = addDays(from, Math.floor(distance / 2));
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

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  return async function withSlot(operation) {
    if (active >= limit) await new Promise(resolve => queue.push(resolve));
    active += 1;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function parsePortalResponse(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Portal response was not valid JSON');
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  }
}

function normalizePin(pin) {
  const data = pin && pin.data || {};
  const latitude = Number(pin && pin.latitude);
  const longitude = Number(pin && pin.longitude);
  return {
    id: pin && pin.id || null,
    sr_number: data.srnumber || null,
    submitted_at: normalizePortalTimestamp(data.submitteddate),
    status: data.status || null,
    problem: data.problem || pin && pin.label || null,
    address: data.address || pin && pin.sublabel || null,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    portal_url: pin && pin.id
      ? `https://portal.311.nyc.gov/sr-details/?id=${pin.id}`
      : null
  };
}

function pinKey(pin) {
  return pin.sr_number || pin.id
    || `${pin.latitude}|${pin.longitude}|${pin.submitted_at}|${pin.problem}`;
}

async function mapLimit(items, limit, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function csvCell(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return 'unknown';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const boundaryBuffer = fs.readFileSync(options.boundaries);
  const collection = JSON.parse(boundaryBuffer);
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('Boundary file must be a GeoJSON FeatureCollection');
  }
  const boundaryVersion = collection.metadata && collection.metadata.boundary_version
    || collection.features[0] && collection.features[0].properties
      && collection.features[0].properties.boundary_version
    || 'unknown';
  const boundarySha256 = sha256(boundaryBuffer);
  const features = collection.features.slice().sort((left, right) =>
    Number(left.properties.bid_id) - Number(right.properties.bid_id));

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  const checkpointDirectory = `${options.output}.checkpoint`;
  fs.mkdirSync(checkpointDirectory, { recursive: true });
  const withPortalSlot = createSemaphore(options.concurrency);
  const startedAt = Date.now();
  const totals = {
    portalCalls: 0,
    cappedQueries: 0,
    problemAreaSplits: 0,
    retries: 0,
    resumedBids: 0,
    missingSrNumbers: 0
  };

  async function requestPortalArray(url) {
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await withPortalSlot(async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
          try {
            totals.portalCalls += 1;
            const response = await fetch(url, {
              headers: PORTAL_HEADERS,
              signal: controller.signal
            });
            const text = await response.text();
            if (response.status === 429 || response.status >= 500) {
              const error = new Error(`Portal returned HTTP ${response.status}`);
              error.retryable = true;
              throw error;
            }
            if (!response.ok) throw new Error(`Portal returned HTTP ${response.status}`);
            return parsePortalResponse(text);
          } finally {
            clearTimeout(timeout);
          }
        });
      } catch (error) {
        lastError = error;
        if (attempt === 4 || error.retryable === false) break;
        totals.retries += 1;
        await sleep(1000 * (2 ** (attempt - 1)));
      }
    }
    throw lastError || new Error('Portal request failed');
  }

  async function queryPortal(bbox, from, to, filters = {}) {
    const url = new URL(PORTAL_URL);
    Object.entries({ ...bbox, fromdate: from, todate: to, ...filters })
      .forEach(([key, value]) => url.searchParams.set(key, String(value)));
    return (await requestPortalArray(url)).map(normalizePin);
  }

  let problemAreasPromise = null;
  function loadProblemAreas() {
    if (!problemAreasPromise) {
      const url = new URL(PROBLEM_AREA_OPTIONS_URL);
      url.searchParams.set('entity', 'n311_srproblem');
      url.searchParams.set('attribute', 'n311_problemareaglobal');
      problemAreasPromise = requestPortalArray(url).then(areas => {
        const valid = areas.filter(area => area && area.value != null);
        if (!valid.length) throw new Error('Portal returned no problem-area options');
        return valid;
      });
    }
    return problemAreasPromise;
  }

  const problemOptionsPromises = new Map();
  function loadProblemOptions(problemArea) {
    const key = String(problemArea.value);
    if (!problemOptionsPromises.has(key)) {
      const url = new URL(PROBLEM_OPTIONS_URL);
      Object.entries({
        lookupentity: 'n311_srproblem',
        lookupidattribute: 'n311_srproblemid',
        lookupdisplayattribute: 'n311_name',
        parentfilterattribute: 'n311_problemareaglobal',
        parentfiltervalue: key,
        type: 'problem'
      }).forEach(([name, value]) => url.searchParams.set(name, value));
      problemOptionsPromises.set(key, requestPortalArray(url).then(options =>
        options.filter(option => option && option.value)));
    }
    return problemOptionsPromises.get(key);
  }

  function uniquePins(pins) {
    const unique = new Map();
    pins.forEach(pin => unique.set(pinKey(pin), pin));
    return [...unique.values()];
  }

  async function collectProblemArea(bbox, day, problemArea) {
    const pins = await queryPortal(bbox, day, day, { problemarea: problemArea.value });
    if (pins.length < PORTAL_CAP) return pins;

    totals.cappedQueries += 1;
    const problemOptions = await loadProblemOptions(problemArea);
    if (!problemOptions.length) {
      throw new Error(`No Portal problem options found for ${problemArea.name || problemArea.value}`);
    }
    const parts = await Promise.all(problemOptions.map(problem =>
      queryPortal(bbox, day, day, {
        problemarea: problemArea.value,
        problem: problem.value
      })));
    if (parts.some(part => part.length >= PORTAL_CAP)) {
      throw new Error(`Portal problem filter remained capped on ${day}`);
    }
    const recovered = uniquePins(parts.flat());
    if (recovered.length < PORTAL_CAP) {
      throw new Error(`Portal problem filters recovered only ${recovered.length} capped records on ${day}`);
    }
    return recovered;
  }

  async function collectByProblemArea(bbox, day) {
    totals.problemAreaSplits += 1;
    const problemAreas = await loadProblemAreas();
    const parts = await Promise.all(problemAreas.map(problemArea =>
      collectProblemArea(bbox, day, problemArea)));
    const recovered = uniquePins(parts.flat());
    if (recovered.length < PORTAL_CAP) {
      throw new Error(`Portal problem areas recovered only ${recovered.length} capped records on ${day}`);
    }
    return recovered;
  }

  async function collectTile(bbox, day, depth, initialPins = null) {
    const pins = initialPins || await queryPortal(bbox, day, day);
    if (pins.length < PORTAL_CAP) return pins;
    totals.cappedQueries += 1;
    const coordinateCount = new Set(pins.map(pin => `${pin.longitude}|${pin.latitude}`)).size;
    if (coordinateCount === 1 || depth >= 7) return collectByProblemArea(bbox, day);
    const parts = await Promise.all(
      splitBbox(bbox).map(tile => collectTile(tile, day, depth + 1))
    );
    return parts.flat();
  }

  async function collectRange(bbox, from, to) {
    const pins = await queryPortal(bbox, from, to);
    if (pins.length < PORTAL_CAP) return pins;
    totals.cappedQueries += 1;
    if (from === to) return collectTile(bbox, from, 0, pins);
    const parts = await Promise.all(
      splitDateRange(from, to).map(range => collectRange(bbox, range.from, range.to))
    );
    return parts.flat();
  }

  let completed = 0;
  async function exportBid(feature) {
    const properties = feature.properties || {};
    const bidId = String(properties.bid_id);
    const checkpointPath = path.join(checkpointDirectory, `${bidId}.json`);
    if (fs.existsSync(checkpointPath)) {
      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      if (checkpoint.from === options.from
          && checkpoint.to === options.to
          && checkpoint.boundary_sha256 === boundarySha256) {
        totals.resumedBids += 1;
        completed += 1;
        console.log(`[${completed}/${features.length}] ${properties.name}: resumed (${checkpoint.rows.length} SRs)`);
        return checkpoint.rows;
      }
    }

    const bidStartedAt = Date.now();
    const pins = await collectRange(featureBbox(feature), options.from, options.to);
    const uniquePins = new Map();
    pins.forEach(pin => uniquePins.set(pinKey(pin), pin));
    const rows = [];
    for (const pin of uniquePins.values()) {
      if (!pin.sr_number) {
        totals.missingSrNumbers += 1;
        continue;
      }
      if (pin.latitude == null || pin.longitude == null) continue;
      if (!featureContainsPoint(feature, pin.longitude, pin.latitude)) continue;
      rows.push({
        sr_number: pin.sr_number,
        bid_id: properties.bid_id,
        bid_name: properties.name,
        borough: properties.borough || '',
        submitted_at: pin.submitted_at || '',
        latitude: pin.latitude,
        longitude: pin.longitude,
        problem: pin.problem || '',
        status: pin.status || '',
        address: pin.address || '',
        portal_url: pin.portal_url || '',
        boundary_version: boundaryVersion
      });
    }
    rows.sort((left, right) =>
      left.sr_number.localeCompare(right.sr_number)
      || left.bid_name.localeCompare(right.bid_name));
    fs.writeFileSync(checkpointPath, JSON.stringify({
      from: options.from,
      to: options.to,
      boundary_sha256: boundarySha256,
      rows
    }));

    completed += 1;
    const elapsed = Date.now() - startedAt;
    const eta = completed ? elapsed / completed * (features.length - completed) : NaN;
    console.log(
      `[${completed}/${features.length}] ${properties.name}: ${rows.length} SRs `
      + `(${formatDuration(Date.now() - bidStartedAt)}; ETA ${formatDuration(eta)})`
    );
    return rows;
  }

  console.log(
    `Exporting ${features.length} BIDs from ${options.from} through ${options.to} `
    + `with ${options.concurrency} Portal request slots.`
  );
  const rows = (await mapLimit(features, options.bidWorkers, exportBid)).flat();
  rows.sort((left, right) =>
    left.sr_number.localeCompare(right.sr_number)
    || left.bid_name.localeCompare(right.bid_name));

  const headers = [
    'SR Number',
    'BID ID',
    'BID Name',
    'Borough',
    'Submitted At',
    'Latitude',
    'Longitude',
    'Problem',
    'Status',
    'Address',
    'Portal URL',
    'Boundary Version'
  ];
  const csv = [headers, ...rows.map(row => [
    row.sr_number,
    row.bid_id,
    row.bid_name,
    row.borough,
    row.submitted_at,
    row.latitude,
    row.longitude,
    row.problem,
    row.status,
    row.address,
    row.portal_url,
    row.boundary_version
  ])].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
  fs.writeFileSync(options.output, csv);

  const uniqueSrNumbers = new Set(rows.map(row => row.sr_number));
  const multiBidSrNumbers = new Map();
  rows.forEach(row => {
    if (!multiBidSrNumbers.has(row.sr_number)) multiBidSrNumbers.set(row.sr_number, new Set());
    multiBidSrNumbers.get(row.sr_number).add(String(row.bid_id));
  });
  const manifest = {
    created_at: new Date().toISOString(),
    source: PORTAL_URL,
    submitted_from: options.from,
    submitted_to: options.to,
    boundary_file: path.basename(options.boundaries),
    boundary_version: boundaryVersion,
    boundary_sha256: boundarySha256,
    bid_count: features.length,
    membership_rows: rows.length,
    unique_sr_numbers: uniqueSrNumbers.size,
    sr_numbers_in_multiple_bids: [...multiBidSrNumbers.values()]
      .filter(bidIds => bidIds.size > 1).length,
    portal_calls: totals.portalCalls,
    capped_queries_split: totals.cappedQueries,
    problem_area_splits: totals.problemAreaSplits,
    portal_retries: totals.retries,
    resumed_bids: totals.resumedBids,
    portal_results_without_sr_number: totals.missingSrNumbers,
    coordinate_rows: rows.filter(row =>
      Number.isFinite(row.latitude) && Number.isFinite(row.longitude)).length,
    elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
    csv_sha256: sha256(Buffer.from(csv))
  };
  const manifestPath = options.output.replace(/\.csv$/i, '') + '.manifest.json';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  if (!options.keepCheckpoint) fs.rmSync(checkpointDirectory, { recursive: true, force: true });

  console.log(`Wrote ${rows.length} memberships for ${uniqueSrNumbers.size} unique SRs.`);
  console.log(`CSV: ${options.output}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Elapsed: ${formatDuration(Date.now() - startedAt)}; Portal calls: ${totals.portalCalls}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  featureBbox,
  featureContainsPoint,
  parseArguments,
  splitBbox,
  splitDateRange
};
