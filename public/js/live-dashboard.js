(() => {
  const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([40.7128, -74.0060], 11);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  const primaryTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap &copy; CARTO'
  });
  const fallbackTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  });
  let primaryTileErrors = 0;
  let usingFallbackTiles = false;
  primaryTiles.on('tileload', () => {
    primaryTileErrors = 0;
  });
  primaryTiles.on('tileerror', () => {
    primaryTileErrors += 1;
    if (usingFallbackTiles || primaryTileErrors < 4) return;
    usingFallbackTiles = true;
    map.removeLayer(primaryTiles);
    fallbackTiles.addTo(map);
  });
  primaryTiles.addTo(map);
  const GEOGRAPHY_PANE = 'boundary';
  const geographyPane = map.createPane(GEOGRAPHY_PANE);
  geographyPane.style.zIndex = '350';
  geographyPane.style.pointerEvents = 'none';
  const geographyRenderer = L.svg({ pane: GEOGRAPHY_PANE });
  const markerLayer = L.markerClusterGroup({
    chunkedLoading: true,
    chunkInterval: 100,
    chunkDelay: 25,
    removeOutsideVisibleBounds: true,
    maxClusterRadius: 42,
    showCoverageOnHover: false,
    iconCreateFunction: cluster => {
      const markers = cluster.getAllChildMarkers();
      const count = markers.length;
      const kinds = new Set(markers.map(marker => marker.options.requestKind));
      const kind = kinds.size === 1 && kinds.has('closed') ? 'closed' : 'active';
      const size = count < 10 ? 'small' : count < 100 ? 'medium' : 'large';
      return L.divIcon({
        html: `<div><span>${count}</span></div>`,
        className: `marker-cluster marker-cluster-${size} ${kind}`,
        iconSize: L.point(40, 40)
      });
    }
  });
  map.addLayer(markerLayer);

  const feed = document.getElementById('request-feed');
  const appShell = document.querySelector('.app-shell');
  const mobileViewTabs = document.querySelector('.mobile-view-tabs');
  const search = document.getElementById('request-search');
  const statusFilter = document.getElementById('status-filter');
  const precinctFilter = document.getElementById('precinct-filter');
  const bidFilter = document.getElementById('bid-filter');
  const connection = document.querySelector('.live-state');
  const connectionLabel = document.getElementById('connection-label');
  const pollInterval = document.getElementById('poll-interval');
  const detail = document.getElementById('request-detail');
  const mapScopeControl = document.getElementById('map-scope');
  const mapCounts = document.getElementById('map-counts');
  const mapDateRange = document.getElementById('map-date-range');
  const mapLoadStatus = document.getElementById('map-load-status');
  const mapBoundaryKey = document.getElementById('map-boundary-key');
  const requestFilters = document.getElementById('request-filters');
  const activeFilterCount = document.getElementById('active-filter-count');
  const detailsPending = document.getElementById('details-pending');
  const detailsPendingCount = document.getElementById('details-pending-count');
  const detailsPendingItems = document.getElementById('details-pending-items');
  const detailPendingBadge = document.getElementById('detail-pending-badge');
  const detailEmailUpdates = document.getElementById('detail-email-updates');
  const detailEmailCount = document.getElementById('detail-email-count');
  const detailEmailEvents = document.getElementById('detail-email-events');
  const {
    buildEmailMetricsModel,
    buildStatusUpdateModel,
    currentClosureSnapshot,
    formatMetricDuration,
    latestAgencyResponse,
    requestArchiveLabel
  } = window.NYC311StatusUpdateModel;
  const {
    activeFilterLabel,
    exactSrnumberQuery: normalizeExactSrnumberQuery,
    feedCardModel,
    isClosed,
    mapScopeAfterFilterChange,
    recordCoordinates,
    recordDetailsPending,
    recordHasMapPin
  } = window.NYC311LiveDashboardModel;
  const compactLayout = window.matchMedia('(max-width: 900px)');
  const summaryElements = {
    root: document.getElementById('city-summary'),
    eyebrow: document.getElementById('city-summary-eyebrow'),
    title: document.getElementById('city-summary-title'),
    updated: document.getElementById('city-summary-updated'),
    loading: document.getElementById('city-summary-loading'),
    content: document.getElementById('city-summary-content'),
    requestCount: document.getElementById('summary-request-count'),
    comparison: document.getElementById('summary-comparison'),
    categories: document.getElementById('summary-categories'),
    otherCategories: document.getElementById('summary-other-categories'),
    boroughs: document.getElementById('summary-boroughs'),
    otherBoroughs: document.getElementById('summary-other-boroughs'),
    coverage: document.getElementById('summary-coverage'),
    history: document.getElementById('summary-history-note'),
    status: document.getElementById('city-summary-status')
  };
  const hasSummaryElements = Object.values(summaryElements).every(Boolean);
  const healthComponentNames = [
    'database',
    'collector',
    'map',
    'details',
    'email',
    'subscriptions',
    'closures',
    'analytics'
  ];
  const systemHealthElements = {
    root: document.getElementById('system-health'),
    overall: document.getElementById('system-health-overall'),
    updated: document.getElementById('system-health-updated'),
    cards: Object.fromEntries(healthComponentNames.map(name => [
      name,
      {
        root: document.querySelector(`[data-health-component="${name}"]`),
        status: document.getElementById(`health-${name}-status`),
        detail: document.getElementById(`health-${name}-detail`)
      }
    ]))
  };
  const hasSystemHealthElements = Boolean(
    systemHealthElements.root
    && systemHealthElements.overall
    && systemHealthElements.updated
    && Object.values(systemHealthElements.cards)
      .every(card => card.root && card.status && card.detail)
  );
  const emailMetricElements = {
    root: document.getElementById('email-monitoring'),
    mode: document.getElementById('email-monitoring-mode'),
    total: document.getElementById('email-deliveries-total'),
    usable: document.getElementById('email-deliveries-usable'),
    lastReceived: document.getElementById('email-deliveries-last'),
    submitted: document.getElementById('email-submitted-count'),
    updated: document.getElementById('email-updated-count'),
    closed: document.getElementById('email-closed-count'),
    issues: document.getElementById('email-issues-count'),
    subscriptions: document.getElementById('email-subscriptions-count'),
    subscriptionNote: document.getElementById('email-subscriptions-note'),
    coverage: document.getElementById('email-coverage-rate'),
    coverageNote: document.getElementById('email-coverage-note'),
    coverageLimitation: document.getElementById('email-coverage-limitation'),
    status: document.getElementById('email-metrics-status'),
    archiveSubscriptions: document.getElementById('subscription-count'),
    archiveSubscriptionNote: document.getElementById('subscription-note'),
    responseRoot: document.getElementById('response-time-metrics'),
    responseUpdated: document.getElementById('response-times-updated'),
    overallUpdateMedian: document.getElementById('overall-update-median'),
    overallUpdateDetail: document.getElementById('overall-update-detail'),
    overallClosureMedian: document.getElementById('overall-closure-median'),
    overallClosureDetail: document.getElementById('overall-closure-detail'),
    overallNotificationMedian: document.getElementById('overall-notification-median'),
    overallNotificationDetail: document.getElementById('overall-notification-detail'),
    responseCohortNote: document.getElementById('response-cohort-note'),
    agencies: document.getElementById('agency-response-times'),
    complaintTypes: document.getElementById('complaint-response-times')
  };
  const hasEmailMetricElements = Object.values(emailMetricElements).every(Boolean);
  const statusClarityElements = {
    root: document.getElementById('status-clarity'),
    mode: document.getElementById('status-clarity-mode'),
    tracked: document.getElementById('status-tracked-count'),
    trackedNote: document.getElementById('status-tracked-note'),
    emailCount: document.getElementById('status-email-count'),
    emailNote: document.getElementById('status-email-note'),
    closedEmailCount: document.getElementById('status-closed-email-count'),
    closedEmailNote: document.getElementById('status-closed-email-note'),
    portalClosedCount: document.getElementById('status-portal-closed-count'),
    portalClosedNote: document.getElementById('status-portal-closed-note'),
    note: document.getElementById('status-clarity-note')
  };
  const hasStatusClarityElements = Object.values(statusClarityElements).every(Boolean);
  const legacyReconciliationElements = {
    root: document.getElementById('legacy-reconciliation'),
    status: document.getElementById('legacy-reconciliation-status'),
    percent: document.getElementById('legacy-reconciliation-percent'),
    count: document.getElementById('legacy-reconciliation-count'),
    updated: document.getElementById('legacy-reconciliation-updated'),
    progress: document.getElementById('legacy-reconciliation-progress'),
    returned: document.getElementById('legacy-reconciliation-returned'),
    closed: document.getElementById('legacy-reconciliation-closed'),
    open: document.getElementById('legacy-reconciliation-open'),
    omitted: document.getElementById('legacy-reconciliation-omitted'),
    detail: document.getElementById('legacy-reconciliation-detail')
  };
  const hasLegacyReconciliationElements =
    Object.values(legacyReconciliationElements).every(Boolean);
  const releaseSpeedElements = {
    root: document.getElementById('release-speed'),
    updated: document.getElementById('release-speed-updated'),
    total: document.getElementById('release-total-time'),
    summary: document.getElementById('release-summary'),
    tests: document.getElementById('release-tests-time'),
    upload: document.getElementById('release-upload-time'),
    activate: document.getElementById('release-activate-time'),
    visible: document.getElementById('release-visible-time'),
    note: document.getElementById('release-speed-note')
  };
  const hasReleaseSpeedElements = Object.values(releaseSpeedElements).every(Boolean);
  const detailEvidenceElements = {
    root: document.getElementById('detail-status-evidence'),
    summary: document.getElementById('detail-evidence-summary'),
    email: document.getElementById('detail-evidence-email'),
    portal: document.getElementById('detail-evidence-portal'),
    note: document.getElementById('detail-evidence-note')
  };
  const hasDetailEvidenceElements = Object.values(detailEvidenceElements).every(Boolean);
  const MAX_VISIBLE_RECORDS = 300;
  const INITIAL_VISIBLE_RECORDS = 100;
  const MAP_INITIAL_PAGE_SIZE = 250;
  const MAP_PAGE_SIZE = 1_000;
  const MAP_REFRESH_MS = 5 * 60_000;
  const MAP_REQUEST_TIMEOUT_MS = 15_000;
  const MAP_RETRY_MS = 3_000;
  const DASHBOARD_REQUEST_TIMEOUT_MS = 8_000;
  const EMAIL_UPDATES_REFRESH_MS = 15_000;
  const EMAIL_METRICS_REFRESH_MS = 60_000;
  const EMAIL_METRICS_REFRESHING_RETRY_MS = 2_500;
  const RELEASE_INFO_REFRESH_MS = 5 * 60_000;
  const OPERATIONAL_HEALTH_REFRESH_MS = 15_000;
  const DASHBOARD_MIN_REFRESH_MS = 5_000;
  const STATUS_HISTORY_REFRESH_MS = 15_000;
  let records = [];
  let mapRecords = [];
  let feedByNumber = new Map();
  let feedCardByNumber = new Map();
  let feedCardSignatureByNumber = new Map();
  let mapByNumber = new Map();
  let selectedNumber = null;
  let markerByNumber = new Map();
  let markerSignatureByNumber = new Map();
  let mapScope = '24h';
  let mapStats = {
    total: 0,
    mapped_total: 0,
    unmapped_total: 0,
    totals_available: false
  };
  let mapShownCount = 0;
  let mapRenderFrame = null;
  let refreshInFlight = false;
  let mapRefreshInFlight = false;
  let mapAbortController = null;
  let mapRetryTimer = null;
  let mapArchiveLoaded = false;
  let mapRequestSequence = 0;
  let dashboardRequestSequence = 0;
  let dashboardAbortController = null;
  let lastMapRefreshStartedAt = 0;
  let currentPollSeconds = 15;
  let lastPortalCheck = null;
  let portalDetailByNumber = new Map();
  let detailLoadSequence = 0;
  let emailUpdatesByNumber = new Map();
  let emailUpdatesLoadedAt = new Map();
  let emailUpdatesLoadSequence = 0;
  let emailUpdatesAbortController = null;
  let emailUpdatesInFlightFor = null;
  let statusHistoryByNumber = new Map();
  let statusHistoryLoadedAt = new Map();
  let statusHistoryLoadSequence = 0;
  let statusHistoryAbortController = null;
  let statusHistoryInFlightFor = null;
  let highestObservedSuffix = null;
  let arrivingNumbers = new Set();
  let lastGoodSummary = null;
  let lastGoodEmailMetrics = null;
  let lastDashboardStats = null;
  let emailMetricsInFlight = false;
  let releaseInfoInFlight = false;
  let overviewDataStarted = false;
  let overviewEmailMetricsTimer = null;
  let overviewReleaseInfoTimer = null;
  let overviewHealthTimer = null;
  let operationalHealthInFlight = false;
  let lastEmailMetricsAttemptAt = 0;
  let lastReleaseInfoAttemptAt = 0;
  let emailMetricsRefreshPending = false;
  let dashboardPayloadLoaded = false;
  let dashboardRefreshTimer = null;
  const expandedResponseTables = new Set();
  let archiveSearchRecord = null;
  let archiveSearchState = 'idle';
  let archiveSearchSequence = 0;
  let archiveSearchTimer = null;
  let bidById = new Map();
  const boundaryStates = {
    precinct: {
      requestedValue: '', layer: null, label: '', loading: false,
      sequence: 0, controller: null
    },
    bid: {
      requestedValue: '', layer: null, label: '', loading: false,
      sequence: 0, controller: null
    }
  };
  const boundaryStyles = {
    precinct: {
      color: '#5846c7', weight: 3, opacity: 0.9,
      fillColor: '#6e5ce7', fillOpacity: 0.08
    },
    bid: {
      color: '#d18412', weight: 3, opacity: 0.95, dashArray: '8 6',
      fillColor: '#f0ae35', fillOpacity: 0.09
    }
  };
  let pendingBoundaryFit = false;
  let boundaryFitRevision = 0;
  let lastMapLayoutKey = '';

  function setMapLoadState(state, message = '') {
    if (!mapLoadStatus) return;
    mapLoadStatus.dataset.state = state;
    mapLoadStatus.textContent = message;
  }

  function clearMapRetry() {
    if (mapRetryTimer === null) return;
    window.clearTimeout(mapRetryTimer);
    mapRetryTimer = null;
  }

  function scheduleMapRetry() {
    if (mapRetryTimer !== null) return;
    mapRetryTimer = window.setTimeout(() => {
      mapRetryTimer = null;
      refreshMap(mapStats, true);
    }, MAP_RETRY_MS);
  }

  const esc = value => String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const portalDate = value => {
    if (!value) return null;
    return new Date(value);
  };
  const timeLabel = value => {
    const date = portalDate(value);
    if (!date || Number.isNaN(date.getTime())) return 'Unknown';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit'
    }).format(date);
  };
  const fullTimeLabel = value => {
    const date = portalDate(value);
    if (!date || Number.isNaN(date.getTime())) return 'Unknown';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit'
    }).format(date);
  };

  function viewTabsVisible() {
    if (!mobileViewTabs) return false;
    const style = window.getComputedStyle(mobileViewTabs);
    const bounds = mobileViewTabs.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && bounds.width > 0 && bounds.height > 0;
  }

  function viewButtonVisible(view) {
    const button = mobileViewTabs
      && mobileViewTabs.querySelector(`button[data-mobile-view="${view}"]`);
    if (!button) return false;
    const style = window.getComputedStyle(button);
    const bounds = button.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && bounds.width > 0 && bounds.height > 0;
  }

  function setPressedView(view) {
    mobileViewTabs.querySelectorAll('button[data-mobile-view]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.mobileView === view));
    });
  }

  function setMobileView(view) {
    if (!['feed', 'map', 'overview'].includes(view)) return;
    const usesViewTabs = viewTabsVisible();
    const normalizedView = view === 'map' && !viewButtonVisible('map') ? 'feed' : view;
    if (usesViewTabs) {
      appShell.dataset.mobileView = normalizedView;
      setPressedView(normalizedView);
      syncOverviewRefreshes(normalizedView === 'overview');
      scheduleMapLayout({ attemptBoundaryFit: normalizedView === 'map' });
      if (normalizedView === 'map' && !mapArchiveLoaded) refreshMap(mapStats, true);
    }
    return usesViewTabs && normalizedView === 'map';
  }

  function overviewIsActive() {
    return appShell.dataset.mobileView === 'overview';
  }

  function clearOverviewRefreshTimers() {
    if (overviewEmailMetricsTimer !== null) {
      window.clearTimeout(overviewEmailMetricsTimer);
      overviewEmailMetricsTimer = null;
    }
    if (overviewReleaseInfoTimer !== null) {
      window.clearTimeout(overviewReleaseInfoTimer);
      overviewReleaseInfoTimer = null;
    }
    if (overviewHealthTimer !== null) {
      window.clearTimeout(overviewHealthTimer);
      overviewHealthTimer = null;
    }
  }

  function scheduleOverviewEmailMetrics(delayMs = EMAIL_METRICS_REFRESH_MS) {
    if (!overviewIsActive() || overviewEmailMetricsTimer !== null) return;
    overviewEmailMetricsTimer = window.setTimeout(async () => {
      overviewEmailMetricsTimer = null;
      await refreshEmailMetrics();
      scheduleOverviewEmailMetrics();
    }, Math.max(0, delayMs));
  }

  function scheduleOverviewReleaseInfo(delayMs = RELEASE_INFO_REFRESH_MS) {
    if (!overviewIsActive() || overviewReleaseInfoTimer !== null) return;
    overviewReleaseInfoTimer = window.setTimeout(async () => {
      overviewReleaseInfoTimer = null;
      await refreshReleaseInfo();
      scheduleOverviewReleaseInfo();
    }, Math.max(0, delayMs));
  }

  function scheduleOverviewHealth(delayMs = OPERATIONAL_HEALTH_REFRESH_MS) {
    if (!overviewIsActive() || overviewHealthTimer !== null) return;
    overviewHealthTimer = window.setTimeout(async () => {
      overviewHealthTimer = null;
      await refreshOperationalHealth();
      scheduleOverviewHealth();
    }, Math.max(0, delayMs));
  }

  function syncOverviewRefreshes(active = overviewIsActive()) {
    clearOverviewRefreshTimers();
    if (!active) return;

    const now = Date.now();
    if (!overviewDataStarted) {
      overviewDataStarted = true;
      showEmailMetricsCalculating();
      void refreshEmailMetrics().finally(() => scheduleOverviewEmailMetrics());
      void refreshReleaseInfo().finally(() => scheduleOverviewReleaseInfo());
      void refreshOperationalHealth().finally(() => scheduleOverviewHealth());
      return;
    }

    scheduleOverviewEmailMetrics(emailMetricsRefreshPending
      ? EMAIL_METRICS_REFRESHING_RETRY_MS
      : Math.max(0, EMAIL_METRICS_REFRESH_MS - (now - lastEmailMetricsAttemptAt)));
    scheduleOverviewReleaseInfo(Math.max(
      0,
      RELEASE_INFO_REFRESH_MS - (now - lastReleaseInfoAttemptAt)
    ));
    scheduleOverviewHealth(0);
  }

  const submittedMillis = record => {
    const date = portalDate(record && record.submitted_at);
    return date && !Number.isNaN(date.getTime()) ? date.getTime() : null;
  };
  const mapRangeDateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric'
  });
  const suffixOf = record => Number(String(record && record.srnumber || '').replace(/^311-/, '')) || 0;
  function exactSrnumberQuery() {
    return normalizeExactSrnumberQuery(search.value);
  }
  const recordSignature = record => JSON.stringify([
    record.srnumber, record.status, record.problem, record.address,
    record.police_precinct, record.police_precinct_boundary_version,
    record.business_improvement_district_ids,
    record.business_improvement_district_boundary_version,
    record.latitude, record.longitude, record.submitted_at, record.portal_url,
    record.problem_details, record.additional_details, record.next_update,
    record.date_reported, record.updated_on, record.date_closed, record.details_fetched_at,
    record.followup_state, record.next_check_at, record.closure_cycle, record.finalized_at,
    record.public_details_state, record.has_map_pin,
    record.missing_public_fields, record.missing_important_fields,
    record.current_cycle_final_state, record.closure_cycle_tracking
  ]);
  function missingFieldLabels(fields) {
    if (!Array.isArray(fields)) return [];
    return fields.map(field => typeof field === 'string' ? field : field && field.label).filter(Boolean);
  }

  function readableList(items) {
    if (items.length < 2) return items[0] || '';
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  }

  function missingBadge(record) {
    const fields = Array.isArray(record && record.missing_important_fields)
      ? record.missing_important_fields
      : [];
    if (!fields.length) return '';
    const shortLabels = {
      status: 'STATUS',
      problem: 'TYPE',
      reported_time: 'TIME'
    };
    const compact = fields.map(field => shortLabels[field.key] || String(field.label || field.key).toUpperCase());
    const full = missingFieldLabels(fields).join(', ');
    return `<span class="missing-label" title="NYC311 did not publish: ${esc(full)}">MISSING ${esc(compact.join('/'))}</span>`;
  }

  function findRecord(number) {
    return feedByNumber.get(number)
      || (archiveSearchRecord && archiveSearchRecord.srnumber === number ? archiveSearchRecord : null)
      || mapByNumber.get(number)
      || null;
  }

  function portalIdFor(record) {
    if (record && record.portal_id) return record.portal_id;
    const match = String(record && record.portal_url || '').match(/[?&]id=([0-9a-f-]{36})(?:&|$)/i);
    return match ? match[1] : null;
  }

  function mapRecordTime(record) {
    return submittedMillis(record);
  }

  function matchesMapScope(record, now = Date.now()) {
    if (mapScope === 'all') return true;
    const timestamp = mapRecordTime(record);
    if (timestamp === null) return false;
    const ageLimit = mapScope === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    return timestamp >= now - ageLimit;
  }

  function matchesFilters(record) {
    const query = search.value.trim().toLowerCase();
    const exact = exactSrnumberQuery();
    const status = statusFilter.value;
    const precinct = precinctFilter.value;
    const bidId = bidFilter.value;
    if (status && record.status !== status) return false;
    if (precinct && Number(record.police_precinct) !== Number(precinct)) return false;
    if (bidId && !(Array.isArray(record.business_improvement_district_ids)
        && record.business_improvement_district_ids.some(id => Number(id) === Number(bidId)))) {
      return false;
    }
    if (!query) return true;
    if (exact && record.srnumber === exact) return true;
    const bidNames = (Array.isArray(record.business_improvement_district_ids)
      ? record.business_improvement_district_ids
      : []).map(id => bidById.get(String(id)) && bidById.get(String(id)).name);
    return [record.srnumber, record.problem, record.problem_details,
      record.additional_details, record.address, record.status,
      ...bidNames,
      ...missingFieldLabels(record.missing_public_fields)]
      .some(value => String(value || '').toLowerCase().includes(query));
  }

  function filteredRecords() {
    const visible = records.filter(record => !recordDetailsPending(record) && matchesFilters(record));
    const exact = exactSrnumberQuery();
    if (!exact) return visible;
    const archived = archiveSearchRecord && archiveSearchRecord.srnumber === exact
      ? archiveSearchRecord
      : mapByNumber.get(exact);
    if (archived && !recordDetailsPending(archived) && matchesFilters(archived)
        && !visible.some(record => record.srnumber === archived.srnumber)) {
      visible.unshift(archived);
    }
    return visible;
  }

  function pendingRecords() {
    const visible = records.filter(record => recordDetailsPending(record) && matchesFilters(record));
    const exact = exactSrnumberQuery();
    if (!exact || !archiveSearchRecord || archiveSearchRecord.srnumber !== exact
        || !recordDetailsPending(archiveSearchRecord) || !matchesFilters(archiveSearchRecord)
        || visible.some(record => record.srnumber === archiveSearchRecord.srnumber)) {
      return visible;
    }
    return [archiveSearchRecord, ...visible];
  }

  function renderPendingDetails() {
    const pending = pendingRecords();
    detailsPending.hidden = pending.length === 0;
    if (!pending.length) {
      detailsPendingCount.textContent = '0 requests loading details';
      detailsPendingItems.replaceChildren();
      return;
    }
    detailsPendingCount.textContent = `${pending.length.toLocaleString()} ${pending.length === 1 ? 'request is' : 'requests are'} loading submitted details`;
    const fragment = document.createDocumentFragment();
    for (const record of pending.slice(0, 4)) {
      const item = document.createElement('span');
      item.className = 'details-pending-item';
      item.textContent = `${record.srnumber} · ${timeLabel(record.submitted_at)}`;
      fragment.append(item);
    }
    detailsPendingItems.replaceChildren(fragment);
  }

  function captureFeedScroll() {
    const scrollTop = feed.scrollTop;
    if (scrollTop <= 2) return { scrollTop: 0, anchorNumber: null, anchorOffset: 0 };
    const feedTop = feed.getBoundingClientRect().top;
    const anchor = [...feed.querySelectorAll('.request-card')]
      .find(card => card.getBoundingClientRect().bottom > feedTop);
    return {
      scrollTop,
      anchorNumber: anchor ? anchor.dataset.number : null,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - feedTop : 0
    };
  }

  function restoreFeedScroll(snapshot) {
    if (!snapshot || snapshot.scrollTop <= 2) {
      feed.scrollTop = 0;
      return;
    }
    feed.scrollTop = snapshot.scrollTop;
    if (!snapshot.anchorNumber) return;
    const anchor = [...feed.querySelectorAll('.request-card')]
      .find(card => card.dataset.number === snapshot.anchorNumber);
    if (!anchor) return;
    const feedTop = feed.getBoundingClientRect().top;
    const newOffset = anchor.getBoundingClientRect().top - feedTop;
    feed.scrollTop += newOffset - snapshot.anchorOffset;
  }

  function feedCardSignature(record) {
    return recordSignature(record);
  }

  function updateFeedCardSelection(card, selected) {
    if (!card) return;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-current', String(selected));
  }

  function updateSelectedFeedCard(previousNumber, nextNumber) {
    if (previousNumber && previousNumber !== nextNumber) {
      updateFeedCardSelection(feedCardByNumber.get(previousNumber), false);
    }
    if (nextNumber) updateFeedCardSelection(feedCardByNumber.get(nextNumber), true);
  }

  function updateFeedCard(card, record, { arriving = false, arrivalIndex = 0 } = {}) {
    const model = feedCardModel(record);
    const unavailableBadge = missingBadge(record);
    card.type = 'button';
    card.className = `request-card${arriving ? ' arriving' : ''}`;
    card.dataset.number = model.srnumber;
    card.setAttribute('aria-label', `${model.headline}, ${model.srnumber}, ${model.status}`);
    if (arriving) card.style.setProperty('--arrival-index', Math.min(arrivalIndex, 8));
    else card.style.removeProperty('--arrival-index');
    updateFeedCardSelection(card, selectedNumber === model.srnumber);
    card.innerHTML = `
      <span class="request-dot${model.closed ? ' closed' : ''}" aria-hidden="true"></span>
      <span class="request-copy">
        <span class="request-topline"><strong>${esc(model.headline)}</strong><time>${esc(timeLabel(model.submittedAt))}</time></span>
        ${model.detail ? `<span class="request-detail-line">${esc(model.detail)}</span>` : ''}
        <span class="request-address">${esc(model.address)}</span>
        <span class="request-meta"><span>${esc(model.srnumber)}</span><span aria-hidden="true">•</span><span>${esc(model.status)}</span>${unavailableBadge}${!model.hasMapPin ? '<span class="unmapped-label">NO MAP PIN</span>' : ''}</span>
      </span>`;
  }

  function renderFeed({ resetScroll = false } = {}) {
    renderPendingDetails();
    const scrollSnapshot = resetScroll ? null : captureFeedScroll();
    const visible = filteredRecords();
    if (!visible.length) {
      const exact = exactSrnumberQuery();
      const message = !dashboardPayloadLoaded
        ? 'Loading requests…'
        : exact && archiveSearchState === 'loading'
        ? `Searching the full archive for ${exact}…`
        : exact && archiveSearchState === 'not_found'
          ? `${exact} is not in the captured archive.`
          : exact && archiveSearchState === 'error'
            ? 'The full archive search is temporarily unavailable.'
            : pendingRecords().length
              ? 'Complete requests will appear here as soon as submitted details finish loading.'
              : 'No requests match the current filters.';
      feedCardByNumber.clear();
      feedCardSignatureByNumber.clear();
      feed.innerHTML = `<div class="empty-state"><p>${esc(message)}</p></div>`;
      feed.scrollTop = 0;
      return;
    }
    if (feed.querySelector(':scope > .empty-state')) feed.replaceChildren();

    const desiredNumbers = new Set();
    const animatedCards = [];
    let arrivalIndex = 0;
    visible.forEach((record, index) => {
      const number = record.srnumber;
      desiredNumbers.add(number);
      const arriving = arrivingNumbers.has(record.srnumber);
      const signature = feedCardSignature(record);
      let card = feedCardByNumber.get(number);
      if (!card) {
        card = document.createElement('button');
        feedCardByNumber.set(number, card);
      }
      if (feedCardSignatureByNumber.get(number) !== signature || arriving) {
        updateFeedCard(card, record, { arriving, arrivalIndex });
        feedCardSignatureByNumber.set(number, signature);
      } else {
        updateFeedCardSelection(card, selectedNumber === number);
      }
      if (arriving) {
        arrivalIndex += 1;
        animatedCards.push(card);
      }
      const currentAtIndex = feed.children[index];
      if (currentAtIndex !== card) feed.insertBefore(card, currentAtIndex || null);
    });

    for (const [number, card] of feedCardByNumber) {
      if (desiredNumbers.has(number)) continue;
      card.remove();
      feedCardByNumber.delete(number);
      feedCardSignatureByNumber.delete(number);
    }
    if (animatedCards.length) {
      window.setTimeout(() => animatedCards.forEach(card => {
        card.classList.remove('arriving');
        card.style.removeProperty('--arrival-index');
      }), 1300);
    }
    arrivingNumbers.clear();
    restoreFeedScroll(scrollSnapshot);
  }

  function markerClass(record) {
    return isClosed(record.status) ? 'closed' : '';
  }

  function markerIcon(record) {
    return L.divIcon({
      className: '',
      html: `<div class="live-marker ${markerClass(record)}"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
  }

  function createMarker(record, coordinates) {
    const marker = L.marker([coordinates.lat, coordinates.lng], {
      icon: markerIcon(record),
      title: record.problem_details || record.problem || record.srnumber,
      requestKind: markerClass(record) || 'active'
    });
    marker.on('click', () => selectRequest(record.srnumber, false));
    return marker;
  }

  function markerSignature(record, coordinates) {
    return JSON.stringify([
      coordinates.lat,
      coordinates.lng,
      record.status,
      record.problem_details || record.problem || record.srnumber
    ]);
  }

  function updateMapCountText() {
    if (!mapStats.totals_available) {
      const label = `${mapShownCount.toLocaleString()} shown · ${mapRecords.length.toLocaleString()} pins loaded`;
      if (mapCounts.textContent !== label) mapCounts.textContent = label;
      return;
    }
    const captured = Number.isFinite(Number(mapStats.total)) ? Number(mapStats.total) : 0;
    const unmapped = Number.isFinite(Number(mapStats.unmapped_total))
      ? Number(mapStats.unmapped_total)
      : Math.max(0, captured - mapRecords.length);
    const label = `${mapShownCount.toLocaleString()} shown · ${unmapped.toLocaleString()} without stored Portal coordinates · ${captured.toLocaleString()} captured`;
    if (mapCounts.textContent !== label) mapCounts.textContent = label;
  }

  function mapScopeLabel() {
    if (mapScope === '24h') return 'Last 24 hours';
    if (mapScope === '7d') return 'Last 7 days';
    return 'All captured dates';
  }

  function mapSubmittedSince(now = Date.now()) {
    if (mapScope === 'all') return null;
    const duration = mapScope === '7d'
      ? 7 * 24 * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;
    return new Date(now - duration).toISOString();
  }

  function updateMapDateRange(desired) {
    let earliest = null;
    let latest = null;
    for (const { record } of desired.values()) {
      const timestamp = mapRecordTime(record);
      if (timestamp === null) continue;
      earliest = earliest === null ? timestamp : Math.min(earliest, timestamp);
      latest = latest === null ? timestamp : Math.max(latest, timestamp);
    }
    if (earliest === null || latest === null) {
      mapDateRange.textContent = mapArchiveLoaded
        ? `${mapScopeLabel()} · no matching dated pins`
        : `${mapScopeLabel()} · loading map records`;
      return;
    }
    const earliestLabel = mapRangeDateFormatter.format(new Date(earliest));
    const latestLabel = mapRangeDateFormatter.format(new Date(latest));
    mapDateRange.textContent = earliestLabel === latestLabel
      ? `${mapScopeLabel()} · ${earliestLabel}`
      : `${mapScopeLabel()} · ${earliestLabel} – ${latestLabel}`;
  }

  function setMapScope(nextScope) {
    const normalizedScope = ['all', '24h', '7d'].includes(nextScope) ? nextScope : 'all';
    if (normalizedScope !== mapScope) mapArchiveLoaded = false;
    mapScope = normalizedScope;
    mapScopeControl.querySelectorAll('button[data-map-scope]').forEach(scopeButton => {
      scopeButton.setAttribute('aria-pressed', String(scopeButton.dataset.mapScope === mapScope));
    });
  }

  function showAllDatesForActiveFilters() {
    const nextScope = mapScopeAfterFilterChange(mapScope, [
      search.value,
      statusFilter.value,
      precinctFilter.value,
      bidFilter.value
    ]);
    if (nextScope === mapScope) return false;
    setMapScope(nextScope);
    return true;
  }

  function renderMapNow() {
    mapRenderFrame = null;
    const desired = new Map();
    const now = Date.now();
    const mapCandidates = archiveSearchRecord && recordCoordinates(archiveSearchRecord)
      && !mapByNumber.has(archiveSearchRecord.srnumber)
      ? [...mapRecords, archiveSearchRecord]
      : mapRecords;
    for (const mapRecord of mapCandidates) {
      const record = feedByNumber.get(mapRecord.srnumber)
        || (archiveSearchRecord && archiveSearchRecord.srnumber === mapRecord.srnumber
          ? archiveSearchRecord
          : mapRecord);
      const coordinates = recordCoordinates(record);
      if (!coordinates || recordDetailsPending(record)
          || !matchesFilters(record) || !matchesMapScope(record, now)) continue;
      desired.set(record.srnumber, {
        record,
        coordinates,
        signature: markerSignature(record, coordinates)
      });
    }

    const removals = [];
    for (const [number, marker] of markerByNumber) {
      const next = desired.get(number);
      if (next && markerSignatureByNumber.get(number) === next.signature) continue;
      removals.push(marker);
      markerByNumber.delete(number);
      markerSignatureByNumber.delete(number);
    }
    if (removals.length) markerLayer.removeLayers(removals);

    const additions = [];
    for (const [number, next] of desired) {
      if (markerByNumber.has(number)) continue;
      const marker = createMarker(next.record, next.coordinates);
      markerByNumber.set(number, marker);
      markerSignatureByNumber.set(number, next.signature);
      additions.push(marker);
    }
    if (additions.length) markerLayer.addLayers(additions);

    mapShownCount = desired.size;
    updateMapCountText();
    updateMapDateRange(desired);
  }

  function renderMap() {
    if (mapRenderFrame !== null) return;
    mapRenderFrame = window.requestAnimationFrame(renderMapNow);
  }

  function renderDetail(record) {
    if (!record) return;
    document.getElementById('detail-status').textContent = record.status || 'Unknown';
    document.getElementById('detail-problem').textContent = record.problem || 'Service Request';
    document.getElementById('detail-address').textContent = record.address || 'Location unavailable';
    document.getElementById('detail-number').textContent = record.srnumber;
    document.getElementById('detail-time').textContent = fullTimeLabel(record.submitted_at);
    const precinctRow = document.getElementById('detail-precinct-row');
    const precinctValue = document.getElementById('detail-precinct');
    if (record.police_precinct) {
      precinctValue.textContent = precinctLabel(record.police_precinct);
      precinctRow.classList.remove('hidden');
    } else {
      precinctValue.textContent = '';
      precinctRow.classList.add('hidden');
    }
    const bidRow = document.getElementById('detail-bid-row');
    const bidValue = document.getElementById('detail-bid');
    const bidNames = (Array.isArray(record.business_improvement_district_ids)
      ? record.business_improvement_district_ids
      : []).map(id => {
      const district = bidById.get(String(id));
      return district ? district.name : `BID ${id}`;
    });
    bidValue.textContent = bidNames.join(' · ');
    bidRow.classList.toggle('hidden', bidNames.length === 0);
    document.getElementById('detail-link').href = record.portal_url || '#';
    setDetailBadge(record.public_details_state === 'pending' ? 'pending' : null);
    const archiveRow = document.getElementById('detail-archive-row');
    const archiveValue = document.getElementById('detail-archive');
    const emailPayload = emailUpdatesByNumber.get(record.srnumber);
    const archiveLabel = requestArchiveLabel(record, {
      monitoringModeKey: lastGoodEmailMetrics
        && lastGoodEmailMetrics.monitoring_mode
        && lastGoodEmailMetrics.monitoring_mode.key,
      subscription: emailPayload && emailPayload.subscription,
      emailLookupComplete: emailUpdatesLoadedAt.has(record.srnumber),
      formatTime: fullTimeLabel
    });
    archiveValue.textContent = archiveLabel;
    archiveRow.classList.toggle('hidden', !archiveLabel);
    renderStatusEvidence(record);
    renderCoreDataWarning(record);
    const cachedDetail = portalDetailByNumber.get(record.srnumber);
    if (cachedDetail) {
      renderSubmittedDetails(cachedDetail, 'success');
    } else if (record.details_fetched_at) {
      const savedDetail = {
        problemDetails: record.problem_details,
        additionalDetails: record.additional_details,
        agencyResponse: record.agency_response,
        agencyResponseSource: record.agency_response_source,
        agencyResponseUpdatedAt: record.agency_response_updated_at,
        nextUpdate: record.next_update,
        dateReported: record.date_reported,
        updatedOn: record.updated_on,
        dateClosed: record.date_closed
      };
      portalDetailByNumber.set(record.srnumber, savedDetail);
      renderSubmittedDetails(savedDetail, 'stored');
    } else if (record.public_details_state === 'pending') {
      renderSubmittedDetails(null, 'pending');
    }
    // Email and Portal details load independently. Always redraw the response
    // card so a newly stored email narrative appears immediately, even while
    // the Portal-detail request is still pending.
    renderAgencyResponse(portalDetailByNumber.get(record.srnumber) || null);
  }

  function clearStatusUpdatesPanel({ resetDisclosure = false } = {}) {
    detailEmailCount.textContent = '';
    detailEmailEvents.replaceChildren();
    detailEmailUpdates.hidden = true;
    if (resetDisclosure) detailEmailUpdates.open = false;
  }

  function emailAgencyLabel(update) {
    const acronym = String(update && update.agency_acronym || '').trim();
    const name = String(update && update.agency_name || '').trim();
    if (acronym && name && !name.toLowerCase().includes(acronym.toLowerCase())) {
      return `${acronym} · ${name}`;
    }
    return acronym || name || 'NYC311';
  }

  function emailVerificationState(record, update) {
    if (update && update.verification_label) {
      return {
        label: update.verification_label,
        state: update.verification_state || 'waiting'
      };
    }
    if (String(update && update.event_kind || '').toLowerCase() !== 'closed') return null;
    const followupState = String(record && record.followup_state || '').toLowerCase();
    const finalState = String(
      record && record.current_cycle_final_state
      || update && update.final_state
      || ''
    ).toLowerCase();
    if (finalState === 'detail_unconfirmed') {
      return { label: 'Portal detail did not confirm closure', state: 'unconfirmed' };
    }
    if (followupState === 'closed') {
      return { label: 'Portal verified', state: 'verified' };
    }
    if (followupState === 'closing') {
      return { label: 'Portal verification in progress', state: 'checking' };
    }
    if (update && update.closure_wake_queued) {
      return { label: 'Portal verification queued', state: 'queued' };
    }
    if (followupState !== 'open' && isClosed(record && record.status)) {
      return { label: 'Portal status is closed; detail verification unavailable', state: 'waiting' };
    }
    return { label: 'Awaiting Portal verification', state: 'waiting' };
  }

  function appendEmailUpdate(record, update) {
    const item = document.createElement('li');
    item.className = 'detail-email-event';
    const portalEvidence = update && update.portal_evidence || null;

    const heading = document.createElement('div');
    heading.className = 'detail-email-event-heading';
    const rawEventKind = String(update && update.event_kind || '').toLowerCase();
    const eventKind = rawEventKind === 'closed'
      ? 'Closed'
      : rawEventKind === 'submitted' ? 'Submitted' : 'Updated';
    const title = document.createElement('strong');
    title.textContent = update && update.title || eventKind;
    const statusTimeValue = portalEvidence && portalEvidence.effective_at
      || update && update.received_at;
    const statusTime = document.createElement('time');
    statusTime.textContent = fullTimeLabel(statusTimeValue);
    if (statusTimeValue) statusTime.dateTime = statusTimeValue;
    heading.append(title, statusTime);

    const agency = document.createElement('p');
    agency.className = 'detail-email-agency';
    const agencyLabel = emailAgencyLabel(update);
    const receivedLabel = update && update.received_at
      ? ` · email received ${fullTimeLabel(update.received_at)}`
      : '';
    agency.textContent = agencyLabel === 'NYC311'
      ? `NYC311 email${receivedLabel}`
      : `Agency response · ${agencyLabel}${receivedLabel}`;
    item.append(heading, agency);

    const type = String(update && update.request_type || '').trim();
    const subtype = String(update && update.request_subtype || '').trim();
    if (type || subtype) {
      const requestType = document.createElement('p');
      requestType.className = 'detail-email-request-type';
      requestType.textContent = [type, subtype].filter(Boolean).join(' · ');
      item.append(requestType);
    }

    if (portalEvidence) {
      const confirmation = document.createElement('div');
      confirmation.className = 'detail-portal-confirmation';
      confirmation.dataset.state = portalEvidence.verification_state || 'waiting';
      const confirmationLabel = document.createElement('strong');
      confirmationLabel.textContent = portalEvidence.verification_label
        || 'Recorded by NYC311 Portal';
      confirmation.append(confirmationLabel);
      const confirmationTimes = [];
      if (portalEvidence.effective_at) {
        confirmationTimes.push(`Status time ${fullTimeLabel(portalEvidence.effective_at)}`);
      }
      if (portalEvidence.observed_at) {
        const action = portalEvidence.verification_state === 'verified' ? 'confirmed' : 'checked';
        confirmationTimes.push(`${action} ${fullTimeLabel(portalEvidence.observed_at)}`);
      }
      if (confirmationTimes.length) {
        const confirmationTime = document.createElement('span');
        confirmationTime.textContent = confirmationTimes.join(' · ');
        confirmation.append(confirmationTime);
      }
      item.append(confirmation);
    }

    const responseText = String(update && update.response_text || '').trim();
    if (responseText) {
      const response = document.createElement('p');
      response.className = 'detail-email-response';
      response.textContent = responseText;
      item.append(response);
    }

    const nextUpdateText = String(update && update.next_update_text || '').trim();
    if (nextUpdateText) {
      const nextUpdate = document.createElement('p');
      nextUpdate.className = 'detail-email-next';
      const label = document.createElement('strong');
      label.textContent = 'Next update: ';
      nextUpdate.append(label, document.createTextNode(nextUpdateText));
      item.append(nextUpdate);
    }

    const verification = emailVerificationState(record, update);
    if (verification && !portalEvidence) {
      const state = document.createElement('span');
      state.className = 'detail-email-verification';
      state.dataset.state = verification.state;
      state.textContent = verification.label;
      item.append(state);
    }

    detailEmailEvents.append(item);
  }

  function appendPortalUpdate(update) {
    const item = document.createElement('li');
    item.className = 'detail-email-event detail-portal-event';

    const heading = document.createElement('div');
    heading.className = 'detail-email-event-heading';
    const title = document.createElement('strong');
    title.textContent = update && update.title || update && update.status || 'Status updated';
    const effective = document.createElement('time');
    const effectiveAt = update && update.effective_at;
    effective.textContent = effectiveAt ? fullTimeLabel(effectiveAt) : '';
    if (effectiveAt) effective.dateTime = effectiveAt;
    heading.append(title, effective);

    const source = document.createElement('p');
    source.className = 'detail-email-agency';
    source.textContent = update && update.source_label || 'NYC311 Portal';
    item.append(heading, source);

    const response = document.createElement('p');
    const responseText = String(update && update.response_text || '').trim();
    response.className = responseText
      ? 'detail-email-response'
      : 'detail-email-response detail-status-no-narrative';
    response.textContent = responseText || (
      isClosed(update && update.status)
        ? 'NYC311 did not publish an agency response with this Portal status change.'
        : 'NYC311 did not publish additional details with this Portal status change.'
    );
    item.append(response);

    const observedAt = update && update.observed_at;
    if (observedAt) {
      const observed = document.createElement('p');
      observed.className = 'detail-email-next';
      const label = document.createElement('strong');
      label.textContent = update.verification_state === 'verified' ? 'Verified: ' : 'Observed: ';
      const time = document.createElement('time');
      time.textContent = fullTimeLabel(observedAt);
      time.dateTime = observedAt;
      observed.append(label, time);
      item.append(observed);
    }

    if (update && update.final_state === 'date_missing' && !update.effective_at) {
      const missingDate = document.createElement('p');
      missingDate.className = 'detail-email-next';
      missingDate.textContent = 'NYC311 did not publish a closure time.';
      item.append(missingDate);
    }

    if (update && update.verification_label) {
      const verification = document.createElement('span');
      verification.className = 'detail-email-verification';
      verification.dataset.state = update.verification_state || 'waiting';
      verification.textContent = update.verification_label;
      item.append(verification);
    }

    detailEmailEvents.append(item);
  }

  function latestEmailUpdate(payload) {
    const updates = Array.isArray(payload && payload.updates) ? payload.updates : [];
    return updates.slice().sort((left, right) => (
      (Number.isFinite(Date.parse(right && right.received_at || ''))
        ? Date.parse(right && right.received_at || '') : 0)
      - (Number.isFinite(Date.parse(left && left.received_at || ''))
        ? Date.parse(left && left.received_at || '') : 0)
      || Number(right && right.id || 0) - Number(left && left.id || 0)
    ))[0] || null;
  }

  function evidenceEmailLabel(update, loaded) {
    if (!loaded) return 'Checking';
    if (!update) return 'None received';
    const agency = emailAgencyLabel(update);
    const kind = String(update.event_kind || '').trim() || 'Update';
    const action = kind.toLowerCase() === 'submitted'
      ? 'submission received'
      : kind.toLowerCase() === 'closed' ? 'response received' : 'update received';
    const time = update.received_at ? ` · ${timeLabel(update.received_at)}` : '';
    return `${agency} · ${action}${time}`;
  }

  function portalEvidence(record, statusPayload) {
    const followupState = String(record && record.followup_state || '').toLowerCase();
    const finalState = String(record && record.current_cycle_final_state || '').toLowerCase();
    if (finalState === 'detail_unconfirmed') {
      return {
        state: 'warning',
        label: 'Not confirmed',
        note: 'A Closed email arrived, but the Portal detail did not confirm the closure.'
      };
    }
    if (followupState === 'closed') {
      return {
        state: 'verified',
        label: record.finalized_at ? `Verified · ${timeLabel(record.finalized_at)}` : 'Verified',
        note: 'The final Portal snapshot is saved.'
      };
    }
    if (followupState === 'closing') {
      const snapshot = currentClosureSnapshot(record, statusPayload);
      return {
        state: 'checking',
        label: 'Verifying',
        note: snapshot && snapshot.fetched_at
          ? `Portal was last checked ${timeLabel(snapshot.fetched_at)}.`
          : 'A closure signal arrived and the Portal proof is being checked.'
      };
    }
    if (isClosed(record && record.status)) {
      return {
        state: 'warning',
        label: 'Closed signal',
        note: 'The request reads as closed, but final Portal proof has not been saved yet.'
      };
    }
    return {
      state: 'open',
      label: 'No closure yet',
      note: 'The request is still being tracked for future updates.'
    };
  }

  function renderStatusEvidence(record) {
    if (!hasDetailEvidenceElements || !record) return;
    const emailPayload = emailUpdatesByNumber.get(record.srnumber) || null;
    const statusPayload = statusHistoryByNumber.get(record.srnumber) || null;
    const emailLoaded = emailUpdatesLoadedAt.has(record.srnumber);
    const latestEmail = latestEmailUpdate(emailPayload);
    const closedEmail = (Array.isArray(emailPayload && emailPayload.updates)
      ? emailPayload.updates
      : []).find(update => String(update && update.event_kind || '').toLowerCase() === 'closed');
    const portal = portalEvidence(record, statusPayload);
    const officialStatus = String(record.status || 'Unknown').trim() || 'Unknown';
    let note = portal.note;
    if (portal.state === 'verified' && closedEmail) {
      note = `NYC311 confirms this request is closed. The ${emailAgencyLabel(closedEmail)} response is saved in Update history below.`;
    } else if (portal.state === 'verified') {
      note = 'NYC311 confirms this request is closed. No agency response email is saved.';
    } else if (portal.state === 'checking' && closedEmail) {
      note = `A ${emailAgencyLabel(closedEmail)} email reports closure. NYC311 Portal confirmation is still in progress.`;
    } else if (portal.state === 'open' && latestEmail) {
      note = `NYC311 currently lists this request as ${officialStatus}. The latest agency email is saved below.`;
    } else if (portal.state === 'open' && emailLoaded) {
      note = `NYC311 currently lists this request as ${officialStatus}. No agency status email has arrived yet.`;
    }

    detailEvidenceElements.root.dataset.state = portal.state;
    detailEvidenceElements.summary.textContent = officialStatus;
    detailEvidenceElements.email.textContent = evidenceEmailLabel(latestEmail, emailLoaded);
    detailEvidenceElements.portal.textContent = portal.label;
    detailEvidenceElements.note.textContent = note;
  }

  function renderStatusUpdates(record, { resetDisclosure = false } = {}) {
    if (!record || selectedNumber !== record.srnumber) return;
    const model = buildStatusUpdateModel(
      record,
      statusHistoryByNumber.get(record.srnumber) || null,
      emailUpdatesByNumber.get(record.srnumber) || null
    );
    renderStatusEvidence(record);
    clearStatusUpdatesPanel({ resetDisclosure });
    if (!model.events.length) return;
    detailEmailCount.textContent = model.total > model.events.length
      ? `${model.events.length} of ${model.total} updates`
      : `${model.events.length} ${model.events.length === 1 ? 'update' : 'updates'}`;
    for (const update of model.events) {
      if (update.source === 'portal') appendPortalUpdate(update);
      else appendEmailUpdate(record, update);
    }
    detailEmailUpdates.hidden = false;
  }

  function beginStatusUpdatesSelection(record) {
    emailUpdatesLoadSequence += 1;
    statusHistoryLoadSequence += 1;
    if (emailUpdatesAbortController) emailUpdatesAbortController.abort();
    if (statusHistoryAbortController) statusHistoryAbortController.abort();
    emailUpdatesAbortController = null;
    emailUpdatesInFlightFor = null;
    statusHistoryAbortController = null;
    statusHistoryInFlightFor = null;
    clearStatusUpdatesPanel({ resetDisclosure: true });
    renderStatusUpdates(record, { resetDisclosure: true });
    loadEmailUpdates(record, { force: true });
    loadStatusHistory(record, { force: true });
  }

  async function loadEmailUpdates(record, { force = false } = {}) {
    if (!record || selectedNumber !== record.srnumber) return;
    const now = Date.now();
    const loadedAt = emailUpdatesLoadedAt.get(record.srnumber) || 0;
    if (!force && now - loadedAt < EMAIL_UPDATES_REFRESH_MS) return;
    if (emailUpdatesInFlightFor === record.srnumber) return;

    const sequence = emailUpdatesLoadSequence;
    const controller = new AbortController();
    emailUpdatesAbortController = controller;
    emailUpdatesInFlightFor = record.srnumber;
    try {
      const response = await fetch(`/api/email-updates/${encodeURIComponent(record.srnumber)}`, {
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Email update service returned ${response.status}`);
      const payload = await response.json();
      emailUpdatesByNumber.set(record.srnumber, payload);
      emailUpdatesLoadedAt.set(record.srnumber, Date.now());
      if (sequence === emailUpdatesLoadSequence && selectedNumber === record.srnumber) {
        renderDetail(record);
        renderStatusUpdates(record);
      }
    } catch (error) {
      if (error.name !== 'AbortError') console.warn(error);
    } finally {
      if (emailUpdatesAbortController === controller) {
        emailUpdatesAbortController = null;
        emailUpdatesInFlightFor = null;
      }
    }
  }

  async function loadStatusHistory(record, { force = false } = {}) {
    if (!record || selectedNumber !== record.srnumber) return;
    const now = Date.now();
    const loadedAt = statusHistoryLoadedAt.get(record.srnumber) || 0;
    if (!force && now - loadedAt < STATUS_HISTORY_REFRESH_MS) return;
    if (statusHistoryInFlightFor === record.srnumber) return;

    const sequence = statusHistoryLoadSequence;
    const controller = new AbortController();
    statusHistoryAbortController = controller;
    statusHistoryInFlightFor = record.srnumber;
    try {
      const response = await fetch(`/api/status-history/${encodeURIComponent(record.srnumber)}`, {
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Status history service returned ${response.status}`);
      const payload = await response.json();
      statusHistoryByNumber.set(record.srnumber, payload);
      statusHistoryLoadedAt.set(record.srnumber, Date.now());
      if (sequence === statusHistoryLoadSequence && selectedNumber === record.srnumber) {
        renderStatusUpdates(record);
      }
    } catch (error) {
      if (error.name !== 'AbortError') console.warn(error);
    } finally {
      if (statusHistoryAbortController === controller) {
        statusHistoryAbortController = null;
        statusHistoryInFlightFor = null;
      }
    }
  }

  function setDetailBadge(state) {
    const labels = {
      pending: 'Pending',
      loading: 'Checking',
      stored: 'Saved',
      success: 'Loaded',
      error: 'Unavailable'
    };
    const label = labels[state] || '';
    detailPendingBadge.textContent = label;
    detailPendingBadge.dataset.state = state || '';
    detailPendingBadge.classList.toggle('hidden', !label);
    detail.setAttribute('aria-busy', String(state === 'loading'));
  }

  function setDetailPanelVisible(visible) {
    if (visible) {
      detail.classList.remove('hidden');
      detail.inert = false;
      detail.setAttribute('aria-hidden', 'false');
      window.requestAnimationFrame(() => document.getElementById('detail-close').focus());
      return;
    }
    if (detail.contains(document.activeElement)) document.activeElement.blur();
    detail.inert = true;
    detail.setAttribute('aria-busy', 'false');
    detail.setAttribute('aria-hidden', 'true');
    detail.classList.add('hidden');
  }

  function renderCoreDataWarning(record) {
    const warning = document.getElementById('detail-data-warning');
    const labelsByKey = {
      status: 'status',
      problem: 'request type',
      reported_time: 'submitted time'
    };
    const missingFields = (Array.isArray(record && record.missing_important_fields)
      ? record.missing_important_fields
      : []).map(field => {
      if (typeof field === 'string') return field.toLowerCase();
      return labelsByKey[field && field.key] || String(field && (field.label || field.key) || '').toLowerCase();
    }).filter(Boolean);
    if (record && !recordHasMapPin(record)) missingFields.push('map location');
    const uniqueFields = [...new Set(missingFields)];
    warning.textContent = uniqueFields.length
      ? `Core data unavailable: ${readableList(uniqueFields)}.`
      : '';
    warning.classList.toggle('hidden', !uniqueFields.length);
  }

  function renderSubmittedDetails(detailData, state = 'success') {
    const problemDetails = document.getElementById('detail-problem-details');
    const additionalDetails = document.getElementById('detail-additional-details');
    const updatedRow = document.getElementById('detail-updated-row');
    const closedRow = document.getElementById('detail-closed-row');
    const nextUpdateRow = document.getElementById('detail-next-update-row');
    renderAgencyResponse(state === 'success' || state === 'stored' ? detailData : null);
    if (state === 'pending') {
      setDetailBadge('pending');
      problemDetails.textContent = 'Submitted details are still being saved.';
      additionalDetails.textContent = '';
      updatedRow.classList.add('hidden');
      closedRow.classList.add('hidden');
      nextUpdateRow.classList.add('hidden');
      return;
    }
    if (state === 'loading') {
      setDetailBadge('loading');
      problemDetails.textContent = 'Checking submitted details…';
      additionalDetails.textContent = '';
      updatedRow.classList.add('hidden');
      closedRow.classList.add('hidden');
      nextUpdateRow.classList.add('hidden');
      return;
    }
    if (state === 'error') {
      setDetailBadge('error');
      problemDetails.textContent = 'Submitted details are unavailable right now.';
      additionalDetails.textContent = 'The request remains saved in the archive.';
      updatedRow.classList.add('hidden');
      closedRow.classList.add('hidden');
      nextUpdateRow.classList.add('hidden');
      return;
    }
    setDetailBadge(state);
    const primaryDetails = /^(?:N\/?A|NONE|NOT PROVIDED)$/i.test(String(detailData && detailData.problemDetails || '').trim())
      ? ''
      : String(detailData && detailData.problemDetails || '').trim();
    const extraDetails = /^(?:N\/?A|NONE|NOT PROVIDED)$/i.test(String(detailData && detailData.additionalDetails || '').trim())
      ? ''
      : String(detailData && detailData.additionalDetails || '').trim();
    if (primaryDetails) {
      problemDetails.textContent = primaryDetails;
      additionalDetails.textContent = extraDetails;
    } else if (extraDetails) {
      problemDetails.textContent = extraDetails;
      additionalDetails.textContent = '';
    } else {
      problemDetails.textContent = 'No additional submitted details are available for this request.';
      additionalDetails.textContent = '';
    }
    const currentRecord = findRecord(selectedNumber);
    const followupState = String(currentRecord && currentRecord.followup_state || '').toLowerCase();
    const currentlyOpen = followupState === 'open';
    const closurePending = followupState === 'closing';
    const currentlyClosed = followupState === 'closed'
      || (!currentlyOpen && !closurePending && isClosed(currentRecord && currentRecord.status));
    const visibleClosedDate = currentlyOpen || closurePending ? null : detailData.dateClosed;
    const visibleNextUpdate = currentlyClosed || closurePending ? null : detailData.nextUpdate;
    if (detailData.dateReported) document.getElementById('detail-time').textContent = fullTimeLabel(detailData.dateReported);
    document.getElementById('detail-updated').textContent = detailData.updatedOn ? fullTimeLabel(detailData.updatedOn) : '';
    updatedRow.classList.toggle('hidden', !detailData.updatedOn);
    document.getElementById('detail-closed').textContent = visibleClosedDate ? fullTimeLabel(visibleClosedDate) : '';
    closedRow.classList.toggle('hidden', !visibleClosedDate);
    document.getElementById('detail-next-update').textContent = visibleNextUpdate || '';
    nextUpdateRow.classList.toggle('hidden', !visibleNextUpdate);
  }

  function renderAgencyResponse(detailData) {
    const root = document.getElementById('detail-agency-response');
    const response = latestAgencyResponse(
      detailData,
      emailUpdatesByNumber.get(selectedNumber) || null
    );
    document.getElementById('detail-agency-response-text').textContent = response && response.text || '';
    const source = String(response && response.source || '').trim();
    const fromOneTimeApi = /public api/i.test(source);
    const agency = emailAgencyLabel(response);
    document.getElementById('detail-agency-response-source').textContent = response
      ? response.source_kind === 'email' && agency !== 'NYC311'
        ? `${source} · ${agency}`
        : source
      : '';
    const publishedAt = response && response.published_at;
    const time = document.getElementById('detail-agency-response-time');
    time.textContent = response && publishedAt
      ? `${response.source_kind === 'email'
        ? 'Email received'
        : fromOneTimeApi ? 'Official API updated' : 'Portal updated'} ${fullTimeLabel(publishedAt)}`
      : response && fromOneTimeApi
        ? 'Recovered in a one-time official API check'
      : '';
    time.dateTime = response && publishedAt ? publishedAt : '';
    root.classList.toggle('hidden', !response);
  }

  async function loadPortalDetails(record) {
    const sequence = ++detailLoadSequence;
    if (record.details_fetched_at) {
      const saved = {
        problemDetails: record.problem_details,
        additionalDetails: record.additional_details,
        agencyResponse: record.agency_response,
        agencyResponseSource: record.agency_response_source,
        agencyResponseUpdatedAt: record.agency_response_updated_at,
        nextUpdate: record.next_update,
        dateReported: record.date_reported,
        updatedOn: record.updated_on,
        dateClosed: record.date_closed
      };
      portalDetailByNumber.set(record.srnumber, saved);
      renderSubmittedDetails(saved, 'stored');
      return;
    }
    const cached = portalDetailByNumber.get(record.srnumber);
    if (cached) {
      renderSubmittedDetails(cached, 'success');
      return;
    }
    if (record.public_details_state === 'pending') {
      renderSubmittedDetails(null, 'pending');
      return;
    }
    const portalId = portalIdFor(record);
    if (!portalId) {
      renderSubmittedDetails(null, 'error');
      return;
    }
    renderSubmittedDetails(null, 'loading');
    try {
      const response = await fetch(`/api/portal-detail?id=${encodeURIComponent(portalId)}&preferArchive=1`, { cache: 'no-store' });
      if (response.status === 404) {
        if (sequence === detailLoadSequence && selectedNumber === record.srnumber) {
          renderSubmittedDetails(null, 'pending');
        }
        return;
      }
      if (!response.ok) throw new Error(`Detail service returned ${response.status}`);
      const responseSource = String(response.headers.get('X-Detail-Source') || '').toLowerCase();
      const portalDetail = await response.json();
      portalDetailByNumber.set(record.srnumber, portalDetail);
      if (sequence === detailLoadSequence && selectedNumber === record.srnumber) {
        const displayState = responseSource === 'archive' || responseSource === 'stored'
          ? 'stored'
          : 'success';
        renderSubmittedDetails(portalDetail, displayState);
      }
    } catch (error) {
      if (sequence === detailLoadSequence && selectedNumber === record.srnumber) {
        renderSubmittedDetails(null, 'error');
      }
      console.warn(error);
    }
  }

  function selectRequest(number, moveMap = true) {
    const record = findRecord(number);
    if (!record) return;
    const previousNumber = selectedNumber;
    selectedNumber = number;
    renderDetail(record);
    setDetailPanelVisible(true);
    updateSelectedFeedCard(previousNumber, selectedNumber);
    loadPortalDetails(record);
    beginStatusUpdatesSelection(record);
    const coordinates = recordCoordinates(record);
    if (moveMap && coordinates) {
      cancelPendingBoundaryFit();
      map.flyTo([coordinates.lat, coordinates.lng], Math.max(map.getZoom(), 15), { duration: .6 });
      const marker = markerByNumber.get(number);
      if (marker) markerLayer.zoomToShowLayer(marker);
    }
  }

  function syncStatuses() {
    const current = statusFilter.value;
    const statuses = [...new Set(
      [...records, ...mapRecords, ...(archiveSearchRecord ? [archiveSearchRecord] : [])]
        .map(record => record.status).filter(Boolean)
    )].sort();
    statusFilter.innerHTML = '<option value="">All statuses</option>' + statuses.map(status => `<option value="${esc(status)}">${esc(status)}</option>`).join('');
    if (statuses.includes(current)) statusFilter.value = current;
    updateActiveFilterState();
  }

  function updateActiveFilterState() {
    const label = activeFilterLabel([
      statusFilter.value,
      precinctFilter.value,
      bidFilter.value
    ]);
    const active = label !== 'None selected';
    activeFilterCount.textContent = label;
    requestFilters.classList.toggle('has-active-filters', active);
  }

  function updateConnectionLabel(now = new Date()) {
    if (connection.classList.contains('offline')) return;
    if (!lastPortalCheck || Number.isNaN(lastPortalCheck.getTime())) {
      connectionLabel.textContent = 'Live monitoring active';
      return;
    }
    const ageSeconds = Math.max(0, Math.floor((now.getTime() - lastPortalCheck.getTime()) / 1000));
    connectionLabel.textContent = ageSeconds < 2
      ? 'Live · checked just now'
      : `Live · checked ${ageSeconds}s ago`;
  }

  function recordsMatch(left, right) {
    return left.length === right.length && left.every((record, index) => (
      record.srnumber === right[index].srnumber
      && recordSignature(record) === recordSignature(right[index])
    ));
  }

  function updateFeedRecords(incoming) {
    const nextRecords = incoming
      .filter(record => record && record.srnumber)
      .slice(0, MAX_VISIBLE_RECORDS)
      .sort((a, b) => suffixOf(b) - suffixOf(a));
    const newestSuffix = nextRecords.reduce((maximum, record) => Math.max(maximum, suffixOf(record)), 0);
    if (highestObservedSuffix === null) {
      highestObservedSuffix = newestSuffix;
    } else if (newestSuffix > highestObservedSuffix) {
      arrivingNumbers = new Set(nextRecords
        .filter(record => suffixOf(record) > highestObservedSuffix)
        .map(record => record.srnumber));
      highestObservedSuffix = newestSuffix;
    }
    for (const record of nextRecords) {
      const previous = feedByNumber.get(record.srnumber);
      if (previous && previous.details_fetched_at !== record.details_fetched_at) {
        portalDetailByNumber.delete(record.srnumber);
      }
      if (previous && recordDetailsPending(previous) && !recordDetailsPending(record)) {
        arrivingNumbers.add(record.srnumber);
      }
    }

    const changed = !recordsMatch(nextRecords, records);
    records = nextRecords;
    feedByNumber = new Map(records.map(record => [record.srnumber, record]));
    const mapChanged = mergeMapRecords(records);
    if (!changed && !mapChanged) return;
    syncStatuses();
    if (changed) renderFeed();
    renderMap();
    if (selectedNumber) renderDetail(findRecord(selectedNumber));
  }

  function finiteStat(value, fallback = 0) {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function precinctLabel(number) {
    const value = Number(number);
    const remainder100 = value % 100;
    const suffix = remainder100 >= 11 && remainder100 <= 13
      ? 'th'
      : value % 10 === 1 ? 'st' : value % 10 === 2 ? 'nd' : value % 10 === 3 ? 'rd' : 'th';
    return `${value}${suffix} Precinct`;
  }

  function scopedUrl(pathname, parameters = {}) {
    const params = new URLSearchParams(parameters);
    if (precinctFilter.value) params.set('police_precinct', precinctFilter.value);
    if (bidFilter.value) params.set('bid_id', bidFilter.value);
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function mapHasLayout() {
    const container = map.getContainer();
    const style = window.getComputedStyle(container);
    const bounds = container.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && bounds.width > 0 && bounds.height > 0;
  }

  function selectedBoundariesSettled() {
    return !Object.values(boundaryStates).some(state => state.requestedValue && state.loading);
  }

  function selectedBoundaryBounds() {
    const bounds = L.latLngBounds([]);
    for (const state of Object.values(boundaryStates)) {
      if (!state.layer || typeof state.layer.getBounds !== 'function') continue;
      const layerBounds = state.layer.getBounds();
      if (layerBounds && layerBounds.isValid()) bounds.extend(layerBounds);
    }
    return bounds;
  }

  function fitSelectedBoundaryUnion(revision) {
    if (!pendingBoundaryFit || revision !== boundaryFitRevision
        || !selectedBoundariesSettled() || !mapHasLayout()) return;
    const bounds = selectedBoundaryBounds();
    pendingBoundaryFit = false;
    if (!bounds.isValid()) return;
    const mapHeight = map.getContainer().getBoundingClientRect().height;
    const topPadding = Math.min(170, Math.max(32, Math.floor(mapHeight * 0.45)));
    map.fitBounds(bounds, {
      paddingTopLeft: [32, topPadding],
      paddingBottomRight: [32, 32],
      maxZoom: 16,
      animate: true,
      duration: 0.45
    });
  }

  function scheduleMapLayout({ attemptBoundaryFit = false } = {}) {
    const fitRevision = boundaryFitRevision;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!mapHasLayout()) return;
        map.invalidateSize({ pan: false, debounceMoveend: true });
        renderMap();
        if (!mapArchiveLoaded) refreshMap(mapStats, true);
        if (attemptBoundaryFit) fitSelectedBoundaryUnion(fitRevision);
      });
    });
  }

  function scheduleSelectedBoundaryFit() {
    if (!pendingBoundaryFit || !selectedBoundariesSettled()) return;
    scheduleMapLayout({ attemptBoundaryFit: true });
  }

  function cancelPendingBoundaryFit() {
    pendingBoundaryFit = false;
    boundaryFitRevision += 1;
  }

  function removeBoundaryLayer(state) {
    if (state.layer && map.hasLayer(state.layer)) map.removeLayer(state.layer);
    state.layer = null;
    state.label = '';
  }

  function updateBoundaryKey() {
    if (!mapBoundaryKey) return;
    const entries = [
      { kind: 'precinct', state: boundaryStates.precinct },
      { kind: 'bid', state: boundaryStates.bid }
    ].filter(entry => entry.state.layer && entry.state.label);
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const item = document.createElement('span');
      item.className = 'map-boundary-item';
      const swatch = document.createElement('i');
      swatch.className = `map-boundary-swatch ${entry.kind}`;
      swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'map-boundary-label';
      label.textContent = entry.state.label;
      item.append(swatch, label);
      fragment.append(item);
    }
    mapBoundaryKey.replaceChildren(fragment);
    mapBoundaryKey.hidden = entries.length === 0;
  }

  function boundaryConfiguration(kind) {
    if (kind === 'precinct') {
      return {
        value: precinctFilter.value,
        url: value => `/api/police-precincts/${encodeURIComponent(value)}/geometry`,
        serviceLabel: 'Police precinct boundary service',
        featureLabel: feature => String(
          feature && feature.properties && feature.properties.label
          || precinctLabel(precinctFilter.value)
        )
      };
    }
    return {
      value: bidFilter.value,
      url: value => `/api/business-improvement-districts/${encodeURIComponent(value)}/geometry`,
      serviceLabel: 'Business improvement district boundary service',
      featureLabel: feature => {
        const selected = bidById.get(String(bidFilter.value));
        return String(feature && feature.properties && feature.properties.name
          || selected && selected.name || `BID ${bidFilter.value}`);
      }
    };
  }

  function validBoundaryFeature(feature) {
    return Boolean(feature && feature.type === 'Feature' && feature.geometry
      && ['Polygon', 'MultiPolygon'].includes(feature.geometry.type)
      && Array.isArray(feature.geometry.coordinates));
  }

  async function loadSelectedBoundary(kind) {
    const state = boundaryStates[kind];
    const config = boundaryConfiguration(kind);
    const value = String(config.value || '');
    if (state.requestedValue === value && (state.layer || state.loading || !value)) return;

    state.sequence += 1;
    const sequence = state.sequence;
    if (state.controller) state.controller.abort();
    state.controller = null;
    state.loading = false;
    state.requestedValue = value;
    removeBoundaryLayer(state);
    updateBoundaryKey();
    if (!value) {
      scheduleSelectedBoundaryFit();
      return;
    }

    const controller = new AbortController();
    state.controller = controller;
    state.loading = true;
    try {
      const feature = await fetchJson(config.url(value), config.serviceLabel, {
        signal: controller.signal
      });
      if (sequence !== state.sequence || state.requestedValue !== value) return;
      if (!validBoundaryFeature(feature)) throw new Error(`${config.serviceLabel} returned invalid GeoJSON`);
      state.layer = L.geoJSON(feature, {
        pane: GEOGRAPHY_PANE,
        renderer: geographyRenderer,
        className: `map-boundary-path ${kind}`,
        interactive: false,
        style: boundaryStyles[kind]
      }).addTo(map);
      state.label = config.featureLabel(feature);
      updateBoundaryKey();
    } catch (error) {
      if (error.name !== 'AbortError' && sequence === state.sequence) console.warn(error);
    } finally {
      if (sequence === state.sequence) {
        state.loading = false;
        state.controller = null;
        updateBoundaryKey();
        scheduleSelectedBoundaryFit();
      }
    }
  }

  function syncSelectedBoundaries() {
    pendingBoundaryFit = Boolean(precinctFilter.value || bidFilter.value);
    boundaryFitRevision += 1;
    loadSelectedBoundary('precinct');
    loadSelectedBoundary('bid');
    scheduleSelectedBoundaryFit();
  }

  function handleMapContainerResize() {
    const bounds = map.getContainer().getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const layoutKey = `${Math.round(bounds.width)}x${Math.round(bounds.height)}`;
    if (lastMapLayoutKey && lastMapLayoutKey !== layoutKey
        && selectedBoundaryBounds().isValid()) {
      pendingBoundaryFit = true;
      boundaryFitRevision += 1;
    }
    lastMapLayoutKey = layoutKey;
    scheduleMapLayout({ attemptBoundaryFit: pendingBoundaryFit });
  }

  if ('ResizeObserver' in window) {
    const mapResizeObserver = new ResizeObserver(handleMapContainerResize);
    mapResizeObserver.observe(map.getContainer());
  } else {
    window.addEventListener('resize', handleMapContainerResize);
  }

  async function loadArchivedRequest(srnumber, sequence) {
    try {
      const payload = await fetchJson(scopedUrl('/api/live-dashboard', {
        limit: 1,
        srnumber,
        compact: 1
      }), 'Archive search');
      if (sequence !== archiveSearchSequence || exactSrnumberQuery() !== srnumber) return;
      const found = Array.isArray(payload.records) ? payload.records[0] : null;
      archiveSearchRecord = found || feedByNumber.get(srnumber) || mapByNumber.get(srnumber) || null;
      archiveSearchState = archiveSearchRecord ? 'found' : 'not_found';
      syncStatuses();
      renderFeed({ resetScroll: true });
      renderMap();
    } catch (error) {
      if (sequence !== archiveSearchSequence || exactSrnumberQuery() !== srnumber) return;
      archiveSearchRecord = feedByNumber.get(srnumber) || mapByNumber.get(srnumber) || null;
      archiveSearchState = archiveSearchRecord ? 'found' : 'error';
      renderFeed({ resetScroll: true });
      renderMap();
      console.warn(error);
    }
  }

  function scheduleArchiveSearch() {
    if (archiveSearchTimer !== null) {
      window.clearTimeout(archiveSearchTimer);
      archiveSearchTimer = null;
    }
    const srnumber = exactSrnumberQuery();
    const sequence = ++archiveSearchSequence;
    if (!srnumber) {
      const clearedRecord = archiveSearchRecord;
      archiveSearchRecord = null;
      archiveSearchState = 'idle';
      syncStatuses();
      if (clearedRecord && selectedNumber === clearedRecord.srnumber
          && !feedByNumber.has(selectedNumber) && !mapByNumber.has(selectedNumber)) {
        selectedNumber = null;
        setDetailPanelVisible(false);
      }
      renderFeed({ resetScroll: true });
      renderMap();
      return;
    }
    archiveSearchRecord = feedByNumber.get(srnumber) || mapByNumber.get(srnumber) || null;
    archiveSearchState = archiveSearchRecord ? 'found' : 'loading';
    renderFeed({ resetScroll: true });
    renderMap();
    archiveSearchTimer = window.setTimeout(() => {
      archiveSearchTimer = null;
      loadArchivedRequest(srnumber, sequence);
    }, 150);
  }

  async function loadPolicePrecincts() {
    try {
      const payload = await fetchJson('/api/police-precincts', 'Police precinct service');
      const precincts = Array.isArray(payload.precincts) ? payload.precincts : [];
      precinctFilter.innerHTML = '<option value="">All police precincts</option>'
        + precincts.map(precinct => `<option value="${Number(precinct.precinct_number)}">${esc(precinct.label || precinctLabel(precinct.precinct_number))}</option>`).join('');
      precinctFilter.disabled = precincts.length === 0;
    } catch (error) {
      precinctFilter.innerHTML = '<option value="">Precinct filter unavailable</option>';
      precinctFilter.disabled = true;
      console.warn(error);
    }
  }

  async function loadBusinessImprovementDistricts() {
    try {
      const payload = await fetchJson(
        '/api/business-improvement-districts',
        'Business improvement district service'
      );
      const districts = Array.isArray(payload.districts) ? payload.districts : [];
      bidById = new Map(districts.map(district => [String(district.bid_id), district]));
      bidFilter.innerHTML = '<option value="">All business improvement districts</option>'
        + districts.map(district => {
          const suffix = district.borough_name ? ` — ${district.borough_name}` : '';
          return `<option value="${Number(district.bid_id)}">${esc(district.name)}${esc(suffix)}</option>`;
        }).join('');
      bidFilter.disabled = districts.length === 0;
      if (dashboardPayloadLoaded) {
        renderFeed();
        renderMap();
        if (selectedNumber) renderDetail(findRecord(selectedNumber));
      }
    } catch (error) {
      bidFilter.innerHTML = '<option value="">BID filter unavailable</option>';
      bidFilter.disabled = true;
      console.warn(error);
    }
  }

  function mergeMapRecords(incoming) {
    let changed = false;
    for (const incomingRecord of incoming) {
      if (!incomingRecord || !incomingRecord.srnumber || !recordCoordinates(incomingRecord)) continue;
      const record = feedByNumber.get(incomingRecord.srnumber) || incomingRecord;
      const previous = mapByNumber.get(record.srnumber);
      if (previous && recordSignature(previous) === recordSignature(record)) continue;
      mapByNumber.set(record.srnumber, record);
      changed = true;
    }
    if (changed) mapRecords = [...mapByNumber.values()];
    return changed;
  }

  function updateMapRecords(payload, dashboardStats) {
    const incoming = Array.isArray(payload) ? payload : payload.records || [];
    const stats = Array.isArray(payload) ? {} : payload.stats || {};
    mergeMapRecords(incoming);
    const totalsAvailable = Number.isFinite(Number(stats.total))
      || Number.isFinite(Number(dashboardStats && dashboardStats.total));
    const total = finiteStat(stats.total, finiteStat(dashboardStats.total, mapRecords.length));
    const mapped = finiteStat(stats.mapped_total, mapRecords.length);
    mapStats = {
      total,
      mapped_total: mapped,
      unmapped_total: finiteStat(
        stats.unmapped_total,
        finiteStat(dashboardStats.unmapped_total, Math.max(0, total - mapped))
      ),
      totals_available: totalsAvailable
    };
    syncStatuses();
    renderMap();
    if (selectedNumber && !feedByNumber.has(selectedNumber)) renderDetail(findRecord(selectedNumber));
  }

  async function fetchJson(url, label, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    if (!response.ok) throw new Error(`${label} returned ${response.status}`);
    return response.json();
  }

  function updateMapStatsFromDashboard(stats) {
    const totalsAvailable = Number.isFinite(Number(stats.total));
    mapStats = {
      ...mapStats,
      total: finiteStat(stats.total, mapStats.total),
      unmapped_total: finiteStat(stats.unmapped_total, mapStats.unmapped_total),
      totals_available: totalsAvailable || mapStats.totals_available
    };
    updateMapCountText();
  }

  function percentage(part, total) {
    if (!Number.isFinite(total) || total <= 0) return '—';
    return `${Math.round(Math.max(0, Math.min(1, part / total)) * 100)}%`;
  }

  function renderOverviewStats(stats) {
    if (stats && stats.compact && stats.total == null) {
      document.getElementById('total-count').textContent = '—';
      document.getElementById('details-coverage-rate').textContent = '—';
      document.getElementById('details-coverage-note').textContent =
        'Archive scan skipped on the live path';
      document.getElementById('map-coverage-rate').textContent = '—';
      document.getElementById('map-coverage-note').textContent =
        'Pins load directly on the map';
      document.getElementById('pending-count').textContent = '—';
      document.getElementById('closures-count').textContent = '—';
      document.getElementById('closures-note').textContent =
        'See live pipeline health above';
      return;
    }
    const total = finiteStat(stats.total);
    const detailsPending = finiteStat(stats.details_pending);
    const detailsLoaded = finiteStat(stats.details_loaded, Math.max(0, total - detailsPending));
    const unmapped = finiteStat(stats.unmapped_total);
    const mapped = Math.max(0, total - unmapped);
    const closing = finiteStat(stats.closure_refreshes_pending);

    document.getElementById('total-count').textContent = total.toLocaleString();
    document.getElementById('details-coverage-rate').textContent = percentage(detailsLoaded, total);
    document.getElementById('details-coverage-note').textContent = detailsPending
      ? `${detailsPending.toLocaleString()} pending`
      : 'Complete';
    document.getElementById('map-coverage-rate').textContent = percentage(mapped, total);
    document.getElementById('map-coverage-note').textContent = unmapped
      ? `${unmapped.toLocaleString()} without a pin`
      : 'All requests mapped';
    document.getElementById('pending-count').textContent = finiteStat(stats.pending).toLocaleString();
    document.getElementById('closures-count').textContent = finiteStat(stats.closures_finalized).toLocaleString();
    document.getElementById('closures-note').textContent = `${closing.toLocaleString()} ${closing === 1 ? 'check' : 'checks'} in progress`;
  }

  const legacyReconciliationStatusLabels = {
    pending: 'Queued',
    running: 'Checking official records',
    paused_rate_limit: 'Respecting NYC311 rate limit',
    applying: 'Saving verified results',
    subscribing: 'Subscribing open requests',
    complete: 'Complete',
    failed: 'Needs attention'
  };

  function legacyReconciliationCount(value, maximum = Number.MAX_SAFE_INTEGER) {
    return Number.isSafeInteger(value) && value >= 0
      ? Math.min(value, maximum)
      : 0;
  }

  function normalizeLegacyReconciliation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.version !== 1 || !legacyReconciliationStatusLabels[value.status]) return null;
    const total = legacyReconciliationCount(value.total_candidates);
    const checked = legacyReconciliationCount(
      value.checked,
      total || Number.MAX_SAFE_INTEGER
    );
    const apiReturned = legacyReconciliationCount(value.api_returned, checked);
    const apiClosed = legacyReconciliationCount(value.api_closed, apiReturned);
    const apiOpen = legacyReconciliationCount(value.api_open, apiReturned);
    const percent = total > 0
      ? Math.min(100, Number(((checked / total) * 100).toFixed(1)))
      : value.status === 'complete' ? 100 : 0;
    return {
      status: value.status,
      total,
      checked,
      percent,
      apiReturned,
      apiOpen,
      apiOmitted: legacyReconciliationCount(value.api_omitted, checked),
      closuresCorrected: legacyReconciliationCount(value.closures_corrected, apiClosed),
      subscriptionsQueued: legacyReconciliationCount(
        value.open_subscriptions_queued,
        apiOpen + legacyReconciliationCount(value.api_omitted, checked)
      ),
      errors: legacyReconciliationCount(value.errors),
      retryAfterSeconds: value.retry_after_seconds == null
        ? null
        : legacyReconciliationCount(value.retry_after_seconds, 86_400),
      estimatedSecondsRemaining: value.estimated_seconds_remaining == null
        ? null
        : legacyReconciliationCount(value.estimated_seconds_remaining, 31_536_000),
      updatedAt: value.updated_at,
      finishedAt: value.finished_at,
      message: typeof value.message === 'string' ? value.message.slice(0, 300).trim() : ''
    };
  }

  function renderLegacyReconciliation(value) {
    if (!hasLegacyReconciliationElements) return;
    const model = normalizeLegacyReconciliation(value);
    if (!model) {
      legacyReconciliationElements.root.hidden = true;
      legacyReconciliationElements.root.removeAttribute('data-state');
      return;
    }

    const {
      root, status, percent, count, updated, progress,
      returned, closed, open, omitted, detail
    } = legacyReconciliationElements;
    root.hidden = false;
    root.dataset.state = model.status;
    status.textContent = legacyReconciliationStatusLabels[model.status];
    percent.textContent = `${model.percent.toLocaleString()}%`;
    count.textContent =
      `${model.checked.toLocaleString()} of ${model.total.toLocaleString()} checked`;
    progress.value = model.percent;
    progress.textContent = `${model.percent}%`;
    returned.textContent = model.apiReturned.toLocaleString();
    closed.textContent = model.closuresCorrected.toLocaleString();
    open.textContent = model.apiOpen.toLocaleString();
    omitted.textContent = model.apiOmitted.toLocaleString();

    const timestamp = model.status === 'complete'
      ? model.finishedAt || model.updatedAt
      : model.updatedAt;
    const timestampLabel = timestamp && fullTimeLabel(timestamp) !== 'Unknown'
      ? `${model.status === 'complete' ? 'Completed' : 'Updated'} ${fullTimeLabel(timestamp)}`
      : model.status === 'pending' ? 'Waiting to start' : 'Update time unavailable';
    const eta = model.estimatedSecondsRemaining == null
      ? ''
      : ` · about ${formatMetricDuration(model.estimatedSecondsRemaining)} remaining`;
    const retry = model.status === 'paused_rate_limit' && model.retryAfterSeconds != null
      ? ` · retrying in ${formatMetricDuration(model.retryAfterSeconds)}`
      : '';
    updated.textContent = `${timestampLabel}${retry || eta}`;

    const defaultDetails = {
      pending: 'The historical record list is ready for its one-time official check.',
      running: 'Checking legacy records in rate-limited batches and saving a checkpoint after each batch.',
      paused_rate_limit: 'NYC311 asked the repair to slow down. Progress is saved and will resume automatically.',
      applying: 'The official results are being applied to the archive in one protected database update.',
      subscribing: model.subscriptionsQueued
        ? `${model.subscriptionsQueued.toLocaleString()} still-open requests have been queued for email subscription.`
        : 'Still-open legacy requests are being queued for future email updates.',
      complete: `${model.closuresCorrected.toLocaleString()} historical ${
        model.closuresCorrected === 1 ? 'closure was' : 'closures were'
      } corrected. Live monitoring continues through the existing subscription pipeline.`,
      failed: 'The one-time repair stopped with its checkpoint saved. Existing live monitoring is unaffected.'
    };
    const errorNote = model.errors
      ? ` · ${model.errors.toLocaleString()} ${model.errors === 1 ? 'error' : 'errors'} recorded`
      : '';
    detail.textContent = `${model.message || defaultDetails[model.status]}${errorNote}`;
  }

  function renderStatusClarity(stats = {}, emailModel = lastGoodEmailMetrics) {
    if (!hasStatusClarityElements) return;
    const model = emailModel || {};
    const deliveries = model.deliveries || {};
    const subscriptions = model.subscriptions || {};
    const verification = model.verification || {};
    const subscribed = finiteStat(subscriptions.subscribed);
    const pending = finiteStat(subscriptions.pending);
    const processing = finiteStat(subscriptions.processing);
    const retry = finiteStat(subscriptions.retry);
    const closing = finiteStat(stats.closure_refreshes_pending);
    const finalized = finiteStat(stats.closures_finalized);
    const detailsPending = finiteStat(stats.details_pending);
    const usableEmails = finiteStat(deliveries.usable);
    const totalEmails = finiteStat(deliveries.total);
    const closedEmails = finiteStat(deliveries.closed);
    const mode = model.monitoring_mode || { label: 'Checking monitoring mode', key: 'unknown' };
    const queue = [
      pending ? `${pending.toLocaleString()} pending` : '',
      processing ? `${processing.toLocaleString()} processing` : '',
      retry ? `${retry.toLocaleString()} retrying` : ''
    ].filter(Boolean);

    statusClarityElements.mode.textContent = mode.label;
    statusClarityElements.mode.dataset.mode = mode.key || 'unknown';
    statusClarityElements.tracked.textContent = subscribed.toLocaleString();
    statusClarityElements.trackedNote.textContent = queue.length
      ? queue.join(' · ')
      : 'New matching requests are subscribed';
    statusClarityElements.emailCount.textContent = usableEmails.toLocaleString();
    statusClarityElements.emailNote.textContent = totalEmails && usableEmails !== totalEmails
      ? `${totalEmails.toLocaleString()} total accepted`
      : 'Direct, matched, authenticated emails';
    statusClarityElements.closedEmailCount.textContent = closedEmails.toLocaleString();
    statusClarityElements.closedEmailNote.textContent = verification.awaiting_within_grace
      ? `${verification.awaiting_within_grace.toLocaleString()} known closures still inside grace`
      : 'Fast closure signal from NYC311 email';
    const compactArchiveStats = stats.compact && stats.closures_finalized == null;
    statusClarityElements.portalClosedCount.textContent = compactArchiveStats
      ? '—'
      : finalized.toLocaleString();
    statusClarityElements.portalClosedNote.textContent = compactArchiveStats
      ? 'Archive-wide count skipped on live load'
      : closing
        ? `${closing.toLocaleString()} ${closing === 1 ? 'closure is' : 'closures are'} being verified`
        : 'No final verifications waiting';
    const subscriptionBacklog = pending + processing + retry;
    const catchup = [
      subscriptionBacklog
        ? `${subscriptionBacklog.toLocaleString()} email ${subscriptionBacklog === 1 ? 'subscription' : 'subscriptions'}`
        : '',
      detailsPending
        ? `${detailsPending.toLocaleString()} submitted-detail ${detailsPending === 1 ? 'page' : 'pages'}`
        : ''
    ].filter(Boolean);
    statusClarityElements.root.dataset.health = catchup.length ? 'catching-up' : 'current';
    statusClarityElements.note.textContent = catchup.length
      ? `Catching up: ${catchup.join(' and ')} queued. New requests are prioritized while older records drain in the background.`
      : mode.key === 'email_primary'
        ? 'Email is the primary realtime signal. Closed emails are fast; Portal verification saves the final proof.'
        : 'Email notices are the fast signal. Portal verification is the saved final proof.';
    statusClarityElements.root.setAttribute('aria-busy', 'false');
  }

  function releasePhaseLabel(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    return formatMetricDuration(seconds);
  }

  function healthAge(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return 'an unknown time';
    if (value < 5) return 'just now';
    if (value < 60) return `${Math.round(value)}s ago`;
    if (value < 60 * 60) return `${Math.round(value / 60)}m ago`;
    if (value < 24 * 60 * 60) return `${Math.round(value / 3600)}h ago`;
    return `${Math.round(value / 86400)}d ago`;
  }

  function healthDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return 'unknown';
    if (value < 60) return `${Math.round(value)}s`;
    if (value < 60 * 60) return `${Math.round(value / 60)}m`;
    if (value < 24 * 60 * 60) return `${Math.round(value / 3600)}h`;
    return `${Math.round(value / 86400)}d`;
  }

  function healthStatusLabel(component, name) {
    const status = String(component && component.status || 'attention');
    if (status === 'healthy') return 'Working';
    if (status === 'delayed') return 'Delayed';
    if (status === 'quiet') {
      if (name === 'analytics') return component.available ? 'Saved' : 'Paused';
      if (name === 'email') return 'Quiet';
      return 'Up to date';
    }
    return 'Needs attention';
  }

  function queueHealthDetail(component, noun) {
    if (!component || component.available === false) return `${noun} health is unavailable`;
    const next = component.next;
    if (!next) return `No ${noun.toLowerCase()} work is waiting`;
    if (next.state === 'error') return `A ${noun.toLowerCase()} item needs review`;
    if (next.state === 'working' || next.state === 'processing') {
      return `Processing now · updated ${healthAge(next.updated_age_seconds)}`;
    }
    if (next.due === 'overdue') {
      return `Oldest ${noun.toLowerCase()} item is ${healthDuration(next.overdue_seconds)} overdue`;
    }
    if (next.due === 'scheduled') {
      return `Next ${noun.toLowerCase()} item in ${healthDuration(next.due_in_seconds)}`;
    }
    return `${noun} work is ready`;
  }

  function systemHealthDetail(name, component) {
    if (!component || component.available === false) {
      return name === 'database'
        ? 'The live database is not responding'
        : 'This health signal is unavailable';
    }
    if (name === 'database') {
      const megabytes = Number(component.file_size_bytes) / (1024 * 1024);
      return Number.isFinite(megabytes)
        ? `Live database responded · ${Math.round(megabytes).toLocaleString()} MB`
        : 'Live database responded';
    }
    if (name === 'collector') {
      return component.last_successful_poll_at
        ? `Latest request scan ${healthAge(component.poll_age_seconds)}`
        : 'No successful request scan recorded';
    }
    if (name === 'map') {
      const interval = Number(component.poll_interval_seconds);
      const cadence = Number.isFinite(interval) ? ` · every ${interval}s` : '';
      return component.last_successful_poll_at
        ? `Portal map checked ${healthAge(component.poll_age_seconds)}${cadence}`
        : 'No successful map check recorded';
    }
    if (name === 'details') return queueHealthDetail(component, 'Detail');
    if (name === 'subscriptions') return queueHealthDetail(component, 'Subscription');
    if (name === 'closures') return queueHealthDetail(component, 'Closure');
    if (name === 'email') {
      const event = component.latest_event;
      if (!event) return 'No NYC311 response email has arrived yet';
      return component.status === 'attention'
        ? `Latest email ${healthAge(event.age_seconds)} needs parsing review`
        : `Latest NYC311 response arrived ${healthAge(event.age_seconds)}`;
    }
    if (name === 'analytics') {
      if (!component.generated_at) return 'No saved response-statistics snapshot';
      if (component.refresh_disabled) {
        return `Saved ${healthAge(component.age_seconds)} · recalculation paused to protect live traffic`;
      }
      if (component.stale) return `Saved snapshot updated ${healthAge(component.age_seconds)}`;
      return `Response statistics saved ${healthAge(component.age_seconds)}`;
    }
    return 'Health signal received';
  }

  function renderOperationalHealth(payload) {
    if (!hasSystemHealthElements || !payload || !payload.components) return false;
    const components = payload.components;
    const mapping = {
      database: components.database,
      collector: components.map_discovery,
      map: components.map_discovery,
      details: components.details,
      email: components.email_intake,
      subscriptions: components.subscriptions,
      closures: components.closure_verification,
      analytics: components.analytics
    };
    for (const name of healthComponentNames) {
      const component = mapping[name] || {
        status: 'attention',
        available: false
      };
      const card = systemHealthElements.cards[name];
      card.root.dataset.status = component.status;
      card.status.textContent = healthStatusLabel(component, name);
      card.detail.textContent = systemHealthDetail(name, component);
    }
    const overallStatus = ['healthy', 'delayed', 'attention', 'quiet']
      .includes(payload.status) ? payload.status : 'attention';
    const overallLabels = {
      healthy: 'All working',
      delayed: 'Some delays',
      attention: 'Needs attention',
      quiet: 'Standing by'
    };
    systemHealthElements.overall.dataset.status = overallStatus;
    systemHealthElements.overall.textContent = overallLabels[overallStatus];
    systemHealthElements.updated.textContent = payload.generated_at
      ? `Checked ${fullTimeLabel(payload.generated_at)}`
      : 'Checked just now';
    systemHealthElements.root.setAttribute('aria-busy', 'false');
    return true;
  }

  function showOperationalHealthUnavailable() {
    if (!hasSystemHealthElements) return;
    systemHealthElements.overall.dataset.status = 'attention';
    systemHealthElements.overall.textContent = 'Check unavailable';
    systemHealthElements.updated.textContent = 'The health endpoint will retry automatically';
    systemHealthElements.root.setAttribute('aria-busy', 'false');
  }

  async function refreshOperationalHealth() {
    if (!overviewIsActive() || operationalHealthInFlight || !hasSystemHealthElements) return;
    operationalHealthInFlight = true;
    try {
      const payload = await fetchJson('/api/operational-health', 'Health service');
      renderOperationalHealth(payload);
    } catch (error) {
      showOperationalHealthUnavailable();
      console.warn(error);
    } finally {
      operationalHealthInFlight = false;
    }
  }

  function showReleaseInfoUnavailable(message = 'No timed deployment has been recorded yet.') {
    if (!hasReleaseSpeedElements) return;
    releaseSpeedElements.root.setAttribute('aria-busy', 'false');
    releaseSpeedElements.updated.textContent = 'Not recorded yet';
    releaseSpeedElements.total.textContent = '—';
    releaseSpeedElements.summary.textContent = message;
    releaseSpeedElements.tests.textContent = '—';
    releaseSpeedElements.upload.textContent = '—';
    releaseSpeedElements.activate.textContent = '—';
    releaseSpeedElements.visible.textContent = '—';
    releaseSpeedElements.note.textContent =
      'The next deployment will write timing data after production passes its health check.';
  }

  function renderReleaseInfo(payload) {
    if (!hasReleaseSpeedElements) return false;
    if (!payload || payload.available === false) {
      showReleaseInfoUnavailable(payload && payload.message);
      return false;
    }
    const phases = payload.phase_seconds && typeof payload.phase_seconds === 'object'
      ? payload.phase_seconds
      : {};
    const deployedAt = portalDate(payload.deployed_at);
    const shortSha = String(payload.short_sha || payload.release_sha || '').slice(0, 7);
    releaseSpeedElements.root.setAttribute('aria-busy', 'false');
    releaseSpeedElements.updated.textContent = deployedAt && !Number.isNaN(deployedAt.getTime())
      ? `Deployed ${fullTimeLabel(payload.deployed_at)}`
      : 'Latest timed deployment';
    releaseSpeedElements.total.textContent = releasePhaseLabel(phases.total);
    releaseSpeedElements.summary.textContent = shortSha
      ? `Release ${shortSha} reached production.`
      : 'Latest release reached production.';
    releaseSpeedElements.tests.textContent = releasePhaseLabel(phases.tests);
    releaseSpeedElements.upload.textContent = releasePhaseLabel(phases.package_upload);
    releaseSpeedElements.activate.textContent = releasePhaseLabel(phases.remote_activate);
    releaseSpeedElements.visible.textContent = releasePhaseLabel(phases.public_health_check);
    releaseSpeedElements.note.textContent =
      'Measured from local validation through the public production health check.';
    return true;
  }

  async function refreshReleaseInfo() {
    if (!overviewIsActive() || releaseInfoInFlight || !hasReleaseSpeedElements) return;
    releaseInfoInFlight = true;
    lastReleaseInfoAttemptAt = Date.now();
    try {
      const payload = await fetchJson('/api/release-info', 'Release timing service');
      renderReleaseInfo(payload);
    } catch (error) {
      showReleaseInfoUnavailable('Release timing is temporarily unavailable.');
      console.warn(error);
    } finally {
      releaseInfoInFlight = false;
    }
  }

  function emailMetricPercent(value) {
    if (value == null || value === '') return '—';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '—';
    return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  }

  function responseTimeDetail(p90Seconds, sampleSize) {
    if (sampleSize < 10) return `n=${sampleSize.toLocaleString()}`;
    const qualification = sampleSize < 20 ? 'Limited sample · ' : '';
    return `${qualification}90% within ${formatMetricDuration(p90Seconds)} · n=${sampleSize.toLocaleString()}`;
  }

  function responseTimeHeadline(medianSeconds, sampleSize) {
    return sampleSize < 10
      ? 'Insufficient sample'
      : formatMetricDuration(medianSeconds);
  }

  function renderResponseTimeTable(element, rows, emptyMessage) {
    element.replaceChildren();
    if (!rows.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 3;
      cell.className = 'response-table-empty';
      cell.textContent = emptyMessage;
      row.append(cell);
      element.append(row);
      return;
    }
    const previewLimit = 12;
    const expanded = expandedResponseTables.has(element.id);
    const visibleRows = expanded ? rows : rows.slice(0, previewLimit);
    const fragment = document.createDocumentFragment();
    for (const metric of visibleRows) {
      const row = document.createElement('tr');
      const label = document.createElement('th');
      label.scope = 'row';
      label.textContent = metric.label;
      row.append(label);
      for (const kind of ['update', 'closure']) {
        const sampleSize = Number(metric[`${kind}_count`] || 0);
        const cell = document.createElement('td');
        const median = document.createElement('strong');
        median.textContent = sampleSize < 10
          ? 'Insufficient sample'
          : formatMetricDuration(metric[`${kind}_median_seconds`]);
        if (sampleSize < 10) cell.classList.add('response-cell-insufficient');
        else if (sampleSize < 20) cell.classList.add('response-cell-limited');
        const detail = document.createElement('small');
        detail.textContent = responseTimeDetail(
          metric[`${kind}_p90_seconds`],
          sampleSize
        );
        cell.append(median, detail);
        row.append(cell);
      }
      fragment.append(row);
    }
    if (rows.length > previewLimit) {
      const toggleRow = document.createElement('tr');
      toggleRow.className = 'response-table-toggle-row';
      const toggleCell = document.createElement('td');
      toggleCell.colSpan = 3;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'response-table-toggle';
      toggle.textContent = expanded
        ? `Show top ${previewLimit}`
        : `Show all ${rows.length.toLocaleString()}`;
      toggle.addEventListener('click', () => {
        if (expanded) expandedResponseTables.delete(element.id);
        else expandedResponseTables.add(element.id);
        renderResponseTimeTable(element, rows, emptyMessage);
      });
      toggleCell.append(toggle);
      toggleRow.append(toggleCell);
      fragment.append(toggleRow);
    }
    element.append(fragment);
  }

  function showEmailMetricsUnavailable() {
    if (!hasEmailMetricElements) return;
    emailMetricElements.root.setAttribute('aria-busy', 'false');
    emailMetricElements.responseRoot.setAttribute('aria-busy', 'false');
    if (lastGoodEmailMetrics) {
      emailMetricElements.status.textContent =
        'Metrics refresh delayed. Showing the last successful email metrics refresh.';
      return;
    }
    emailMetricElements.mode.textContent = 'Metrics unavailable';
    emailMetricElements.mode.dataset.mode = 'unknown';
    emailMetricElements.status.textContent =
      'Email monitoring metrics are temporarily unavailable. Live requests are still updating.';
    emailMetricElements.responseUpdated.textContent = 'Unavailable';
    renderResponseTimeTable(
      emailMetricElements.agencies,
      [],
      'Agency response metrics are temporarily unavailable.'
    );
    renderResponseTimeTable(
      emailMetricElements.complaintTypes,
      [],
      'Complaint response metrics are temporarily unavailable.'
    );
  }

  function showEmailMetricsCalculating(payload = {}) {
    if (!hasEmailMetricElements) return;
    const message = typeof payload.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : 'Calculating email and response-time statistics in the background. Requests and the map remain available.';
    emailMetricElements.root.setAttribute('aria-busy', 'true');
    emailMetricElements.responseRoot.setAttribute('aria-busy', 'true');
    emailMetricElements.mode.textContent = 'Calculating metrics…';
    emailMetricElements.mode.dataset.mode = 'calculating';
    emailMetricElements.responseUpdated.textContent = 'Calculating…';
    emailMetricElements.status.textContent = lastGoodEmailMetrics
      ? `${message} Showing the last completed calculation until the refresh finishes.`
      : message;
  }

  function renderEmailMetrics(payload) {
    if (!hasEmailMetricElements) return false;
    const model = buildEmailMetricsModel(payload);
    if (!model.available) {
      showEmailMetricsUnavailable();
      return false;
    }
    const deliveries = model.deliveries;
    const subscriptions = model.subscriptions;
    const verification = model.verification;
    const overall = model.response_times.overall;
    const queueParts = [];
    if (subscriptions.pending) {
      queueParts.push(`${subscriptions.pending.toLocaleString()} pending`);
    }
    if (subscriptions.processing) {
      queueParts.push(`${subscriptions.processing.toLocaleString()} processing`);
    }
    if (subscriptions.retry) {
      queueParts.push(`${subscriptions.retry.toLocaleString()} retrying`);
    }
    const subscriptionNote = queueParts.length
      ? queueParts.join(' · ')
      : 'Enrollment queue is clear';
    const asOf = portalDate(model.as_of);
    const asOfLabel = asOf && !Number.isNaN(asOf.getTime())
      ? `As of ${timeLabel(model.as_of)}`
      : 'Latest available sample';

    emailMetricElements.mode.textContent = model.monitoring_mode.label;
    emailMetricElements.mode.dataset.mode = model.monitoring_mode.key;
    emailMetricElements.total.textContent = deliveries.total.toLocaleString();
    emailMetricElements.usable.textContent =
      `${deliveries.usable.toLocaleString()} usable · ${emailMetricPercent(deliveries.usable_percent)}`;
    emailMetricElements.lastReceived.textContent = deliveries.last_received_at
      ? `Latest email ${fullTimeLabel(deliveries.last_received_at)}`
      : 'No status email received yet';
    emailMetricElements.submitted.textContent = deliveries.submitted.toLocaleString();
    emailMetricElements.updated.textContent = deliveries.updated.toLocaleString();
    emailMetricElements.closed.textContent = deliveries.closed.toLocaleString();
    emailMetricElements.issues.textContent = deliveries.issues.toLocaleString();
    emailMetricElements.subscriptions.textContent = subscriptions.subscribed.toLocaleString();
    emailMetricElements.subscriptionNote.textContent = subscriptionNote;
    emailMetricElements.archiveSubscriptions.textContent =
      subscriptions.subscribed.toLocaleString();
    emailMetricElements.archiveSubscriptionNote.textContent = subscriptionNote;
    emailMetricElements.coverage.textContent =
      emailMetricPercent(verification.coverage_percent);
    const graceLabel = formatMetricDuration(verification.grace_seconds);
    const graceText = graceLabel === '—' ? 'the grace period' : `${graceLabel} grace`;
    const matureAge = graceLabel === '—'
      ? 'past the grace period'
      : `at least ${graceLabel} old`;
    const awaitingText = verification.awaiting_within_grace
      ? ` · ${verification.awaiting_within_grace.toLocaleString()} still within grace`
      : '';
    emailMetricElements.coverageNote.textContent = verification.eligible_portal_closures
      ? `${verification.closed_emails_received.toLocaleString()} of ${verification.eligible_portal_closures.toLocaleString()} known closures ${matureAge} had a matched Closed email · ${verification.missing.toLocaleString()} missing${awaitingText}`
      : verification.awaiting_within_grace
        ? `${verification.awaiting_within_grace.toLocaleString()} known ${verification.awaiting_within_grace === 1 ? 'closure is' : 'closures are'} still within ${graceText}`
        : 'No known Portal closures are beyond the grace period yet';
    emailMetricElements.coverageLimitation.textContent =
      'Coverage only includes closures independently found in stored Portal detail; it cannot measure closures absent from that data.';
    const deliveryNotes = [];
    if (!deliveries.issues) {
      deliveryNotes.push('No direct-delivery issues need review.');
    } else if (
      deliveries.unrecognized_submitted === deliveries.issues
      && !deliveries.detail_issues
    ) {
      deliveryNotes.push(
        `${deliveries.issues.toLocaleString()} earlier Submitted ${deliveries.issues === 1 ? 'notice uses' : 'notices use'} the previously unsupported template; Updated and Closed messages are parsed separately.`
      );
    } else {
      deliveryNotes.push(
        `${deliveries.issues.toLocaleString()} ${deliveries.issues === 1 ? 'direct email needs' : 'direct emails need'} review.`
      );
      if (deliveries.detail_issues) {
        deliveryNotes.push(
          `${deliveries.detail_issues.toLocaleString()} ${deliveries.detail_issues === 1 ? 'is' : 'are'} missing an expected agency, complaint type, or response.`
        );
      }
      if (deliveries.authentication_issues) {
        deliveryNotes.push(
          `${deliveries.authentication_issues.toLocaleString()} failed sender authentication and ${deliveries.authentication_issues === 1 ? 'is' : 'are'} excluded from status evidence.`
        );
      }
      if (deliveries.unrecognized_submitted) {
        deliveryNotes.push(
          `${deliveries.unrecognized_submitted.toLocaleString()} ${deliveries.unrecognized_submitted === 1 ? 'is an unparsed Submitted notice' : 'are unparsed Submitted notices'}.`
        );
      }
    }
    if (deliveries.excluded_non_direct) {
      deliveryNotes.push(
        `${deliveries.excluded_non_direct.toLocaleString()} forwarded ${deliveries.excluded_non_direct === 1 ? 'attachment is' : 'attachments are'} stored but excluded from authoritative subscription metrics.`
      );
    }
    emailMetricElements.status.textContent =
      `Usable means directly delivered, sender-authenticated, parsed, and matched. ${deliveryNotes.join(' ')}`;

    emailMetricElements.overallUpdateMedian.textContent =
      responseTimeHeadline(overall.update_median_seconds, overall.update_count);
    emailMetricElements.overallUpdateDetail.textContent =
      responseTimeDetail(overall.update_p90_seconds, overall.update_count);
    emailMetricElements.overallClosureMedian.textContent =
      responseTimeHeadline(overall.closure_median_seconds, overall.closure_count);
    emailMetricElements.overallClosureDetail.textContent =
      responseTimeDetail(overall.closure_p90_seconds, overall.closure_count);
    emailMetricElements.overallNotificationMedian.textContent =
      responseTimeHeadline(
        overall.closure_notification_median_seconds,
        overall.closure_notification_count
      );
    emailMetricElements.overallNotificationDetail.textContent =
      responseTimeDetail(
        overall.closure_notification_p90_seconds,
        overall.closure_notification_count
      );
    const cohort = model.response_times.cohort;
    const cohortWindow = formatMetricDuration(cohort.early_subscription_seconds);
    const cohortStart = cohort.started_at
      ? ` Observed since ${fullTimeLabel(cohort.started_at)}.`
      : '';
    emailMetricElements.responseCohortNote.textContent = cohort.requests
      ? `Cohort: ${cohort.requests.toLocaleString()} requests subscribed within ${cohortWindow} of submission.${cohortStart} Right-censored: ${cohort.right_censored_without_first_updated.toLocaleString()} without a first update · ${cohort.right_censored_without_observed_portal_closure.toLocaleString()} without an observed closure. Each median uses requests that reached that event.`
      : 'No requests have entered the prospective response-time cohort yet.';
    emailMetricElements.responseUpdated.textContent = asOfLabel;
    renderResponseTimeTable(
      emailMetricElements.agencies,
      model.response_times.by_agency,
      'No agency response samples yet.'
    );
    renderResponseTimeTable(
      emailMetricElements.complaintTypes,
      model.response_times.by_complaint_type,
      'No complaint response samples yet.'
    );
    emailMetricElements.root.setAttribute('aria-busy', 'false');
    emailMetricElements.responseRoot.setAttribute('aria-busy', 'false');
    emailMetricsRefreshPending = false;
    lastGoodEmailMetrics = model;
    renderStatusClarity(lastDashboardStats || {}, model);
    if (selectedNumber) {
      const selectedRecord = findRecord(selectedNumber);
      if (selectedRecord) renderDetail(selectedRecord);
    }
    return true;
  }

  async function refreshEmailMetrics() {
    if (!overviewIsActive() || emailMetricsInFlight || !hasEmailMetricElements) return;
    emailMetricsInFlight = true;
    lastEmailMetricsAttemptAt = Date.now();
    try {
      const payload = await fetchJson('/api/email-metrics', 'Email metrics service');
      if (payload && payload.refreshing === true) {
        emailMetricsRefreshPending = true;
        showEmailMetricsCalculating(payload);
        const suggestedDelay = Number(payload.retry_after_seconds) * 1000;
        if (overviewEmailMetricsTimer !== null) {
          window.clearTimeout(overviewEmailMetricsTimer);
          overviewEmailMetricsTimer = null;
        }
        scheduleOverviewEmailMetrics(Number.isFinite(suggestedDelay)
          ? Math.max(2_000, Math.min(3_000, suggestedDelay))
          : EMAIL_METRICS_REFRESHING_RETRY_MS);
        return;
      }
      renderEmailMetrics(payload);
    } catch (error) {
      showEmailMetricsUnavailable();
      console.warn(error);
    } finally {
      emailMetricsInFlight = false;
    }
  }

  function summaryCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
  }

  function summaryWindowLabel(value) {
    const minutes = summaryCount(value) || 15;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }

  function renderRankedSummary(element, items, order, emptyText) {
    const validItems = (Array.isArray(items) ? items : []).map(item => {
      const name = String(item && item.name || '').trim();
      const count = summaryCount(item && item.count);
      if (!name || count === 0) return null;
      return { name, count };
    }).filter(Boolean);
    element.replaceChildren();
    if (!validItems.length) {
      element.textContent = emptyText;
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of validItems) {
      const entry = document.createElement('span');
      const count = document.createElement('strong');
      count.textContent = item.count.toLocaleString();
      if (order === 'name-first') {
        entry.append(document.createTextNode(`${item.name}\u00a0`), count);
      } else {
        entry.append(count, document.createTextNode(`\u00a0${item.name}`));
      }
      fragment.append(entry);
    }
    element.append(fragment);
  }

  function currentComparison(summary) {
    const current = summaryCount(summary.current && summary.current.requests);
    const previous = summaryCount(summary.previous && summary.previous.requests);
    const minutes = summaryCount(summary.window_minutes) || 15;
    const priorWindow = `prior ${minutes} min`;
    const difference = current - previous;
    if (difference === 0) return `No change vs ${priorWindow} · ${previous.toLocaleString()}`;
    if (previous === 0) return `Up from 0 in ${priorWindow}`;
    const providedPercent = Number(summary.change && summary.change.percent);
    const percent = Number.isFinite(providedPercent)
      ? Math.abs(providedPercent)
      : Math.abs((difference / previous) * 100);
    const formattedPercent = percent.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return `${difference > 0 ? 'Up' : 'Down'} ${formattedPercent}% vs ${priorWindow} · ${previous.toLocaleString()}`;
  }

  function categoryLongTail(distribution) {
    const otherRequests = summaryCount(distribution && distribution.other && distribution.other.requests);
    const otherTypes = summaryCount(distribution && distribution.other && distribution.other.categories);
    const unknown = summaryCount(distribution && distribution.unknown);
    const parts = [];
    if (otherRequests) {
      parts.push(`${otherRequests.toLocaleString()} more across ${otherTypes.toLocaleString()} other request ${otherTypes === 1 ? 'type' : 'types'}`);
    }
    if (unknown) parts.push(`${unknown.toLocaleString()} uncategorized`);
    return parts.join(' · ');
  }

  function boroughRemainder(distribution) {
    const otherRequests = summaryCount(distribution && distribution.other && distribution.other.requests);
    const otherBoroughs = summaryCount(distribution && distribution.other && distribution.other.categories);
    const unknown = summaryCount(distribution && distribution.unknown);
    const parts = [];
    if (otherRequests) {
      parts.push(`${otherRequests.toLocaleString()} more across ${otherBoroughs.toLocaleString()} other ${otherBoroughs === 1 ? 'borough' : 'boroughs'}`);
    }
    if (unknown) parts.push(`${unknown.toLocaleString()} unknown location`);
    return parts.join(' · ');
  }

  function coverageSummary(summary) {
    const total = summaryCount(summary.current && summary.current.requests);
    const detailsLoaded = summaryCount(summary.coverage && summary.coverage.details && summary.coverage.details.loaded);
    const mapped = summaryCount(summary.coverage && summary.coverage.map && summary.coverage.map.mapped);
    return `Live map feed · provisional · details ${detailsLoaded.toLocaleString()}/${total.toLocaleString()} · pins ${mapped.toLocaleString()}/${total.toLocaleString()}`;
  }

  function historySummary(summary) {
    const minutes = summaryCount(summary.window_minutes) || 15;
    const delayedRequests = summaryCount(summary.delayed && summary.delayed.requests);
    const spanDays = summaryCount(summary.history && summary.history.span_days);
    const targetDays = summaryCount(summary.history && summary.history.target_days);
    const history = summary.history && summary.history.target_reached
      ? `archive ${spanDays.toLocaleString()} days`
      : `archive ${spanDays.toLocaleString()}/${targetDays.toLocaleString()} days`;
    return `Delayed map + audit · ${delayedRequests.toLocaleString()} requests / ${minutes}m · ${history}`;
  }

  function durationSummary(totalSeconds) {
    const seconds = summaryCount(totalSeconds);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  function summaryWarnings(summary) {
    const warnings = [];
    const captureState = String(summary.capture && summary.capture.state || 'starting');
    if (captureState === 'stale') {
      warnings.push(`Collector last updated ${durationSummary(summary.capture.poll_age_seconds)} ago; this is the last captured window.`);
    } else if (captureState === 'invalid') {
      warnings.push('Collector timing is invalid; current-window statistics are unavailable.');
    } else if (captureState === 'starting') {
      warnings.push('Collector is starting; current-window statistics may be empty.');
    }
    const excluded = summaryCount(summary.data_quality && summary.data_quality.excluded_from_time_statistics);
    if (excluded) {
      const archiveTotal = summaryCount(summary.data_quality && summary.data_quality.archive_requests);
      const coverage = archiveTotal
        ? ((Math.max(0, archiveTotal - excluded) / archiveTotal) * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })
        : null;
      warnings.push(`${coverage ? `Time-window coverage ${coverage}% · ` : ''}${excluded.toLocaleString()} ${excluded === 1 ? 'record lacks' : 'records lack'} a usable submitted time.`);
    }
    return warnings.join(' ');
  }

  function validSummary(summary) {
    return Boolean(summary && typeof summary === 'object'
      && summary.current && summary.previous && summary.categories && summary.boroughs
      && summary.coverage && summary.delayed && summary.history
      && summary.capture && summary.data_quality);
  }

  function showSummaryUnavailable(message = null) {
    if (!hasSummaryElements) return;
    summaryElements.root.setAttribute('aria-busy', 'false');
    summaryElements.loading.hidden = true;
    if (lastGoodSummary) {
      summaryElements.content.hidden = false;
      summaryElements.status.textContent = 'Summary refresh delayed. Showing the last successful summary refresh.';
      return;
    }
    summaryElements.content.hidden = true;
    summaryElements.updated.textContent = message ? 'Fast live mode' : 'Unavailable';
    summaryElements.status.textContent = message
      || 'Live summary temporarily unavailable. Incoming requests are still updating.';
  }

  function renderCitySummary(summary) {
    if (!hasSummaryElements) return false;
    try {
      if (!validSummary(summary)) {
        showSummaryUnavailable();
        return false;
      }
      const currentRequests = summaryCount(summary.current.requests);
      const asOf = portalDate(summary.as_of);
      const captureState = String(summary.capture.state || 'starting');

      const selectedPrecinct = precinctFilter.value;
      const selectedBid = bidFilter.value && bidById.get(String(bidFilter.value));
      const scopeLabels = [
        selectedBid && selectedBid.name,
        selectedPrecinct && precinctLabel(selectedPrecinct)
      ].filter(Boolean);
      summaryElements.eyebrow.textContent = scopeLabels.length
        ? `${scopeLabels.join(' · ')} ${captureState === 'fresh' ? 'right now' : 'last captured'}`
        : captureState === 'fresh' ? 'NYC right now' : 'Last captured window';
      summaryElements.title.textContent = `Last ${summaryWindowLabel(summary.window_minutes)}`;
      summaryElements.updated.textContent = asOf && !Number.isNaN(asOf.getTime())
        ? `As of ${timeLabel(summary.as_of)}`
        : 'Current window';
      summaryElements.requestCount.textContent = currentRequests.toLocaleString();
      summaryElements.comparison.textContent = currentComparison(summary);
      renderRankedSummary(
        summaryElements.categories,
        summary.categories.top,
        'count-first',
        'No published request types in this window'
      );
      summaryElements.otherCategories.textContent = categoryLongTail(summary.categories);
      renderRankedSummary(
        summaryElements.boroughs,
        summary.boroughs.top,
        'name-first',
        'No published locations in this window'
      );
      summaryElements.otherBoroughs.textContent = boroughRemainder(summary.boroughs);
      summaryElements.coverage.textContent = coverageSummary(summary);
      summaryElements.history.textContent = historySummary(summary);
      summaryElements.status.textContent = summaryWarnings(summary);
      summaryElements.loading.hidden = true;
      summaryElements.content.hidden = false;
      summaryElements.root.setAttribute('aria-busy', 'false');
      lastGoodSummary = summary;
      return true;
    } catch (error) {
      console.warn('Could not render live summary:', error);
      showSummaryUnavailable();
      return false;
    }
  }

  async function refreshMap(dashboardStats, force = false) {
    if (!mapHasLayout()) return;
    const now = Date.now();
    if (force) {
      if (mapAbortController) mapAbortController.abort();
      mapRequestSequence += 1;
      mapRefreshInFlight = false;
      lastMapRefreshStartedAt = 0;
    }
    if (mapRefreshInFlight || now - lastMapRefreshStartedAt < MAP_REFRESH_MS) return;
    mapRefreshInFlight = true;
    lastMapRefreshStartedAt = now;
    const sequence = ++mapRequestSequence;
    const submittedSince = mapSubmittedSince(now);
    let recordsLoadedForRequest = 0;
    setMapLoadState('loading', mapArchiveLoaded ? 'Refreshing map records…' : 'Loading map records…');
    try {
      let beforeSuffix = null;
      let pagesLoaded = 0;
      let hasMore = true;
      while (hasMore && pagesLoaded < 500) {
        const controller = new AbortController();
        mapAbortController = controller;
        const timeout = window.setTimeout(() => controller.abort(), MAP_REQUEST_TIMEOUT_MS);
        let payload;
        const pageLimit = pagesLoaded === 0 ? MAP_INITIAL_PAGE_SIZE : MAP_PAGE_SIZE;
        try {
          payload = await fetchJson(scopedUrl('/api/live-map', {
            limit: pageLimit,
            include_totals: 0,
            ...(submittedSince != null ? { submitted_since: submittedSince } : {}),
            ...(beforeSuffix != null ? { before_suffix: beforeSuffix } : {})
          }), 'Map service', {
            signal: controller.signal
          });
        } finally {
          window.clearTimeout(timeout);
        }
        if (sequence !== mapRequestSequence) return;
        updateMapRecords(payload, dashboardStats);
        recordsLoadedForRequest += Array.isArray(payload && payload.records)
          ? payload.records.length
          : 0;
        pagesLoaded += 1;
        // Let the first, deliberately small page paint before fetching the
        // remainder of a large archive.
        if (pagesLoaded === 1) {
          await new Promise(resolve => window.requestAnimationFrame(resolve));
          if (sequence !== mapRequestSequence) return;
        }

        const page = payload && payload.page;
        const nextSuffix = Number(page && page.next_before_suffix);
        hasMore = Boolean(page && page.has_more);
        if (hasMore && (!Number.isSafeInteger(nextSuffix) || nextSuffix < 1
            || (beforeSuffix != null && nextSuffix >= beforeSuffix))) {
          throw new Error('Map service returned an invalid page cursor');
        }
        beforeSuffix = hasMore ? nextSuffix : null;
        if (hasMore) {
          setMapLoadState(
            'loading',
            `Loading ${mapScopeLabel().toLowerCase()}… ${recordsLoadedForRequest.toLocaleString()} pins`
          );
        }
      }
      if (hasMore) throw new Error('Map service returned too many pages');
      mapArchiveLoaded = true;
      clearMapRetry();
      setMapLoadState('ready');
    } catch (error) {
      if (sequence === mapRequestSequence) {
        const message = error.name === 'AbortError'
          ? 'Map data took too long. Retrying…'
          : 'Map data is temporarily unavailable. Retrying…';
        setMapLoadState('error', message);
        scheduleMapRetry();
        console.warn(error);
      }
    } finally {
      if (sequence === mapRequestSequence) {
        mapRefreshInFlight = false;
        mapAbortController = null;
      }
    }
  }

  async function refresh({ force = false } = {}) {
    if (refreshInFlight && !force) return;
    if (force && dashboardAbortController) dashboardAbortController.abort();
    const controller = new AbortController();
    dashboardAbortController = controller;
    const sequence = ++dashboardRequestSequence;
    refreshInFlight = true;
    const timeout = window.setTimeout(() => controller.abort(), DASHBOARD_REQUEST_TIMEOUT_MS);
    try {
      const requestLimit = dashboardPayloadLoaded
        ? MAX_VISIBLE_RECORDS
        : INITIAL_VISIBLE_RECORDS;
      const data = await fetchJson(scopedUrl('/api/live-dashboard', {
        limit: requestLimit,
        compact: 1
      }), 'Data service', {
        signal: controller.signal
      });
      if (sequence !== dashboardRequestSequence) return;
      const stats = data.stats || {};
      const firstDashboardPayload = !dashboardPayloadLoaded;
      dashboardPayloadLoaded = true;
      updateFeedRecords(data.records || []);
      if (firstDashboardPayload && records.length === 0) renderFeed();
      const exact = exactSrnumberQuery();
      if (exact) {
        const archiveSequence = ++archiveSearchSequence;
        archiveSearchState = archiveSearchRecord ? 'found' : 'loading';
        loadArchivedRequest(exact, archiveSequence);
      }
      updateMapStatsFromDashboard(stats);
      refreshMap(stats, force);
      currentPollSeconds = Number(stats.poll_interval_seconds || 15);
      pollInterval.value = String(currentPollSeconds);
      lastPortalCheck = stats.last_seen_at ? new Date(stats.last_seen_at) : null;
      lastDashboardStats = stats;
      renderOverviewStats(stats);
      renderStatusClarity(stats);
      renderLegacyReconciliation(stats.legacy_reconciliation);
      if (stats.compact && !stats.summary) {
        showSummaryUnavailable(
          'Citywide archive statistics are paused on the live path so requests and the map load immediately.'
        );
      } else {
        renderCitySummary(stats.summary);
      }
      document.getElementById('frontier-number').textContent = stats.frontier ? `311-${String(stats.frontier).padStart(8, '0')}` : '—';
      document.getElementById('last-updated').textContent = lastPortalCheck
        ? `Portal ${lastPortalCheck.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
        : 'Waiting for data';
      connection.classList.remove('offline');
      updateConnectionLabel();
      if (selectedNumber) {
        const selectedRecord = findRecord(selectedNumber);
        loadEmailUpdates(selectedRecord);
        loadStatusHistory(selectedRecord);
      }
    } catch (error) {
      if (sequence !== dashboardRequestSequence) return;
      showSummaryUnavailable();
      connection.classList.add('offline');
      connectionLabel.textContent = 'Reconnecting…';
      if (error.name !== 'AbortError') console.warn(error);
    } finally {
      window.clearTimeout(timeout);
      if (sequence === dashboardRequestSequence) {
        refreshInFlight = false;
        dashboardAbortController = null;
      }
    }
  }

  function nextDashboardRefreshDelay(now = Date.now()) {
    const intervalMs = Math.max(DASHBOARD_MIN_REFRESH_MS, currentPollSeconds * 1000);
    if (!lastPortalCheck || Number.isNaN(lastPortalCheck.getTime())) return intervalMs;
    const expectedNextPortalCheck = lastPortalCheck.getTime() + intervalMs + 750;
    return Math.max(DASHBOARD_MIN_REFRESH_MS, expectedNextPortalCheck - now);
  }

  function clearDashboardRefreshTimer() {
    if (dashboardRefreshTimer !== null) {
      window.clearTimeout(dashboardRefreshTimer);
      dashboardRefreshTimer = null;
    }
  }

  function scheduleDashboardRefresh(delayMs = nextDashboardRefreshDelay()) {
    clearDashboardRefreshTimer();
    dashboardRefreshTimer = window.setTimeout(async () => {
      await refresh();
      scheduleDashboardRefresh();
    }, Math.max(500, delayMs));
  }

  async function refreshNowAndReschedule(options = {}) {
    clearDashboardRefreshTimer();
    await refresh(options);
    scheduleDashboardRefresh();
  }

  function openRequestFromFeed(number) {
    if (compactLayout.matches && setMobileView('map')) {
      window.requestAnimationFrame(() => selectRequest(number));
    } else {
      selectRequest(number);
    }
  }

  feed.addEventListener('click', event => {
    const card = event.target.closest('.request-card');
    if (!card) return;
    openRequestFromFeed(card.dataset.number);
  });
  mobileViewTabs.addEventListener('click', event => {
    const button = event.target.closest('button[data-mobile-view]');
    if (button) setMobileView(button.dataset.mobileView);
  });
  search.addEventListener('input', () => {
    const scopeChanged = showAllDatesForActiveFilters();
    scheduleArchiveSearch();
    if (scopeChanged) refreshMap(mapStats, true);
  });
  statusFilter.addEventListener('change', () => {
    const scopeChanged = showAllDatesForActiveFilters();
    updateActiveFilterState();
    renderFeed({ resetScroll: true });
    renderMap();
    if (scopeChanged) refreshMap(mapStats, true);
  });
  function handleGeographyFilterChange() {
    showAllDatesForActiveFilters();
    mapArchiveLoaded = false;
    lastGoodSummary = null;
    highestObservedSuffix = null;
    detailLoadSequence += 1;
    emailUpdatesLoadSequence += 1;
    statusHistoryLoadSequence += 1;
    if (emailUpdatesAbortController) emailUpdatesAbortController.abort();
    if (statusHistoryAbortController) statusHistoryAbortController.abort();
    emailUpdatesAbortController = null;
    emailUpdatesInFlightFor = null;
    statusHistoryAbortController = null;
    statusHistoryInFlightFor = null;
    clearStatusUpdatesPanel({ resetDisclosure: true });
    archiveSearchSequence += 1;
    archiveSearchRecord = null;
    archiveSearchState = 'idle';
    if (archiveSearchTimer !== null) {
      window.clearTimeout(archiveSearchTimer);
      archiveSearchTimer = null;
    }
    const previousNumber = selectedNumber;
    selectedNumber = null;
    updateSelectedFeedCard(previousNumber, null);
    setDetailPanelVisible(false);
    updateActiveFilterState();
    renderFeed({ resetScroll: true });
    renderMap();
    syncSelectedBoundaries();
    refreshNowAndReschedule({ force: true });
    scheduleArchiveSearch();
  }
  precinctFilter.addEventListener('change', handleGeographyFilterChange);
  bidFilter.addEventListener('change', handleGeographyFilterChange);
  mapScopeControl.addEventListener('click', event => {
    const button = event.target.closest('button[data-map-scope]');
    if (!button || !mapScopeControl.contains(button)) return;
    if (button.dataset.mapScope === mapScope) return;
    setMapScope(button.dataset.mapScope);
    renderMap();
    refreshMap(mapStats, true);
  });
  pollInterval.addEventListener('change', async () => {
    pollInterval.disabled = true;
    try {
      const response = await fetch('/api/live-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poll_interval_seconds: Number(pollInterval.value) })
      });
      if (!response.ok) throw new Error(`Could not change interval (${response.status})`);
      currentPollSeconds = Number(pollInterval.value);
    } catch (error) {
      console.warn(error);
    } finally {
      pollInterval.disabled = false;
      refreshNowAndReschedule();
    }
  });
  const detailClose = document.getElementById('detail-close');
  detailClose.addEventListener('click', () => {
    detailLoadSequence += 1;
    emailUpdatesLoadSequence += 1;
    statusHistoryLoadSequence += 1;
    if (emailUpdatesAbortController) emailUpdatesAbortController.abort();
    if (statusHistoryAbortController) statusHistoryAbortController.abort();
    emailUpdatesAbortController = null;
    emailUpdatesInFlightFor = null;
    statusHistoryAbortController = null;
    statusHistoryInFlightFor = null;
    clearStatusUpdatesPanel({ resetDisclosure: true });
    const closedNumber = selectedNumber;
    selectedNumber = null;
    setDetailPanelVisible(false);
    updateSelectedFeedCard(closedNumber, null);
    const returnTarget = compactLayout.matches && viewTabsVisible()
      ? mobileViewTabs.querySelector('button[aria-pressed="true"]')
      : [...feed.querySelectorAll('.request-card')]
        .find(card => card.dataset.number === closedNumber);
    if (returnTarget) returnTarget.focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selectedNumber && !detail.classList.contains('hidden')) {
      event.preventDefault();
      detailClose.click();
    }
  });

  compactLayout.addEventListener('change', event => {
    if (!event.matches && appShell.dataset.mobileView === 'map') {
      appShell.dataset.mobileView = 'feed';
      setPressedView('feed');
    }
    scheduleMapLayout({ attemptBoundaryFit: true });
  });

  loadPolicePrecincts();
  loadBusinessImprovementDistricts();
  updateActiveFilterState();
  refreshNowAndReschedule();
  window.setInterval(() => {
    const now = new Date();
    document.getElementById('nyc-clock').textContent = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit'
    }).format(now);
    updateConnectionLabel(now);
    if (lastPortalCheck) {
      const next = new Date(lastPortalCheck.getTime() + currentPollSeconds * 1000);
      const remaining = Math.max(0, Math.ceil((next.getTime() - now.getTime()) / 1000));
      document.getElementById('next-check').textContent = remaining > 0
        ? `NYC · Next check in ${remaining}s`
        : 'NYC · Checking now…';
    }
  }, 1000);
})();
