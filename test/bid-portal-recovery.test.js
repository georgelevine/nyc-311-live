'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  bidRecoveryRange,
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

test('BID recovery ranges use NYC calendar days and accept a gap at the maximum', () => {
  assert.deepEqual(
    bidRecoveryRange(null, '2026-08-06T02:00:00.000Z', { maxDays: 2 }),
    { from: '2026-08-05', to: '2026-08-05' }
  );
  assert.deepEqual(
    bidRecoveryRange(
      { last_successful_poll_at: '2026-08-04T16:00:00.000Z' },
      '2026-08-06T16:00:00.000Z',
      { maxDays: 2 }
    ),
    { from: '2026-08-04', to: '2026-08-06' }
  );
});

test('BID recovery ranges reject unsafe limits and gaps beyond the limit', () => {
  for (const maxDays of [0, 32, 1.5, Number.NaN]) {
    assert.throws(
      () => bidRecoveryRange(null, '2026-08-06T16:00:00.000Z', { maxDays }),
      /maxDays must be an integer from 1 through 31/
    );
  }
  assert.throws(
    () => bidRecoveryRange(
      { last_successful_poll_at: '2026-08-04T15:59:59.000Z' },
      '2026-08-06T16:00:00.000Z',
      { maxDays: 2 }
    ),
    /automatic catch-up is limited to 2 days/
  );
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

test('problem-filter recovery rejects an incomplete capped problem area', async () => {
  const capped = Array.from({ length: 100 }, (_, index) =>
    pin(`initial-${index}`, 40.71, -74.01));
  const records = (prefix, count) => Array.from(
    { length: count },
    (_, index) => pin(`${prefix}-${index}`, 40.71, -74.01)
  );
  const fetchImpl = async url => {
    const parsed = new URL(String(url));
    if (parsed.pathname.includes('get-optionset-filter-options')) {
      return response([{ value: 'area-a' }, { value: 'area-b' }]);
    }
    if (parsed.pathname.includes('get-lookup-filter-options')) {
      return response([{ value: 'problem-a1' }, { value: 'problem-a2' }]);
    }
    const area = parsed.searchParams.get('problemarea');
    const problem = parsed.searchParams.get('problem');
    if (!area) return response(capped);
    if (area === 'area-b') return response(records('area-b', 2));
    if (!problem) return response(capped);
    return response(records(problem, problem === 'problem-a1' ? 50 : 49));
  };
  const client = createBidPortalClient({
    fetchImpl,
    concurrency: 3,
    retries: 1,
    timeoutMs: 1000
  });

  await assert.rejects(
    client.collectRange({ bbox, from: '2026-08-06', to: '2026-08-06' }),
    /problem filters recovered only 99 capped records/
  );
});
