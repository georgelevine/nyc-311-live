'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createBidPortalClient,
  nycCalendarDay,
  portalMapUrl,
  splitBbox,
  splitDateRange
} = require('../bid-portal-recovery');

function response(records, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(records); }
  };
}

function pin(number, latitude = 40.7, longitude = -74) {
  return {
    id: number,
    latitude,
    longitude,
    data: { srnumber: number, submitteddate: '2026-08-06T12:00:00Z' }
  };
}

const bbox = {
  minlongitude: -74.02,
  minlatitude: 40.70,
  maxlongitude: -74.00,
  maxlatitude: 40.72
};

test('Portal map URLs keep bbox retrieval separate from exact BID membership', () => {
  const url = portalMapUrl({ bbox, from: '2026-08-05', to: '2026-08-06' });
  assert.equal(url.searchParams.get('minlongitude'), '-74.02');
  assert.equal(url.searchParams.get('maxlatitude'), '40.72');
  assert.equal(url.searchParams.get('fromdate'), '2026-08-05');
  assert.equal(url.searchParams.get('todate'), '2026-08-06');
  assert.deepEqual(splitDateRange('2026-08-05', '2026-08-06'), [
    { from: '2026-08-05', to: '2026-08-05' },
    { from: '2026-08-06', to: '2026-08-06' }
  ]);
  assert.equal(splitBbox(bbox).length, 4);
  assert.equal(nycCalendarDay('2026-08-06T02:00:00Z'), '2026-08-05');
});

test('capped multi-day recovery splits dates and deduplicates results', async () => {
  const calls = [];
  const capped = Array.from({ length: 100 }, (_, index) =>
    pin(`311-${String(index + 1).padStart(8, '0')}`));
  const fetchImpl = async url => {
    const parsed = new URL(String(url));
    calls.push(parsed);
    const from = parsed.searchParams.get('fromdate');
    const to = parsed.searchParams.get('todate');
    if (from !== to) return response(capped);
    return response([pin(from === '2026-08-05' ? '311-00000201' : '311-00000202')]);
  };
  const client = createBidPortalClient({
    fetchImpl,
    concurrency: 2,
    retries: 1,
    timeoutMs: 1000
  });
  const recovered = await client.collectRange({
    bbox,
    from: '2026-08-05',
    to: '2026-08-06'
  });
  assert.deepEqual(
    recovered.map(record => record.data.srnumber).sort(),
    ['311-00000201', '311-00000202']
  );
  assert.equal(calls.length, 3);
  assert.equal(client.diagnostics.cappedQueries, 1);
});

test('capped single-day recovery spatially subdivides until each tile is complete', async () => {
  const initial = Array.from({ length: 100 }, (_, index) =>
    pin(
      `311-${String(index + 1).padStart(8, '0')}`,
      40.7001 + index * 0.000001,
      -74.0199 + index * 0.000001
    ));
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    if (calls === 1) return response(initial);
    const parsed = new URL(String(url));
    return response([pin(`311-${String(300 + calls).padStart(8, '0')}`,
      Number(parsed.searchParams.get('minlatitude')),
      Number(parsed.searchParams.get('minlongitude'))) ]);
  };
  const client = createBidPortalClient({
    fetchImpl,
    concurrency: 2,
    retries: 1,
    timeoutMs: 1000
  });
  const recovered = await client.collectRange({
    bbox,
    from: '2026-08-06',
    to: '2026-08-06'
  });
  assert.equal(recovered.length, 4);
  assert.equal(calls, 5);
  assert.equal(client.diagnostics.spatialSplits, 1);
});
