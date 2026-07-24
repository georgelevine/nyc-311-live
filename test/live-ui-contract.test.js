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
