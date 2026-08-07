#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_INPUT = path.resolve(
  'exports',
  'sr-bid-records-with-coordinates-2026-01-01-to-2026-08-04.csv'
);
const DEFAULT_BOUNDARIES = path.resolve(
  'public',
  'data',
  'nyc-bid-boundaries-2026-04-28.geojson'
);
const DEFAULT_OUTPUT = path.resolve('public', 'data', 'sr-bid-timeline');
const DEFAULT_METRICS_OUTPUT = path.resolve('public', 'data', 'sr-bid-metrics.json');
const DEFAULT_METRICS_SCRIPT_OUTPUT = path.resolve(
  'public',
  'data',
  'sr-bid-metrics-data.js'
);

function parseArguments(argv) {
  const options = {
    input: DEFAULT_INPUT,
    boundaries: DEFAULT_BOUNDARIES,
    output: DEFAULT_OUTPUT,
    metricsOutput: DEFAULT_METRICS_OUTPUT,
    metricsScriptOutput: DEFAULT_METRICS_SCRIPT_OUTPUT
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value`);
      return path.resolve(argv[index]);
    };
    if (argument === '--input') options.input = next();
    else if (argument === '--boundaries') options.boundaries = next();
    else if (argument === '--output') options.output = next();
    else if (argument === '--metrics-output') options.metricsOutput = next();
    else if (argument === '--metrics-script-output') options.metricsScriptOutput = next();
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted && character === '"' && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

const newYorkParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function localDate(timestamp) {
  const parts = Object.fromEntries(
    newYorkParts.formatToParts(new Date(timestamp))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dictionaryIndex(value, values, indices) {
  const normalized = String(value || 'Unknown');
  if (!indices.has(normalized)) {
    indices.set(normalized, values.length);
    values.push(normalized);
  }
  return indices.get(normalized);
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function emptyMetricGroup() {
  return { requests: 0, problems: new Map(), statuses: new Map() };
}

function addMetric(group, problemIndex, statusIndex) {
  group.requests += 1;
  increment(group.problems, problemIndex);
  increment(group.statuses, statusIndex);
}

function compactCounts(map) {
  return [...map.entries()].sort((left, right) => left[0] - right[0]);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const lines = fs.readFileSync(options.input, 'utf8').trimEnd().split('\n');
  const headers = parseCsvLine(lines.shift().replace(/\r$/, ''));
  const expectedHeaders = [
    'SR Number', 'BID ID', 'BID Name', 'Borough', 'Submitted At',
    'Latitude', 'Longitude', 'Problem', 'Status', 'Address',
    'Portal URL', 'Boundary Version'
  ];
  if (headers.length !== expectedHeaders.length
      || headers.some((header, index) => header !== expectedHeaders[index])) {
    throw new Error('Coordinate export has an unexpected CSV schema');
  }

  const boundaries = JSON.parse(fs.readFileSync(options.boundaries, 'utf8'));
  const bids = Object.fromEntries(boundaries.features.map(feature => {
    const properties = feature.properties || {};
    return [String(properties.bid_id), {
      name: properties.name,
      borough: properties.borough
    }];
  }));
  const problems = [];
  const problemIndices = new Map();
  const statuses = [];
  const statusIndices = new Map();
  const recordsByDate = new Map();
  const membershipCountsByDate = new Map();
  const metricsByDate = new Map();

  let current = null;
  let membershipRows = 0;
  function finishRecord() {
    if (!current) return;
    const date = localDate(current.timestamp);
    if (!recordsByDate.has(date)) recordsByDate.set(date, []);
    const bidIds = [...current.bidIds].sort((left, right) => left - right);
    recordsByDate.get(date).push([
      Number(current.srNumber.slice(4)),
      bidIds.length === 1 ? bidIds[0] : bidIds,
      current.latitude,
      current.longitude,
      Math.floor(Date.parse(current.timestamp) / 1000),
      current.problem,
      current.status,
      current.address
    ]);

    if (!metricsByDate.has(date)) {
      metricsByDate.set(date, { all: emptyMetricGroup(), bids: new Map() });
    }
    const dayMetrics = metricsByDate.get(date);
    addMetric(dayMetrics.all, current.problem, current.status);
    for (const bidId of bidIds) {
      if (!dayMetrics.bids.has(bidId)) dayMetrics.bids.set(bidId, emptyMetricGroup());
      addMetric(dayMetrics.bids.get(bidId), current.problem, current.status);
    }
  }

  for (const rawLine of lines) {
    const row = parseCsvLine(rawLine.replace(/\r$/, ''));
    if (row.length !== expectedHeaders.length) throw new Error('Malformed coordinate export row');
    const [
      srNumber, bidId, , , timestamp, latitude, longitude,
      problem, status, address
    ] = row;
    const date = localDate(timestamp);
    if (!membershipCountsByDate.has(date)) membershipCountsByDate.set(date, new Map());
    const dateCounts = membershipCountsByDate.get(date);
    dateCounts.set(Number(bidId), (dateCounts.get(Number(bidId)) || 0) + 1);
    membershipRows += 1;

    if (!current || current.srNumber !== srNumber) {
      finishRecord();
      current = {
        srNumber,
        bidIds: new Set(),
        timestamp,
        latitude: Number(latitude),
        longitude: Number(longitude),
        problem: dictionaryIndex(problem, problems, problemIndices),
        status: dictionaryIndex(status, statuses, statusIndices),
        address
      };
    }
    current.bidIds.add(Number(bidId));
  }
  finishRecord();

  const dates = [...recordsByDate.keys()].sort();
  const months = new Map();
  for (const date of dates) {
    const month = date.slice(0, 7);
    if (!months.has(month)) months.set(month, {});
    months.get(month)[date] = recordsByDate.get(date);
  }

  fs.rmSync(options.output, { recursive: true, force: true });
  fs.mkdirSync(options.output, { recursive: true });
  for (const [month, days] of months) {
    fs.writeFileSync(
      path.join(options.output, `${month}.json`),
      JSON.stringify({ month, days }) + '\n'
    );
  }

  const sourceManifestPath = options.input.replace(/\.csv$/i, '.manifest.json');
  const sourceManifest = fs.existsSync(sourceManifestPath)
    ? JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8'))
    : {};
  const dayIndex = dates.map(date => {
    const counts = membershipCountsByDate.get(date) || new Map();
    return {
      date,
      requests: recordsByDate.get(date).length,
      memberships: [...counts.values()].reduce((sum, count) => sum + count, 0),
      counts: [...counts.entries()].sort((left, right) => left[0] - right[0])
    };
  });
  const builtAt = new Date().toISOString();
  const sourceSnapshotAt = sourceManifest.created_at || builtAt;
  const finalDayPartial = localDate(sourceSnapshotAt) === dates[dates.length - 1];
  const index = {
    metadata: {
      created_at: builtAt,
      built_at: builtAt,
      source_snapshot_at: sourceSnapshotAt,
      source: sourceManifest.source || 'NYC 311 Portal',
      source_csv: path.basename(options.input),
      source_csv_sha256: sourceManifest.csv_sha256 || null,
      from: dates[0],
      to: dates[dates.length - 1],
      unique_requests: dayIndex.reduce((sum, day) => sum + day.requests, 0),
      membership_rows: membershipRows,
      final_day_partial: finalDayPartial,
      last_complete_date: finalDayPartial
        ? new Date(Date.parse(`${dates[dates.length - 1]}T12:00:00Z`) - 86400000)
          .toISOString().slice(0, 10)
        : dates[dates.length - 1],
      boundary_version: boundaries.metadata && boundaries.metadata.boundary_version,
      timezone: 'America/New_York'
    },
    bids,
    problems,
    statuses,
    months: [...months.keys()],
    days: dayIndex
  };
  fs.writeFileSync(
    path.join(options.output, 'index.json'),
    JSON.stringify(index) + '\n'
  );

  const metrics = {
    metadata: index.metadata,
    bids,
    problems,
    statuses,
    days: Object.fromEntries(dates.map(date => {
      const day = metricsByDate.get(date);
      return [date, {
        // Compact groups are [request count, status counts, problem counts].
        all: [day.all.requests, compactCounts(day.all.statuses), compactCounts(day.all.problems)],
        bids: [...day.bids.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([bidId, group]) => [
            bidId,
            group.requests,
            compactCounts(group.statuses),
            compactCounts(group.problems)
          ])
      }];
    }))
  };
  fs.mkdirSync(path.dirname(options.metricsOutput), { recursive: true });
  fs.writeFileSync(options.metricsOutput, JSON.stringify(metrics) + '\n');
  fs.mkdirSync(path.dirname(options.metricsScriptOutput), { recursive: true });
  fs.writeFileSync(
    options.metricsScriptOutput,
    `globalThis.__BID_METRICS_DATA__=${JSON.stringify(metrics)};\n`
  );
  console.log(JSON.stringify({
    output: options.output,
    metricsOutput: options.metricsOutput,
    metricsScriptOutput: options.metricsScriptOutput,
    days: dates.length,
    months: months.size,
    uniqueRequests: index.metadata.unique_requests,
    membershipRows,
    problems: problems.length,
    statuses
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  addMetric,
  compactCounts,
  emptyMetricGroup,
  localDate,
  parseArguments,
  parseCsvLine
};
