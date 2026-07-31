'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'public', 'live.html');
const dashboardPath = path.join(root, 'public', 'js', 'live-dashboard.js');
const uiCssPath = path.join(root, 'public', 'css', 'live-ui.css');
const html = fs.readFileSync(htmlPath, 'utf8');
const dashboard = fs.readFileSync(dashboardPath, 'utf8');
const uiCss = fs.readFileSync(uiCssPath, 'utf8');
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
  assert.equal($('.mobile-view-tabs .view-tab-copy strong').length, 3);
  assert.equal($('.mobile-view-tabs .view-tab-copy small').length, 3);
  assert.equal($('.requests-view > .requests-view-heading').length, 1);
  assert.equal($('.overview-view > .overview-heading').length, 1);
  assert.equal($('#request-filters > summary').length, 1);
  assert.equal($('#details-pending[aria-live="polite"]').length, 1);
  assert.equal($('#details-pending-count').length, 1);
  assert.equal($('#details-pending-items').length, 1);
});

test('map counts disclose pins whose submitted details are still loading', () => {
  assert.match(
    dashboard,
    /showing while submitted details load/,
    'coordinate-bearing records must remain visible while details load'
  );
});

test('request detail is labelled and status history is collapsed by default', () => {
  assert.equal($('#request-detail').attr('role'), 'dialog');
  assert.equal($('#request-detail').attr('aria-labelledby'), 'detail-problem');
  assert.equal($('#detail-email-updates').attr('open'), undefined);
  assert.equal($('#detail-archive-row dt').text(), 'Status tracking');
  assert.equal(dashboard.includes('Monitoring · next'), false);
});

test('overview exposes email delivery, enrollment, verification, and response-time metrics', () => {
  assert.equal($('#email-monitoring[aria-busy="true"]').length, 1);
  assert.equal($('#email-deliveries-total').length, 1);
  assert.equal($('#email-deliveries-usable').length, 1);
  assert.equal($('#email-subscriptions-count').length, 1);
  assert.equal($('#email-coverage-rate').length, 1);
  assert.equal($('#email-coverage-limitation').length, 1);
  assert.equal($('#monitored-count').length, 0);
  assert.equal($('#status-clarity').length, 0);
  assert.equal($('#release-speed').length, 1);
  assert.equal($('#release-total-time').length, 1);
  assert.equal(html.includes('Checked every 24 hours'), false);
  assert.equal($('#agency-response-times').closest('table').length, 1);
  assert.equal($('#complaint-response-times').closest('table').length, 1);
  assert.equal($('#overall-notification-median').length, 1);
  assert.equal($('#overall-notification-detail').length, 1);
  assert.equal($('#response-cohort-note').length, 1);
  assert.match($('#email-monitoring').text(), /known closures with an email/i);
  assert.match($('#email-monitoring').text(), /new-request confirmations/i);
  assert.match($('#email-monitoring').text(), /agency updates/i);
  assert.match($('#email-monitoring').text(), /closure notices/i);
  assert.match($('#email-coverage-limitation').text(), /independently confirmed closed/i);
  assert.equal($('.overview-operations:not([open])').length, 1);
  assert.match($('#response-time-definition').text(), /not official agency SLAs/i);
  assert.match($('#response-time-definition').text(), /first usable “Updated” email/i);
  assert.match($('#response-time-definition').text(), /closure time published by the NYC311 Portal/i);
  assert.match($('#response-time-definition').text(), /usable “Closed” email/i);
  assert.match($('#response-time-definition').text(), /Closure email delay/i);
  assert.match($('#response-time-definition').text(), /Median is the 50th percentile/i);
  assert.match($('#response-time-definition').text(), /n is the number of requests that reached/i);
  assert.equal($('.response-methodology').attr('open'), undefined);
  assert.equal($('.email-quality-notes').attr('open'), undefined);
  assert.match(dashboard, /90% within/);
  assert.match(dashboard, /Insufficient sample/);
  assert.match(dashboard, /Limited sample/);
  assert.match(dashboard, /Show all/);
  assert.match(dashboard, /Observed since/);
  assert.match(dashboard, /known closures \$\{matureAge\} had a matched Closed email/);
  assert.match(dashboard, /Each median uses requests that reached that event/);
  assert.match(dashboard, /Coverage compares closure emails with requests independently confirmed closed/);
  assert.match(dashboard, /Release timing service/);
});

test('overview exposes lightweight health for every live pipeline', () => {
  assert.equal($('#system-health[aria-busy="true"]').length, 1);
  assert.equal($('#system-health-overall').length, 1);
  assert.equal($('#system-health-updated').length, 1);
  assert.deepEqual(
    $('[data-health-component]').map((_index, element) => (
      $(element).attr('data-health-component')
    )).get(),
    [
      'collector',
      'details',
      'email',
      'closures',
      'database',
      'map',
      'subscriptions',
      'analytics'
    ]
  );
  assert.match(dashboard, /fetchJson\('\/api\/operational-health'/);
  assert.match(dashboard, /const OPERATIONAL_HEALTH_REFRESH_MS = 15_000/);
  assert.match(dashboard, /refreshOperationalHealth\(\)\.finally/);
});

test('overview omits one-time reconciliation operator information', () => {
  assert.equal($('#legacy-reconciliation').length, 0);
  assert.equal(html.includes('One-time reconciliation'), false);
  assert.equal(dashboard.includes('renderLegacyReconciliation'), false);
  assert.equal(dashboard.includes('legacyReconciliationElements'), false);
});

test('request detail exposes status evidence separately from the status history timeline', () => {
  assert.equal($('#detail-status-evidence').length, 1);
  assert.equal($('#detail-evidence-summary').length, 1);
  assert.equal($('#detail-evidence-email').length, 1);
  assert.equal($('#detail-evidence-portal').length, 1);
  assert.equal($('#detail-agency-response').length, 1);
  assert.equal($('#detail-agency-response-text').length, 1);
  assert.equal($('#detail-agency-response-time').length, 1);
  assert.equal($('#detail-agency-response-source').length, 1);
  assert.match($('#detail-agency-response').text(), /Latest agency response/i);
  assert.match(dashboard, /agencyResponse:\s*record\.agency_response/);
  assert.match(dashboard, /latestAgencyResponse\(/);
  assert.match(
    dashboard,
    /renderAgencyResponse\(portalDetailByNumber\.get\(record\.srnumber\) \|\| null\)/
  );
  assert.match(uiCss, /\.detail-agency-response\.hidden\s*\{\s*display:\s*none/);
  assert.match(dashboard, /Portal updated/);
  assert.equal($('#detail-email-updates > summary').text().includes('Update history'), true);
  assert.match(dashboard, /NYC311 confirms this request is closed/);
  assert.match(dashboard, /Portal confirmation is still in progress/);
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

test('overview metrics load lazily, refresh only while visible, and degrade independently', () => {
  assert.match(dashboard, /const LIVE_SUMMARY_REFRESH_MS = 60_000/);
  assert.match(dashboard, /fetchJson\(\s*scopedUrl\('\/api\/live-summary'\)/);
  assert.match(dashboard, /const EMAIL_METRICS_REFRESH_MS = 60_000/);
  assert.match(dashboard, /fetchJson\('\/api\/email-metrics', 'Email metrics service'\)/);
  assert.match(dashboard, /syncOverviewRefreshes\(normalizedView === 'overview'\)/);
  assert.match(dashboard, /function overviewIsActive\(\)/);
  assert.match(dashboard, /function scheduleOverviewEmailMetrics/);
  assert.match(dashboard, /function scheduleOverviewSummary/);
  assert.match(dashboard, /scheduleOverviewSummary\(lastGoodSummary\s*\?[\s\S]*?: 0\)/);
  assert.match(dashboard, /function scheduleOverviewReleaseInfo/);
  assert.match(dashboard, /if \(!overviewIsActive\(\) \|\| emailMetricsInFlight/);
  assert.match(dashboard, /if \(!overviewIsActive\(\) \|\| releaseInfoInFlight/);
  assert.equal(dashboard.includes('window.setInterval(refreshEmailMetrics'), false);
  assert.equal(dashboard.includes('window.setInterval(refreshReleaseInfo'), false);
  const startup = dashboard.slice(dashboard.lastIndexOf('loadPolicePrecincts();'));
  assert.equal(startup.includes('refreshEmailMetrics();'), false);
  assert.equal(startup.includes('refreshReleaseInfo();'), false);
  assert.match(dashboard, /payload && payload\.refreshing === true/);
  assert.match(dashboard, /const EMAIL_METRICS_REFRESHING_RETRY_MS = 2_500/);
  assert.match(dashboard, /let emailMetricsRefreshPending = false/);
  assert.match(dashboard, /emailMetricsRefreshPending = true/);
  assert.match(dashboard, /emailMetricsRefreshPending\s*\?\s*EMAIL_METRICS_REFRESHING_RETRY_MS/);
  assert.match(dashboard, /window\.clearTimeout\(overviewEmailMetricsTimer\)/);
  assert.match(dashboard, /Math\.max\(2_000, Math\.min\(3_000, suggestedDelay\)\)/);
  assert.match(dashboard, /scheduleOverviewEmailMetrics\(Number\.isFinite\(suggestedDelay\)/);
  assert.match(dashboard, /Calculating email and response-time statistics in the background/);
  assert.match(dashboard, /Requests and the map remain available/);
  assert.equal(dashboard.includes('window.setInterval(refresh, 5000)'), false);
  assert.match(dashboard, /nextDashboardRefreshDelay/);
  assert.match(dashboard, /scheduleDashboardRefresh/);
  assert.match(dashboard, /Showing the last successful email metrics refresh/);
  assert.match(dashboard, /Live requests are still updating/);
});

test('initial boundary loading cannot replace honest request and map loading states', () => {
  assert.match(dashboard, /let dashboardPayloadLoaded = false/);
  assert.match(dashboard, /dashboardPayloadLoaded = true/);
  assert.match(dashboard, /!dashboardPayloadLoaded\s*\?\s*'Loading requests…'/);
  assert.match(dashboard, /if \(dashboardPayloadLoaded\) \{\s*renderFeed\(\);\s*renderMap\(\);/);
  assert.match(dashboard, /mapArchiveLoaded\s*\?\s*`\$\{mapScopeLabel\(\)\} · no matching dated pins`/);
  assert.match(dashboard, /`\$\{mapScopeLabel\(\)\} · loading map records`/);
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

test('map startup is self-hosted, exhaustively paginated, and automatically recoverable', () => {
  assert.equal($('script[src*="unpkg.com"], link[href*="unpkg.com"]').length, 0);
  assert.equal($('script[src="/vendor/leaflet/leaflet.js"]').length, 1);
  assert.equal(
    $('script[src="/vendor/leaflet-markercluster/leaflet.markercluster.js"]').length,
    1
  );
  assert.equal($('#map-load-status[role="status"]').length, 1);
  assert.match(
    dashboard,
    /L\.map\('map',\s*\{[\s\S]*?maxZoom:\s*19[\s\S]*?\}\)\.setView/,
    'the map needs an explicit maxZoom before MarkerCluster is attached'
  );
  assert.ok(
    dashboard.indexOf('let mapStats = {') < dashboard.indexOf('map.addLayer(markerLayer);'),
    'MarkerCluster callbacks must not run before map state is initialized'
  );
  assert.match(dashboard, /chunkedLoading:\s*true/);
  assert.match(dashboard, /const MAP_INITIAL_PAGE_SIZE = 250/);
  assert.match(dashboard, /const MAP_PAGE_SIZE = 1_000/);
  assert.match(dashboard, /const MAP_REFRESH_MS = 5 \* 60_000/);
  assert.match(dashboard, /const MAP_REQUEST_TIMEOUT_MS = 15_000/);
  assert.match(dashboard, /const MAP_RETRY_MS = 3_000/);
  assert.match(dashboard, /const MAP_PAGE_YIELD_MS = 100/);
  assert.match(dashboard, /const FEED_PAGE_SIZE = 300/);
  assert.match(dashboard, /const INITIAL_FEED_PAGE_SIZE = 100/);
  assert.match(
    dashboard,
    /const requestLimit = firstDashboardPayload \|\| queryChanged \|\| restartFeedHead\s*\? INITIAL_FEED_PAGE_SIZE\s*: FEED_PAGE_SIZE/
  );
  assert.match(
    dashboard,
    /live-dashboard', \{\s*limit: requestLimit,\s*compact: 1,\s*paginate: 1,\s*include_totals: includeTotals/
  );
  assert.match(
    dashboard,
    /const includeTotals = Object\.keys\(dataFilters\)\.length === 0 \? 1 : 0/
  );
  assert.match(
    dashboard,
    /const resetUncountedFilteredFeed = includeTotals === 0/
  );
  assert.match(
    dashboard,
    /function browsingDeepFilteredResults\(\)[\s\S]*feedLoadingMore \|\| records\.length > INITIAL_FEED_PAGE_SIZE[\s\S]*feed\.scrollTop > 50/
  );
  assert.match(
    dashboard,
    /if \(!force && browsingDeepFilteredResults\(\)\) \{\s*updateFeedCoverage\(\);\s*return;/g
  );
  assert.match(
    dashboard,
    /browsing older results; return to top for live refresh/
  );
  assert.match(
    dashboard,
    /Live collection · browsing older results/
  );
  assert.match(
    dashboard,
    /NYC · Live view paused while browsing/
  );
  assert.match(
    dashboard,
    /const preserveFeedDepth = includeTotals === 1\s*&& !queryChanged && !restartFeedHead/
  );
  assert.match(
    dashboard,
    /reset: firstDashboardPayload \|\| queryChanged \|\| restartFeedHead\s*\|\| resetUncountedFilteredFeed/
  );
  assert.match(
    dashboard,
    /dashboardPayloadLoaded\s*\? 'Live · refresh delayed'\s*: 'Connecting · refresh delayed'/
  );
  assert.match(
    dashboard,
    /if \(connection\.classList\.contains\('offline'\)\) \{\s*connectionLabel\.textContent = 'Reconnecting…'/
  );
  assert.match(dashboard, /async function loadMoreFeed/);
  assert.match(dashboard, /before_suffix: beforeSuffix/);
  assert.match(dashboard, /pagesLoaded === 0 \? MAP_INITIAL_PAGE_SIZE : MAP_PAGE_SIZE/);
  assert.match(dashboard, /include_totals: pagesLoaded === 0 \? 1 : 0/);
  assert.match(dashboard, /paginate:\s*1/);
  assert.match(dashboard, /while \(hasMore\)/);
  assert.doesNotMatch(dashboard, /pagesLoaded < 500/);
  assert.match(
    dashboard,
    /await new Promise\(resolve => window\.setTimeout\(resolve, MAP_PAGE_YIELD_MS\)\)/
  );
  assert.match(dashboard, /before_suffix:\s*beforeSuffix/);
  assert.match(dashboard, /submitted_since:\s*submittedSince/);
  assert.match(
    dashboard,
    /mapArchiveLoaded && !mapRefreshInFlight\s*\?\s*mergeMapRecords\(records\)/
  );
  assert.match(
    dashboard,
    /\(mapNeedsRefresh \|\| !mapArchiveLoaded\)[\s\S]*refreshMap\(mapStats\)/
  );
  assert.match(dashboard, /Map data took too long\./);
  assert.match(dashboard, /\? ' Retrying…'/);
  assert.match(dashboard, /tile\.openstreetmap\.org/);
  assert.match(dashboard, /if \(!compactLayout\.matches\) ensureBaseTiles\(\)/);
  assert.match(
    dashboard,
    /if \(!mapHasLayout\(\)\) return;\s*ensureBaseTiles\(\);\s*map\.invalidateSize/
  );
});

test('a hidden mobile filter change cannot let an old map request complete the new scope', () => {
  const refreshStart = dashboard.indexOf('async function refreshMap(');
  const refreshEnd = dashboard.indexOf('\n  async function refresh(', refreshStart);
  const refreshSource = dashboard.slice(refreshStart, refreshEnd);
  const forceIndex = refreshSource.indexOf('if (force) {');
  const layoutIndex = refreshSource.indexOf('if (!mapHasLayout()) return');
  assert.ok(forceIndex >= 0 && forceIndex < layoutIndex);
  assert.match(
    refreshSource,
    /if \(sequence !== mapRequestSequence\) return;\s*if \(expectedMapped !== stagedNumberSet\.size\)/
  );

  const invalidationStart = dashboard.indexOf('function invalidateMapLoad(');
  const invalidationEnd = dashboard.indexOf('\n  function scheduleMapRetry(', invalidationStart);
  const invalidationSource = dashboard.slice(invalidationStart, invalidationEnd);
  assert.match(invalidationSource, /mapAbortController\.abort\(\)/);
  assert.match(invalidationSource, /mapRequestSequence \+= 1/);
  assert.match(invalidationSource, /mapRefreshInFlight = false/);
  assert.match(invalidationSource, /mapArchiveLoaded = false/);

  const resetStart = dashboard.indexOf('function resetMapDataset(');
  const resetEnd = dashboard.indexOf('\n  function replaceMapDataset(', resetStart);
  assert.match(dashboard.slice(resetStart, resetEnd), /invalidateMapLoad\(\)/);

  const feedStart = dashboard.indexOf('function updateFeedRecords(');
  const feedEnd = dashboard.indexOf('\n  function finiteStat(', feedStart);
  assert.match(
    dashboard.slice(feedStart, feedEnd),
    /mapArchiveLoaded && !mapRefreshInFlight\s*\?\s*mergeMapRecords\(records\)/,
    'only an idle, completed map snapshot may accept newer live-feed pins'
  );
  assert.match(
    refreshSource,
    /const stagedNumbers = \[\];\s*const stagedNumberSet = new Set\(\);\s*const stagedChanges = new Map\(\)/
  );
  assert.match(
    refreshSource,
    /if \(expectedMapped !== stagedNumberSet\.size\)/
  );
  assert.match(
    refreshSource,
    /mapArchiveLoaded = true;\s*replaceMapDataset\(\{\s*records: stagedNumbers\.map\(number => \(\s*stagedChanges\.get\(number\) \|\| mapByNumber\.get\(number\)/
  );
  assert.match(
    refreshSource,
    /if \(!previous \|\| recordSignature\(previous\) !== recordSignature\(record\)\) \{\s*stagedChanges\.set/
  );

  const layoutStart = dashboard.indexOf('function scheduleMapLayout(');
  const layoutEnd = dashboard.indexOf('\n  function scheduleSelectedBoundaryFit(', layoutStart);
  const layoutSource = dashboard.slice(layoutStart, layoutEnd);
  assert.equal((layoutSource.match(/refreshMap\(mapStats\)/g) || []).length, 1);
  assert.match(
    layoutSource,
    /\(mapNeedsRefresh \|\| !mapArchiveLoaded\) && !mapRefreshInFlight[\s\S]*refreshMap\(mapStats\)/
  );
});

test('map starts recent, keeps the chosen date scope during filters, and discloses the range', () => {
  assert.equal($('#map-scope button[data-map-scope="all"]').text().trim(), 'All dates');
  assert.equal($('#map-scope button[data-map-scope="all"]').attr('aria-pressed'), 'false');
  assert.equal($('#map-scope button[data-map-scope="24h"]').attr('aria-pressed'), 'true');
  assert.equal($('#map-date-range[aria-live="polite"]').length, 1);
  assert.match($('#map-date-range').text(), /Last 24 hours/);
  assert.match(dashboard, /let mapScope = '24h'/);
  assert.doesNotMatch(dashboard, /showAllDatesForActiveFilters/);
  assert.match(dashboard, /All captured dates/);
  assert.match(dashboard, /mapRangeDateFormatter/);
});

test('pending details stay separate from complete request cards but remain map-visible', () => {
  assert.match(dashboard, /recordDetailsPending/);
  assert.match(dashboard, /renderPendingDetails/);
  assert.match(dashboard, /Complete requests will appear here/);
  assert.match(dashboard, /return recordDetailsPending\(record\) \? 'pending' : ''/);
  assert.match(dashboard, /requestKind: markerClass\(record\) \|\| 'active'/);
  assert.doesNotMatch(
    dashboard,
    /recordDetailsPending\(record\)\s*\|\|\s*!matchesMapScope/
  );
});

test('boundary releases and large marker builds cannot leave stale map state', () => {
  assert.match(
    dashboard,
    /state\.requestedVersion === version/
  );
  assert.match(
    dashboard,
    /state\.requestedVersion = version/
  );
  assert.match(
    dashboard,
    /version:\s*precinctBoundaryVersion/
  );
  assert.match(
    dashboard,
    /version:\s*bidBoundaryVersion/
  );
  assert.match(
    dashboard,
    /if \(markerLayerBuilding && desiredChanged\) \{\s*markerLayerDeferredRender = true;\s*return;/
  );
  const replacementStart = dashboard.indexOf('function replaceMapDataset(');
  const replacementEnd = dashboard.indexOf('\n  async function fetchJson(', replacementStart);
  assert.doesNotMatch(
    dashboard.slice(replacementStart, replacementEnd),
    /replaceMarkerClusterLayer\(\)/,
    'a normal refresh must update the existing cluster rather than rebuilding every pin'
  );
  assert.match(dashboard, /Data complete · drawing/);
});

test('geography catalogs retain release identity and retry transient failures', () => {
  assert.match(dashboard, /const GEOGRAPHY_CATALOG_TIMEOUT_MS = 5_000/);
  assert.match(dashboard, /const GEOGRAPHY_CATALOG_REFRESH_MS = 5 \* 60_000/);
  assert.match(dashboard, /function geographyCatalogRetryDelay\(attempt\)/);
  assert.match(dashboard, /precinct_boundary_version/);
  assert.match(dashboard, /bid_boundary_version/);
  assert.match(dashboard, /if \(error\.status === 409\)/);
});

test('map and feed pagination reject stale, repeated, and non-progressing pages', () => {
  assert.match(dashboard, /validatePaginatedRecords\(pageRecords, \{/);
  assert.match(dashboard, /expectedSnapshot: snapshotAt/);
  assert.match(dashboard, /existingNumbers: stagedNumberSet/);
  assert.match(dashboard, /expectedTotal: expectedMapped/);
  assert.match(dashboard, /loadedCount: stagedNumberSet\.size/);
  assert.match(dashboard, /existingNumbers: feedByNumber/);
  assert.match(dashboard, /const MAP_MAX_FAST_RETRIES = 3/);
  assert.match(dashboard, /mapRetryAttempt >= MAP_MAX_FAST_RETRIES/);
  assert.match(dashboard, /Fast retries paused; the next scheduled refresh will try again/);
});

test('long map crawls traverse stable membership and apply mutable filters client-side', () => {
  const refreshStart = dashboard.indexOf('async function refreshMap(');
  const refreshEnd = dashboard.indexOf('\n  async function refresh(', refreshStart);
  const refreshSource = dashboard.slice(refreshStart, refreshEnd);
  assert.match(refreshSource, /const displayFilters = activeDataFilters\(\)/);
  assert.doesNotMatch(refreshSource, /Map filter totals/);
  assert.doesNotMatch(refreshSource, /\.\.\.displayFilters/);
  assert.match(
    refreshSource,
    /stats: hasMutableDisplayFilters \? \{\} : stagedStats \|\| \{\}/
  );
  const traversalLoop = refreshSource.slice(refreshSource.indexOf('while (hasMore)'));
  assert.doesNotMatch(
    traversalLoop.slice(0, traversalLoop.indexOf('if (sequence !== mapRequestSequence) return;')),
    /\.\.\.displayFilters/,
    'the archive traversal itself must not depend on mutable text or status values'
  );
  assert.match(
    dashboard,
    /!coordinates \|\| !matchesMapScope\(record, now\) \|\| !matchesFilters\(record\)/
  );
  const filterStart = dashboard.indexOf('function scheduleFilterRefresh(');
  const filterEnd = dashboard.indexOf("\n  search.addEventListener('input'", filterStart);
  const filterSource = dashboard.slice(filterStart, filterEnd);
  assert.match(
    filterSource,
    /if \(mapArchiveLoaded\)[\s\S]*preserveArchive: true[\s\S]*renderMap\(\)/
  );
});

test('deep feed restarts when the live head cannot explain a changed total', () => {
  assert.match(dashboard, /feedHeadMembershipDelta\(records, headRecords\)/);
  assert.match(
    dashboard,
    /nextMatchingTotal - Number\(previousMatchingTotal\) !== expectedTotalDelta/
  );
  assert.match(dashboard, /reset:[\s\S]*deepSnapshotChanged/);
  assert.match(
    dashboard,
    /!pageState\.hasMore && feedMatchingTotal !== null[\s\S]*requestFeedHeadRestart\(\)/
  );
  assert.match(dashboard, /feedHeadRestartRequired = true/);
});

test('geography catalogs preserve last-good data and refresh a stale boundary release', () => {
  assert.match(dashboard, /boundaryCatalogIsUsable\(precincts, version\)/);
  assert.match(dashboard, /boundaryCatalogIsUsable\(districts, version\)/);
  assert.match(
    dashboard,
    /if \(!precinctBoundaryVersion\) \{[\s\S]*Precinct filter unavailable · retrying/
  );
  assert.match(
    dashboard,
    /if \(!bidBoundaryVersion\) \{[\s\S]*BID filter unavailable · retrying/
  );
  const boundaryStart = dashboard.indexOf('async function loadSelectedBoundary(');
  const boundaryEnd = dashboard.indexOf('\n  function syncSelectedBoundaries(', boundaryStart);
  const boundarySource = dashboard.slice(boundaryStart, boundaryEnd);
  assert.match(boundarySource, /if \(error\.status === 409\)/);
  assert.match(boundarySource, /void loadPolicePrecincts\(\)/);
  assert.match(boundarySource, /void loadBusinessImprovementDistricts\(\)/);
  assert.match(boundarySource, /else if \(state\.attempt < 3\)/);
});

test('a hidden map remembers that its failed refresh still needs to run', () => {
  assert.match(dashboard, /let mapNeedsRefresh = true/);
  assert.match(dashboard, /mapNeedsRefresh = true;\s*if \(!preserveArchive\)/);
  assert.match(
    dashboard,
    /\(mapNeedsRefresh \|\| !mapArchiveLoaded\) && !mapRefreshInFlight[\s\S]*refreshMap\(mapStats\)/
  );
  assert.match(dashboard, /mapRetryAttempt = 0;\s*mapNeedsRefresh = false/);
});

test('queued markers cannot throw on selection and map-only pending state changes its icon', () => {
  assert.match(
    dashboard,
    /record\.status,\s*markerClass\(record\),\s*record\.problem_details/
  );
  assert.match(
    dashboard,
    /if \(marker && marker\.__parent\) markerLayer\.zoomToShowLayer\(marker\)/
  );
});

test('map-only records retrieve stored details instead of inventing an empty detail payload', () => {
  assert.match(dashboard, /function recordHasEmbeddedPortalDetail/);
  assert.match(
    dashboard,
    /Object\.prototype\.hasOwnProperty\.call\(record, 'problem_details'\)/
  );
  assert.match(dashboard, /if \(recordHasEmbeddedPortalDetail\(record\)\)/);
  assert.match(dashboard, /preferArchive=1/);
});
