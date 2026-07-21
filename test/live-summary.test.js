'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLiveSummary, explicitPortalBorough } = require('../live-summary');

const AS_OF = '2026-07-21T12:30:00.000Z';

function row(submittedAt, overrides = {}) {
  return {
    submitted_at: submittedAt,
    source: 'map',
    problem: 'Noise',
    address: '1 CENTRE STREET, MANHATTAN (NEW YORK), NY, 10007',
    latitude: 40.7128,
    longitude: -74.006,
    details_loaded: true,
    ...overrides
  };
}

function summary(rows, options = {}) {
  return buildLiveSummary(rows, { asOf: AS_OF, ...options });
}

function totalTop(distribution) {
  return distribution.top.reduce((total, item) => total + item.count, 0);
}

function assertProfileInvariants(profile, total) {
  assert.equal(
    totalTop(profile.categories) + profile.categories.other.requests + profile.categories.unknown,
    total
  );
  assert.equal(
    totalTop(profile.boroughs) + profile.boroughs.other.requests + profile.boroughs.unknown,
    total
  );
  assert.equal(profile.coverage.details.loaded + profile.coverage.details.pending, total);
  assert.equal(profile.coverage.map.mapped + profile.coverage.map.unmapped, total);
}

test('uses adjacent half-open map-only windows and excludes invalid timestamps', () => {
  const result = summary([
    row('2026-07-21T11:59:59.999Z'),
    row('2026-07-21T12:00:00.000Z'),
    row('2026-07-21T12:14:59.999Z'),
    row('2026-07-21T12:15:00.000Z'),
    row('2026-07-21T12:29:59.999Z'),
    row('2026-07-21T12:30:00.000Z'),
    row(null),
    row('not-a-timestamp')
  ]);

  assert.deepEqual(result.current, {
    start: '2026-07-21T12:15:00.000Z',
    end: '2026-07-21T12:30:00.000Z',
    requests: 2,
    provisional: true,
    completeness: 'provisional_map_feed',
    source_scope: 'portal_map_feed'
  });
  assert.deepEqual(result.previous, {
    start: '2026-07-21T12:00:00.000Z',
    end: '2026-07-21T12:15:00.000Z',
    requests: 2,
    provisional: true,
    completeness: 'provisional_map_feed',
    source_scope: 'portal_map_feed'
  });
  assert.equal(result.as_of, AS_OF);
  assert.equal(result.basis, 'submitted_at');
  assertProfileInvariants(result, result.current.requests);
});

test('keeps number-audit discoveries out of recent provisional comparisons', () => {
  const result = summary([
    row('2026-07-21T12:20:00.000Z'),
    row('2026-07-21T12:21:00.000Z', { source: 'number_audit' }),
    row('2026-07-21T12:10:00.000Z'),
    row('2026-07-21T12:11:00.000Z', { source: 'number_audit' })
  ]);

  assert.equal(result.current.requests, 1);
  assert.equal(result.previous.requests, 1);
  assert.deepEqual(result.change, { absolute: 0, percent: 0, direction: 'flat' });
});

test('builds an audit-eligible all-source window without claiming completion', () => {
  const result = summary([
    row('2026-07-21T11:29:59.999Z'),
    row('2026-07-21T11:30:00.000Z', { problem: 'Noise' }),
    row('2026-07-21T11:40:00.000Z', {
      source: 'number_audit',
      problem: 'Illegal Parking',
      details_loaded: false,
      latitude: null
    }),
    row('2026-07-21T11:44:59.999Z', { source: 'number_audit', problem: 'Noise' }),
    row('2026-07-21T11:45:00.000Z')
  ]);

  assert.equal(result.delayed.start, '2026-07-21T11:30:00.000Z');
  assert.equal(result.delayed.end, '2026-07-21T11:45:00.000Z');
  assert.equal(result.delayed.requests, 3);
  assert.equal(result.delayed.provisional, true);
  assert.equal(result.delayed.completeness, 'audit_eligible_unverified');
  assert.equal(result.delayed.source_scope, 'portal_map_and_number_audit');
  assert.deepEqual(result.completeness, {
    current: 'provisional_map_feed',
    previous: 'provisional_map_feed',
    delayed: 'audit_eligible_unverified',
    audit_delay_minutes: 35,
    maturity_buffer_minutes: 10
  });
  assert.deepEqual(result.delayed.categories.top, [
    { name: 'Noise', count: 2 },
    { name: 'Illegal Parking', count: 1 }
  ]);
  assert.deepEqual(result.delayed.coverage.details, { loaded: 2, pending: 1, rate: 2 / 3 });
  assert.deepEqual(result.delayed.coverage.map, { mapped: 2, unmapped: 1, rate: 2 / 3 });
  assertProfileInvariants(result.delayed, result.delayed.requests);
});

test('reports increase, decrease, equality, and a zero-denominator comparison safely', async t => {
  const cases = [
    { current: 6, previous: 4, expected: { absolute: 2, percent: 50, direction: 'up' } },
    { current: 2, previous: 4, expected: { absolute: -2, percent: -50, direction: 'down' } },
    { current: 3, previous: 3, expected: { absolute: 0, percent: 0, direction: 'flat' } },
    { current: 3, previous: 0, expected: { absolute: 3, percent: null, direction: 'up' } },
    { current: 0, previous: 0, expected: { absolute: 0, percent: null, direction: 'flat' } }
  ];

  for (const fixture of cases) {
    await t.test(`${fixture.current} current versus ${fixture.previous} previous`, () => {
      const rows = [];
      for (let index = 0; index < fixture.current; index += 1) {
        rows.push(row(`2026-07-21T12:${String(15 + index).padStart(2, '0')}:00.000Z`));
      }
      for (let index = 0; index < fixture.previous; index += 1) {
        rows.push(row(`2026-07-21T12:${String(index).padStart(2, '0')}:00.000Z`));
      }
      assert.deepEqual(summary(rows).change, fixture.expected);
    });
  }
});

test('groups categories case-insensitively and resolves ties deterministically into a long tail', () => {
  const problems = [
    'Illegal Parking', 'Illegal Parking', 'Illegal Parking',
    'Noise', ' noise ', 'NOISE',
    'Street Condition', 'Street   Condition',
    'Trees', 'Trees',
    null
  ];
  const rows = problems.map((problem, index) => row(
    `2026-07-21T12:${String(15 + index).padStart(2, '0')}:00.000Z`,
    { problem }
  ));
  const forward = summary(rows);
  const reversed = summary([...rows].reverse());

  assert.deepEqual(forward.categories, reversed.categories);
  assert.deepEqual(forward.categories.top.map(item => [item.name.toLocaleLowerCase('en-US'), item.count]), [
    ['illegal parking', 3],
    ['noise', 3],
    ['street condition', 2]
  ]);
  assert.deepEqual(forward.categories.other, { requests: 2, categories: 1 });
  assert.equal(forward.categories.distinct, 4);
  assert.equal(forward.categories.unknown, 1);
  assertProfileInvariants(forward, rows.length);
});

test('derives boroughs only from the explicit Portal borough segment', () => {
  assert.equal(explicitPortalBorough('1 CENTRE ST, MANHATTAN (NEW YORK), NY, 10007'), 'Manhattan');
  assert.equal(explicitPortalBorough('1 MAIN ST, queens (JAMAICA), ny, 11432'), 'Queens');
  assert.equal(explicitPortalBorough('1 MAIN ST, QUEENS, NY, 11432'), 'Queens');
  assert.equal(explicitPortalBorough('1 MAIN ST, STATEN IS (STATEN ISLAND), NY, 10301'), 'Staten Island');
  assert.equal(explicitPortalBorough('1 MANHATTAN AVENUE, BROOKLYN, NY, 11222'), 'Brooklyn');
  assert.equal(explicitPortalBorough('1 Queens Boulevard, New York, NY'), null);
  assert.equal(explicitPortalBorough(null), null);

  const result = summary([
    row('2026-07-21T12:16:00.000Z'),
    row('2026-07-21T12:17:00.000Z', {
      address: '1 MAIN ST, BROOKLYN (BROOKLYN), NY, 11201'
    }),
    row('2026-07-21T12:18:00.000Z', {
      address: '1 MAIN ST, QUEENS (JAMAICA), NY, 11432'
    }),
    row('2026-07-21T12:19:00.000Z', { address: 'Location unavailable' })
  ], { topBoroughLimit: 3 });

  assert.deepEqual(result.boroughs.top, [
    { name: 'Brooklyn', count: 1 },
    { name: 'Manhattan', count: 1 },
    { name: 'Queens', count: 1 }
  ]);
  assert.deepEqual(result.boroughs.other, { requests: 0, categories: 0 });
  assert.equal(result.boroughs.distinct, 3);
  assert.equal(result.boroughs.unknown, 1);
  assertProfileInvariants(result, result.current.requests);
});

test('counts current detail and displayable map coverage without previous-window contamination', () => {
  const result = summary([
    row('2026-07-21T12:16:00.000Z'),
    row('2026-07-21T12:17:00.000Z', { details_loaded: '1', latitude: '40.7', longitude: '-73.9' }),
    row('2026-07-21T12:18:00.000Z', { details_loaded: false, latitude: null }),
    row('2026-07-21T12:19:00.000Z', { details_loaded: 0, latitude: 91 }),
    row('2026-07-21T12:10:00.000Z', { details_loaded: false, latitude: null })
  ]);

  assert.deepEqual(result.coverage.details, { loaded: 2, pending: 2, rate: 0.5 });
  assert.deepEqual(result.coverage.map, { mapped: 2, unmapped: 2, rate: 0.5 });
  assertProfileInvariants(result, result.current.requests);
});

test('returns a complete, finite empty contract', () => {
  const result = summary([]);

  assert.equal(result.current.requests, 0);
  assert.equal(result.previous.requests, 0);
  assert.deepEqual(result.change, { absolute: 0, percent: null, direction: 'flat' });
  assert.deepEqual(result.categories, {
    top: [], other: { requests: 0, categories: 0 }, distinct: 0, unknown: 0
  });
  assert.deepEqual(result.boroughs, {
    top: [], other: { requests: 0, categories: 0 }, distinct: 0, unknown: 0
  });
  assert.deepEqual(result.coverage, {
    details: { loaded: 0, pending: 0, rate: null },
    map: { mapped: 0, unmapped: 0, rate: null }
  });
  assertProfileInvariants(result, 0);
  assertProfileInvariants(result.delayed, 0);
});

test('reports archive age without claiming continuous baseline coverage', () => {
  assert.deepEqual(summary([], {
    oldestSubmittedAt: '2026-07-07T12:30:00.000Z'
  }).history, {
    span_days: 14,
    target_days: 14,
    target_reached: true,
    continuity_verified: false
  });
  assert.deepEqual(summary([], {
    oldestSubmittedAt: '2026-07-07T12:30:00.001Z'
  }).history, {
    span_days: 13,
    target_days: 14,
    target_reached: false,
    continuity_verified: false
  });
  assert.deepEqual(summary([], { oldestSubmittedAt: null }).history, {
    span_days: 0,
    target_days: 14,
    target_reached: false,
    continuity_verified: false
  });
});

test('validates the injected clock and configuration instead of using ambient time', () => {
  assert.equal(summary([], { windowMinutes: '15' }).window_minutes, 15);
  assert.throws(() => buildLiveSummary([], { asOf: 'invalid' }), /asOf/);
  assert.throws(() => summary([], { windowMinutes: 0 }), /windowMinutes/);
  assert.throws(() => summary([], { topCategoryLimit: -1 }), /topCategoryLimit/);
  assert.throws(() => summary([], { topBoroughLimit: 1.5 }), /topBoroughLimit/);
  assert.throws(() => summary([], { historyTargetDays: -1 }), /historyTargetDays/);
});
