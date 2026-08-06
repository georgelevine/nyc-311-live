'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const cheerio = require('cheerio');
const { DatabaseSync } = require('node:sqlite');

process.env.NYC311_SERVER_NO_LISTEN = '1';
const { compactLiveDashboardStats } = require('../server');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'live.html'), 'utf8');
const DASHBOARD = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'live-dashboard.js'),
  'utf8'
);
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'live-ui.css'), 'utf8');
const $ = cheerio.load(HTML);

function functionSource(name, nextName) {
  const start = DASHBOARD.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = nextName ? DASHBOARD.indexOf(`\n  function ${nextName}(`, start) : -1;
  assert.notEqual(end, -1, `missing function after ${name}`);
  return DASHBOARD.slice(start, end);
}

function monitorDatabase(states, zones = []) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE live_monitor_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE bid_collector_zone_state (
      boundary_version TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      zone_id TEXT NOT NULL,
      bbox_json TEXT NOT NULL,
      last_successful_poll_at TEXT,
      last_result_count INTEGER,
      saturation_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(boundary_version,plan_hash,zone_id)
    );
  `);
  const now = '2026-08-06T14:00:00.000Z';
  const insertState = database.prepare(`
    INSERT INTO live_monitor_state(key,value,updated_at) VALUES(?,?,?)
  `);
  for (const [key, value] of Object.entries(states)) {
    insertState.run(key, String(value), now);
  }
  const insertZone = database.prepare(`
    INSERT INTO bid_collector_zone_state(
      boundary_version,plan_hash,zone_id,bbox_json,last_successful_poll_at,
      last_result_count,saturation_count,last_error,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `);
  for (const zone of zones) {
    insertZone.run(
      zone.boundaryVersion || '2026-04-28',
      zone.planHash || 'p'.repeat(64),
      zone.zoneId,
      '{}',
      now,
      zone.resultCount == null ? 12 : zone.resultCount,
      zone.saturationCount || 0,
      zone.error || null,
      now
    );
  }
  return database;
}

test('BID-only mode has one dedicated, accessible collection-scope summary', () => {
  assert.equal($('#collector-scope-banner').length, 1);
  assert.equal($('#collector-scope-banner').attr('aria-live'), 'polite');
  assert.notEqual($('#collector-scope-banner').attr('hidden'), undefined);
  assert.equal($('#collector-scope-title').length, 1);
  assert.equal($('#collector-scope-detail').length, 1);
  assert.equal($('#collector-zone-health').length, 1);
  assert.equal($('#collector-cadence').length, 1);
  assert.match(CSS, /\.collector-scope-banner\b/);

  const renderScope = functionSource('renderCollectorScope', 'currentComparison');
  assert.match(renderScope, /currentCollectorScope\s*===\s*'bid_only'/);
  assert.match(renderScope, /BID-only live collection/i);
  assert.match(renderScope, /exact[^`'"\n]*BID/i);
  assert.match(renderScope, /zone_count/);
  assert.match(renderScope, /failed_zones/);
  assert.match(renderScope, /poll_interval_seconds/);
  assert.doesNotMatch(renderScope, /audit|reconcil/i);
});

test('BID-only summaries describe exact BID capture without operator audit language', () => {
  const coverage = functionSource('coverageSummary', 'historySummary');
  assert.match(coverage, /Exact BID map matches/);
  assert.match(coverage, /Live map feed · provisional/);

  const history = functionSource('historySummary', 'durationSummary');
  const bidBranch = history.match(
    /if \(currentCollectorScope === 'bid_only'\) \{([\s\S]*?)\n    \}/
  );
  assert.ok(bidBranch, 'history summary needs a dedicated BID-only branch');
  assert.match(bidBranch[1], /BID/i);
  assert.doesNotMatch(bidBranch[1], /audit|reconcil/i);

  assert.match(DASHBOARD, /NYC BIDs right now/);
  assert.match(DASHBOARD, /NYC right now/);
  assert.match(DASHBOARD, /Delayed map \+ audit/);
  assert.equal(HTML.includes('One-time reconciliation'), false);
});

test('BID-only map scope does not repurpose the citywide frontier as an audit card', () => {
  const start = DASHBOARD.indexOf("document.getElementById('frontier-label').textContent");
  const end = DASHBOARD.indexOf("document.getElementById('last-updated').textContent", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const frontierRendering = DASHBOARD.slice(start, end);

  assert.doesNotMatch(frontierRendering, /Number audit/i);
  assert.match(frontierRendering, /BID (?:map )?(?:scope|coverage)/i);
  assert.match(frontierRendering, /Latest frontier/);
});

test('BID-only cadence is visibly fixed while citywide cadence remains editable', () => {
  assert.match(
    DASHBOARD,
    /pollInterval\.disabled\s*=\s*currentCollectorScope\s*===\s*'bid_only'/
  );
  assert.match(DASHBOARD, /BID-only cadence is set by BID_POLL_INTERVAL_SECONDS/);
  assert.match(
    DASHBOARD,
    /finally\s*\{[\s\S]*?pollInterval\.disabled\s*=\s*currentCollectorScope\s*===\s*'bid_only'/
  );

  const renderScope = functionSource('renderCollectorScope', 'currentComparison');
  assert.match(renderScope, /poll_interval_seconds/);
  assert.match(renderScope, /fixed/i);
});

test('compact BID-only stats expose zone health and omit unrelated citywide state', t => {
  const planHash = 'p'.repeat(64);
  const legacy = JSON.stringify({
    version: 1,
    status: 'complete',
    total_candidates: 20,
    checked: 20,
    finished_at: '2026-08-05T12:00:00.000Z'
  });
  const zones = Array.from({ length: 12 }, (_unused, index) => ({
    planHash,
    zoneId: `bid-zone-${String(index + 1).padStart(2, '0')}`,
    error: index === 3 ? 'test failure' : null,
    saturationCount: index === 7 ? 1 : 0
  }));
  const database = monitorDatabase({
    collector_scope: 'bid_only',
    number_audit_mode: 'not_applicable_bid_only',
    live_frontier: '28420000',
    poll_interval_seconds: '15',
    bid_poll_interval_seconds: '60',
    bid_boundary_version: '2026-04-28',
    bid_boundary_sha256: 'a'.repeat(64),
    bid_query_plan_hash: planHash,
    bid_query_zone_count: '12',
    last_successful_poll_at: '2026-08-06T14:00:00.000Z',
    legacy_reconciliation: legacy
  }, zones);
  t.after(() => database.close());

  const stats = compactLiveDashboardStats(database);
  assert.equal(stats.collector_scope, 'bid_only');
  assert.equal(stats.number_audit_mode, 'not_applicable_bid_only');
  assert.equal(stats.frontier, null);
  assert.equal(stats.poll_interval_seconds, 60);
  assert.equal(stats.legacy_reconciliation, null);
  assert.deepEqual(stats.bid_collector, {
    boundary_version: '2026-04-28',
    boundary_sha256: 'a'.repeat(64),
    plan_hash: planHash,
    zone_count: 12,
    failed_zones: 1,
    saturated_zones: 1
  });
});

test('compact citywide stats retain frontier, reconciliation, and editable cadence semantics', t => {
  const database = monitorDatabase({
    collector_scope: 'citywide',
    number_audit_mode: 'citywide_suffix_gap',
    live_frontier: '28420000',
    poll_interval_seconds: '15',
    bid_poll_interval_seconds: '60',
    last_successful_poll_at: '2026-08-06T14:00:00.000Z',
    legacy_reconciliation: JSON.stringify({
      version: 1,
      status: 'complete',
      total_candidates: 20,
      checked: 20,
      finished_at: '2026-08-05T12:00:00.000Z'
    })
  });
  t.after(() => database.close());

  const stats = compactLiveDashboardStats(database);
  assert.equal(stats.collector_scope, 'citywide');
  assert.equal(stats.number_audit_mode, 'citywide_suffix_gap');
  assert.equal(stats.frontier, 28420000);
  assert.equal(stats.poll_interval_seconds, 15);
  assert.equal(stats.bid_collector, null);
  assert.equal(stats.legacy_reconciliation.status, 'complete');
});
