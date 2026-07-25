'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'public', 'live.html');
const dashboardPath = path.join(root, 'public', 'js', 'live-dashboard.js');
const html = fs.readFileSync(htmlPath, 'utf8');
const dashboard = fs.readFileSync(dashboardPath, 'utf8');
const $ = cheerio.load(html);

test('dashboard IDs are unique and every JavaScript ID lookup has matching markup', () => {
  const counts = new Map();
  $('[id]').each((_index, element) => {
    const id = $(element).attr('id');
    counts.set(id, (counts.get(id) || 0) + 1);
  });
  assert.deepEqual(
    [...counts].filter(([, count]) => count !== 1),
    []
  );

  const referencedIds = [...dashboard.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)]
    .map(match => match[1]);
  const missingIds = [...new Set(referencedIds)].filter(id => !counts.has(id));
  assert.deepEqual(missingIds, []);
});

test('dashboard keeps requests, map, and overview as explicit responsive views', () => {
  assert.equal($('.requests-view').length, 1);
  assert.equal($('.overview-view').length, 1);
  assert.equal($('button[data-mobile-view="feed"]').length, 1);
  assert.equal($('button[data-mobile-view="map"]').length, 1);
  assert.equal($('button[data-mobile-view="overview"]').length, 1);
  assert.equal($('#request-filters > summary').length, 1);
});

test('request detail is labelled and status history is collapsed by default', () => {
  assert.equal($('#request-detail').attr('role'), 'dialog');
  assert.equal($('#request-detail').attr('aria-labelledby'), 'detail-problem');
  assert.equal($('#detail-email-updates').attr('open'), undefined);
});

test('overview exposes email delivery, enrollment, verification, and response-time metrics', () => {
  assert.equal($('#email-monitoring[aria-busy="true"]').length, 1);
  assert.equal($('#email-deliveries-total').length, 1);
  assert.equal($('#email-deliveries-usable').length, 1);
  assert.equal($('#email-subscriptions-count').length, 1);
  assert.equal($('#email-coverage-rate').length, 1);
  assert.equal($('#email-coverage-limitation').length, 1);
  assert.equal($('#subscription-count').length, 1);
  assert.equal($('#monitored-count').length, 0);
  assert.equal(html.includes('Checked every 24 hours'), false);
  assert.equal($('#agency-response-times').closest('table').length, 1);
  assert.equal($('#complaint-response-times').closest('table').length, 1);
  assert.equal($('#overall-notification-median').length, 1);
  assert.equal($('#overall-notification-detail').length, 1);
  assert.equal($('#response-cohort-note').length, 1);
  assert.match($('#email-monitoring').text(), /known Portal closure coverage/i);
  assert.match($('#email-coverage-limitation').text(), /independently found/i);
  assert.match($('#response-time-definition').text(), /not official agency SLAs/i);
  assert.match($('#response-time-definition').text(), /first usable “Updated” email/i);
  assert.match($('#response-time-definition').text(), /closure time published by the NYC311 Portal/i);
  assert.match($('#response-time-definition').text(), /usable “Closed” email/i);
  assert.match($('#response-time-definition').text(), /Closure email delay/i);
  assert.match($('#response-time-definition').text(), /Median is the 50th percentile/i);
  assert.match($('#response-time-definition').text(), /n is the number of requests that reached/i);
});

test('email event rendering distinguishes Submitted, Updated, and Closed', () => {
  assert.match(dashboard, /rawEventKind === 'closed'/);
  assert.match(dashboard, /rawEventKind === 'submitted' \? 'Submitted' : 'Updated'/);
});

test('status update UI exposes incomplete Portal verification without calling it verified', () => {
  assert.match(dashboard, /finalState === 'detail_unconfirmed'/);
  assert.match(dashboard, /Portal detail did not confirm closure/);
  assert.match(dashboard, /Portal status is closed; detail verification unavailable/);
});

test('email metrics refresh independently once per minute and degrades independently', () => {
  assert.match(dashboard, /const EMAIL_METRICS_REFRESH_MS = 60_000/);
  assert.match(dashboard, /fetchJson\('\/api\/email-metrics', 'Email metrics service'\)/);
  assert.match(
    dashboard,
    /window\.setInterval\(refreshEmailMetrics, EMAIL_METRICS_REFRESH_MS\)/
  );
  assert.match(dashboard, /Showing the last successful email metrics refresh/);
  assert.match(dashboard, /Live requests are still updating/);
});

test('local dashboard styles and scripts resolve to committed files in load order', () => {
  const localAssets = $('link[href^="/"], script[src^="/"]').map((_index, element) => (
    $(element).attr('href') || $(element).attr('src')
  )).get();
  for (const asset of localAssets) {
    assert.equal(fs.existsSync(path.join(root, 'public', asset)), true, asset);
  }
  const scripts = $('script[src^="/js/"]').map((_index, element) => $(element).attr('src')).get();
  assert.deepEqual(scripts.slice(-3), [
    '/js/status-update-model.js',
    '/js/live-dashboard-model.js',
    '/js/live-dashboard.js'
  ]);
});
