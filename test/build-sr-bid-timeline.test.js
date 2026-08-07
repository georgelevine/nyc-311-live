'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  addMetric,
  compactCounts,
  emptyMetricGroup,
  localDate,
  parseArguments,
  parseCsvLine
} = require('../scripts/build-sr-bid-timeline');

test('timeline CSV parsing preserves quoted commas and escaped quotes', () => {
  assert.deepEqual(
    parseCsvLine('"311-28000000","1","Downtown, Alliance","A ""quoted"" place"'),
    ['311-28000000', '1', 'Downtown, Alliance', 'A "quoted" place']
  );
});

test('timeline dates are grouped in New York local time', () => {
  assert.equal(localDate('2026-01-01T04:59:59.000Z'), '2025-12-31');
  assert.equal(localDate('2026-01-01T05:00:00.000Z'), '2026-01-01');
  assert.equal(localDate('2026-07-01T04:00:00.000Z'), '2026-07-01');
});

test('metrics aggregate request, status, and problem counts compactly', () => {
  const group = emptyMetricGroup();
  addMetric(group, 4, 1);
  addMetric(group, 4, 0);
  addMetric(group, 9, 1);
  assert.equal(group.requests, 3);
  assert.deepEqual(compactCounts(group.statuses), [[0, 1], [1, 2]]);
  assert.deepEqual(compactCounts(group.problems), [[4, 2], [9, 1]]);
});

test('timeline arguments expose a separate metrics output', () => {
  const options = parseArguments([
    '--input', 'records.csv',
    '--output', 'timeline-data',
    '--metrics-output', 'metrics.json',
    '--metrics-script-output', 'metrics-data.js'
  ]);
  assert.match(options.input, /records\.csv$/);
  assert.match(options.output, /timeline-data$/);
  assert.match(options.metricsOutput, /metrics\.json$/);
  assert.match(options.metricsScriptOutput, /metrics-data\.js$/);
});
