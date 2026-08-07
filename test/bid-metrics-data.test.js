'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const metricsPath = path.resolve(__dirname, '..', 'public', 'data', 'sr-bid-metrics.json');
const metricsScriptPath = path.resolve(
  __dirname,
  '..',
  'public',
  'data',
  'sr-bid-metrics-data.js'
);

function countPairs(pairs) {
  return (pairs || []).reduce((total, pair) => total + Number(pair[1] || 0), 0);
}

test('generated BID metrics remain internally complete and consistent', () => {
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const dates = Object.keys(metrics.days).sort();
  assert.equal(dates[0], metrics.metadata.from);
  assert.equal(dates.at(-1), metrics.metadata.to);
  assert.equal(dates.length, 216);
  assert.equal(Object.keys(metrics.bids).length, 78);

  let uniqueRequests = 0;
  let memberships = 0;
  dates.forEach((date, index) => {
    if (index > 0) {
      const previous = new Date(`${dates[index - 1]}T12:00:00Z`);
      previous.setUTCDate(previous.getUTCDate() + 1);
      assert.equal(date, previous.toISOString().slice(0, 10), `missing metrics date before ${date}`);
    }

    const day = metrics.days[date];
    const [requests, statuses, problems] = day.all;
    assert.equal(countPairs(statuses), requests, `${date} status counts`);
    assert.equal(countPairs(problems), requests, `${date} problem counts`);
    uniqueRequests += requests;

    for (const [bidId, bidRequests, bidStatuses, bidProblems] of day.bids) {
      assert.ok(metrics.bids[String(bidId)], `unknown BID ${bidId}`);
      assert.equal(countPairs(bidStatuses), bidRequests, `${date} BID ${bidId} status counts`);
      assert.equal(countPairs(bidProblems), bidRequests, `${date} BID ${bidId} problem counts`);
      memberships += bidRequests;
    }
  });

  assert.equal(uniqueRequests, metrics.metadata.unique_requests);
  assert.equal(memberships, metrics.metadata.membership_rows);
  assert.equal(uniqueRequests, 137859);
  assert.equal(memberships, 138163);
});

test('standalone metrics data script exposes the same local dataset', () => {
  const expected = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(metricsScriptPath, 'utf8'), context);
  assert.equal(context.__BID_METRICS_DATA__.metadata.unique_requests, 137859);
  assert.equal(
    context.__BID_METRICS_DATA__.metadata.source_csv_sha256,
    expected.metadata.source_csv_sha256
  );
  assert.deepEqual(
    Object.keys(context.__BID_METRICS_DATA__.days),
    Object.keys(expected.days)
  );
});

test('BID metrics page uses file-safe relative assets in dependency order', () => {
  const html = fs.readFileSync(
    path.resolve(__dirname, '..', 'public', 'bid-metrics.html'),
    'utf8'
  );
  assert.match(html, /href="\.\/css\/bid-metrics\.css/);
  assert.match(html, /href="\.\/live\.html"/);
  const dataPosition = html.indexOf('src="./data/sr-bid-metrics-data.js');
  const appPosition = html.indexOf('src="./js/bid-metrics.js');
  assert.ok(dataPosition >= 0 && dataPosition < appPosition);
});
