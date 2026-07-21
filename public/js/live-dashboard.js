(() => {
  const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([40.7128, -74.0060], 11);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap &copy; CARTO'
  }).addTo(map);
  const markerLayer = L.markerClusterGroup({
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
  const connection = document.querySelector('.live-state');
  const connectionLabel = document.getElementById('connection-label');
  const pollInterval = document.getElementById('poll-interval');
  const detail = document.getElementById('request-detail');
  const mapScopeControl = document.getElementById('map-scope');
  const mapCounts = document.getElementById('map-counts');
  const detailPendingBadge = document.getElementById('detail-pending-badge');
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
    coverage: document.getElementById('summary-coverage'),
    history: document.getElementById('summary-history-note'),
    status: document.getElementById('city-summary-status')
  };
  const hasSummaryElements = Object.values(summaryElements).every(Boolean);
  const MAX_VISIBLE_RECORDS = 750;
  const MAP_REFRESH_MS = 15_000;
  let records = [];
  let mapRecords = [];
  let feedByNumber = new Map();
  let mapByNumber = new Map();
  let selectedNumber = null;
  let markerByNumber = new Map();
  let markerSignatureByNumber = new Map();
  let mapScope = 'all';
  let mapStats = { total: 0, mapped_total: 0, unmapped_total: 0 };
  let mapShownCount = 0;
  let mapRenderFrame = null;
  let refreshInFlight = false;
  let mapRefreshInFlight = false;
  let mapRequestSequence = 0;
  let lastMapRefreshStartedAt = 0;
  let currentPollSeconds = 15;
  let lastPortalCheck = null;
  let portalDetailByNumber = new Map();
  let detailLoadSequence = 0;
  let highestObservedSuffix = null;
  let arrivingNumbers = new Set();
  let lastGoodSummary = null;

  const esc = value => String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const isClosed = status => /\b(?:closed|resolved|cancel(?:led|ed)?)\b/i.test(status || '');
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

  function setMobileView(view) {
    if (!['feed', 'map', 'overview'].includes(view)) return;
    appShell.dataset.mobileView = view;
    mobileViewTabs.querySelectorAll('button[data-mobile-view]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.mobileView === view));
    });
    if (view === 'map') {
      window.requestAnimationFrame(() => {
        map.invalidateSize();
        renderMap();
      });
    }
  }

  const submittedMillis = record => {
    const date = portalDate(record && record.submitted_at);
    return date && !Number.isNaN(date.getTime()) ? date.getTime() : null;
  };
  const suffixOf = record => Number(String(record && record.srnumber || '').replace(/^311-/, '')) || 0;
  const recordSignature = record => JSON.stringify([
    record.srnumber, record.status, record.problem, record.address,
    record.latitude, record.longitude, record.submitted_at, record.portal_url,
    record.problem_details, record.additional_details, record.next_update,
    record.date_reported, record.updated_on, record.date_closed, record.details_fetched_at,
    record.followup_state, record.next_check_at, record.closure_cycle, record.finalized_at,
    record.public_details_state, record.has_map_pin,
    record.missing_public_fields, record.missing_important_fields,
    record.current_cycle_final_state, record.closure_cycle_tracking
  ]);
  function coordinateNumber(value) {
    if (value == null || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function recordCoordinates(record) {
    const lat = coordinateNumber(record && record.latitude);
    const lng = coordinateNumber(record && record.longitude);
    return lat != null && lng != null ? { lat, lng } : null;
  }

  function recordHasMapPin(record) {
    return typeof (record && record.has_map_pin) === 'boolean'
      ? record.has_map_pin
      : Boolean(recordCoordinates(record));
  }

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
    return feedByNumber.get(number) || mapByNumber.get(number) || null;
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
    const status = statusFilter.value;
    if (status && record.status !== status) return false;
    if (!query) return true;
    return [record.srnumber, record.problem, record.problem_details,
      record.additional_details, record.address, record.status,
      ...missingFieldLabels(record.missing_public_fields)]
      .some(value => String(value || '').toLowerCase().includes(query));
  }

  function filteredRecords() {
    return records.filter(matchesFilters);
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

  function renderFeed({ resetScroll = false } = {}) {
    const scrollSnapshot = resetScroll ? null : captureFeedScroll();
    const visible = filteredRecords();
    if (!visible.length) {
      feed.innerHTML = '<div class="empty-state"><p>No requests match the current filters.</p></div>';
      feed.scrollTop = 0;
      return;
    }
    let arrivalIndex = 0;
    feed.innerHTML = visible.map(record => {
      const hasMapPin = recordHasMapPin(record);
      const unavailableBadge = missingBadge(record);
      const arriving = arrivingNumbers.has(record.srnumber);
      const arrivalStyle = arriving ? ` style="--arrival-index:${Math.min(arrivalIndex++, 8)}"` : '';
      const headline = record.problem_details
        ? `${record.problem || 'Service Request'}: ${record.problem_details}`
        : record.problem || 'Service Request';
      return `<article class="request-card${selectedNumber === record.srnumber ? ' selected' : ''}${arriving ? ' arriving' : ''}"${arrivalStyle} data-number="${esc(record.srnumber)}" tabindex="0">
        <span class="request-dot${isClosed(record.status) ? ' closed' : ''}"></span>
        <div class="request-copy">
          <div class="request-topline"><strong>${esc(headline)}</strong><time>${esc(timeLabel(record.submitted_at))}</time></div>
          <p>${esc(record.address || 'Location unavailable')}</p>
          <div class="request-meta"><span>${esc(record.srnumber)}</span><span>•</span><span>${esc(record.status || 'Unknown')}</span>${unavailableBadge}${!hasMapPin ? '<span class="unmapped-label">NO MAP PIN</span>' : ''}</div>
        </div>
      </article>`;
    }).join('');
    const animatedCards = [...feed.querySelectorAll('.request-card.arriving')];
    if (animatedCards.length) {
      window.setTimeout(() => animatedCards.forEach(card => card.classList.remove('arriving')), 1300);
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
    const captured = Number.isFinite(Number(mapStats.total)) ? Number(mapStats.total) : 0;
    const unmapped = Number.isFinite(Number(mapStats.unmapped_total))
      ? Number(mapStats.unmapped_total)
      : Math.max(0, captured - mapRecords.length);
    const label = `${mapShownCount.toLocaleString()} shown · ${unmapped.toLocaleString()} without stored Portal coordinates · ${captured.toLocaleString()} captured`;
    if (mapCounts.textContent !== label) mapCounts.textContent = label;
  }

  function renderMapNow() {
    mapRenderFrame = null;
    const desired = new Map();
    const now = Date.now();
    for (const mapRecord of mapRecords) {
      const record = feedByNumber.get(mapRecord.srnumber) || mapRecord;
      const coordinates = recordCoordinates(record);
      if (!coordinates || !matchesFilters(record) || !matchesMapScope(record, now)) continue;
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
    document.getElementById('detail-link').href = record.portal_url || '#';
    detailPendingBadge.classList.toggle('hidden', record.public_details_state !== 'pending');
    const archiveRow = document.getElementById('detail-archive-row');
    const archiveValue = document.getElementById('detail-archive');
    let archiveLabel = '';
    if (record.followup_state === 'closing') {
      archiveLabel = 'Verifying final details';
    } else if (record.followup_state === 'closed') {
      archiveLabel = record.finalized_at
        ? `Final snapshot saved ${fullTimeLabel(record.finalized_at)}`
        : 'Final snapshot saved';
    } else if (record.followup_state === 'open') {
      archiveLabel = record.next_check_at
        ? `Monitoring · next ${fullTimeLabel(record.next_check_at)}`
        : 'Monitoring';
    }
    archiveValue.textContent = archiveLabel;
    archiveRow.classList.toggle('hidden', !archiveLabel);
    renderCoreDataWarning(record);
    const savedDetail = portalDetailByNumber.get(record.srnumber) || (record.details_fetched_at ? {
      problemDetails: record.problem_details,
      additionalDetails: record.additional_details,
      nextUpdate: record.next_update,
      dateReported: record.date_reported,
      updatedOn: record.updated_on,
      dateClosed: record.date_closed
    } : null);
    if (savedDetail) renderSubmittedDetails(savedDetail);
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

  function renderSubmittedDetails(detailData, state = 'ready') {
    const problemDetails = document.getElementById('detail-problem-details');
    const additionalDetails = document.getElementById('detail-additional-details');
    const updatedRow = document.getElementById('detail-updated-row');
    const closedRow = document.getElementById('detail-closed-row');
    const nextUpdateRow = document.getElementById('detail-next-update-row');
    if (state === 'loading') {
      problemDetails.textContent = 'Loading from NYC311…';
      additionalDetails.textContent = '';
      updatedRow.classList.add('hidden');
      closedRow.classList.add('hidden');
      nextUpdateRow.classList.add('hidden');
      return;
    }
    if (state === 'error') {
      problemDetails.textContent = 'Details are temporarily unavailable';
      additionalDetails.textContent = 'The request summary is still saved locally.';
      updatedRow.classList.add('hidden');
      closedRow.classList.add('hidden');
      nextUpdateRow.classList.add('hidden');
      return;
    }
    problemDetails.textContent = detailData.problemDetails || 'No additional public details were submitted.';
    const extraDetails = /^(?:N\/?A|NONE|NOT PROVIDED)$/i.test(String(detailData.additionalDetails || '').trim())
      ? ''
      : detailData.additionalDetails || '';
    additionalDetails.textContent = extraDetails;
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

  async function loadPortalDetails(record) {
    const sequence = ++detailLoadSequence;
    const cached = portalDetailByNumber.get(record.srnumber);
    if (cached) {
      renderSubmittedDetails(cached);
      return;
    }
    if (record.details_fetched_at) {
      const saved = {
        problemDetails: record.problem_details,
        additionalDetails: record.additional_details,
        nextUpdate: record.next_update,
        dateReported: record.date_reported,
        updatedOn: record.updated_on,
        dateClosed: record.date_closed
      };
      portalDetailByNumber.set(record.srnumber, saved);
      renderSubmittedDetails(saved);
      return;
    }
    const portalId = portalIdFor(record);
    if (!portalId) {
      renderSubmittedDetails(null, 'error');
      return;
    }
    renderSubmittedDetails(null, 'loading');
    try {
      const response = await fetch(`/api/portal-detail?id=${encodeURIComponent(portalId)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Detail service returned ${response.status}`);
      const portalDetail = await response.json();
      portalDetailByNumber.set(record.srnumber, portalDetail);
      if (sequence === detailLoadSequence && selectedNumber === record.srnumber) {
        detailPendingBadge.classList.add('hidden');
        renderSubmittedDetails(portalDetail);
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
    selectedNumber = number;
    renderDetail(record);
    detail.classList.remove('hidden');
    renderFeed();
    loadPortalDetails(record);
    const coordinates = recordCoordinates(record);
    if (moveMap && coordinates) {
      map.flyTo([coordinates.lat, coordinates.lng], Math.max(map.getZoom(), 15), { duration: .6 });
      const marker = markerByNumber.get(number);
      if (marker) markerLayer.zoomToShowLayer(marker);
    }
  }

  function syncStatuses() {
    const current = statusFilter.value;
    const statuses = [...new Set(
      [...records, ...mapRecords].map(record => record.status).filter(Boolean)
    )].sort();
    statusFilter.innerHTML = '<option value="">All statuses</option>' + statuses.map(status => `<option value="${esc(status)}">${esc(status)}</option>`).join('');
    if (statuses.includes(current)) statusFilter.value = current;
  }

  function updateConnectionLabel() {
    if (connection.classList.contains('offline')) return;
    connectionLabel.textContent = 'Live monitoring active';
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
    }

    const changed = !recordsMatch(nextRecords, records);
    records = nextRecords;
    feedByNumber = new Map(records.map(record => [record.srnumber, record]));
    if (!changed) return;
    syncStatuses();
    renderFeed();
    renderMap();
    if (selectedNumber) renderDetail(findRecord(selectedNumber));
  }

  function finiteStat(value, fallback = 0) {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function updateMapRecords(payload, dashboardStats) {
    const incoming = Array.isArray(payload) ? payload : payload.records || [];
    const stats = Array.isArray(payload) ? {} : payload.stats || {};
    mapRecords = incoming.filter(record => record && record.srnumber && recordCoordinates(record));
    mapByNumber = new Map(mapRecords.map(record => [record.srnumber, record]));
    const total = finiteStat(stats.total, finiteStat(dashboardStats.total, mapRecords.length));
    const mapped = finiteStat(stats.mapped_total, mapRecords.length);
    mapStats = {
      total,
      mapped_total: mapped,
      unmapped_total: finiteStat(
        stats.unmapped_total,
        finiteStat(dashboardStats.unmapped_total, Math.max(0, total - mapped))
      )
    };
    syncStatuses();
    renderMap();
    if (selectedNumber && !feedByNumber.has(selectedNumber)) renderDetail(findRecord(selectedNumber));
  }

  async function fetchJson(url, label) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${label} returned ${response.status}`);
    return response.json();
  }

  function updateMapStatsFromDashboard(stats) {
    mapStats = {
      ...mapStats,
      total: finiteStat(stats.total, mapStats.total),
      unmapped_total: finiteStat(stats.unmapped_total, mapStats.unmapped_total)
    };
    updateMapCountText();
  }

  function percentage(part, total) {
    if (!Number.isFinite(total) || total <= 0) return '—';
    return `${Math.round(Math.max(0, Math.min(1, part / total)) * 100)}%`;
  }

  function renderOverviewStats(stats) {
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
    document.getElementById('monitored-count').textContent = finiteStat(stats.open_followups_scheduled).toLocaleString();
    document.getElementById('pending-count').textContent = finiteStat(stats.pending).toLocaleString();
    document.getElementById('closures-count').textContent = finiteStat(stats.closures_finalized).toLocaleString();
    document.getElementById('closures-note').textContent = `${closing.toLocaleString()} ${closing === 1 ? 'check' : 'checks'} in progress`;
  }

  function summaryCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
  }

  function summaryWindowLabel(value) {
    const minutes = summaryCount(value) || 15;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }

  function rankedSummary(items, order) {
    if (!Array.isArray(items)) return '';
    return items.map(item => {
      const name = String(item && item.name || '').trim();
      const count = summaryCount(item && item.count);
      if (!name || count === 0) return null;
      return order === 'name-first'
        ? `${name} ${count.toLocaleString()}`
        : `${count.toLocaleString()} ${name}`;
    }).filter(Boolean).join(' · ');
  }

  function currentComparison(summary) {
    const current = summaryCount(summary.current && summary.current.requests);
    const previous = summaryCount(summary.previous && summary.previous.requests);
    const minutes = summaryCount(summary.window_minutes) || 15;
    const priorWindow = `previous ${minutes} min`;
    const difference = current - previous;
    if (difference === 0) return `Same as ${priorWindow} (${previous.toLocaleString()})`;
    if (previous === 0) return `${difference.toLocaleString()} more than ${priorWindow} (0)`;
    const providedPercent = Number(summary.change && summary.change.percent);
    const percent = Number.isFinite(providedPercent)
      ? Math.abs(providedPercent)
      : Math.abs((difference / previous) * 100);
    const formattedPercent = percent.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return `${formattedPercent}% ${difference > 0 ? 'above' : 'below'} ${priorWindow} (${previous.toLocaleString()})`;
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

  function boroughSummary(distribution) {
    const leading = rankedSummary(distribution && distribution.top, 'name-first');
    const otherRequests = summaryCount(distribution && distribution.other && distribution.other.requests);
    const otherBoroughs = summaryCount(distribution && distribution.other && distribution.other.categories);
    const unknown = summaryCount(distribution && distribution.unknown);
    const parts = leading ? [leading] : [];
    if (otherRequests) {
      parts.push(`${otherRequests.toLocaleString()} more across ${otherBoroughs.toLocaleString()} other ${otherBoroughs === 1 ? 'borough' : 'boroughs'}`);
    }
    if (unknown) parts.push(`${unknown.toLocaleString()} unknown location`);
    return parts.join(' · ') || 'No published locations in this window';
  }

  function coverageSummary(summary) {
    const total = summaryCount(summary.current && summary.current.requests);
    const detailsLoaded = summaryCount(summary.coverage && summary.coverage.details && summary.coverage.details.loaded);
    const mapped = summaryCount(summary.coverage && summary.coverage.map && summary.coverage.map.mapped);
    return `Provisional map feed · ${detailsLoaded.toLocaleString()}/${total.toLocaleString()} details · ${mapped.toLocaleString()}/${total.toLocaleString()} pins`;
  }

  function historySummary(summary) {
    const minutes = summaryCount(summary.window_minutes) || 15;
    const delayedRequests = summaryCount(summary.delayed && summary.delayed.requests);
    const spanDays = summaryCount(summary.history && summary.history.span_days);
    const targetDays = summaryCount(summary.history && summary.history.target_days);
    const history = summary.history && summary.history.target_reached
      ? `${spanDays.toLocaleString()}d archive span`
      : `${spanDays.toLocaleString()}/${targetDays.toLocaleString()}d archive span`;
    return `Map + number audit ${minutes}m (delayed): ${delayedRequests.toLocaleString()} · ${history}`;
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
      warnings.push(`${excluded.toLocaleString()} archived ${excluded === 1 ? 'request lacks' : 'requests lack'} a usable submitted time and ${excluded === 1 ? 'is' : 'are'} excluded from time windows.`);
    }
    return warnings.join(' ');
  }

  function validSummary(summary) {
    return Boolean(summary && typeof summary === 'object'
      && summary.current && summary.previous && summary.categories && summary.boroughs
      && summary.coverage && summary.delayed && summary.history
      && summary.capture && summary.data_quality);
  }

  function showSummaryUnavailable() {
    if (!hasSummaryElements) return;
    summaryElements.root.setAttribute('aria-busy', 'false');
    summaryElements.loading.hidden = true;
    if (lastGoodSummary) {
      summaryElements.content.hidden = false;
      summaryElements.status.textContent = 'Summary refresh delayed. Showing the last successful summary refresh.';
      return;
    }
    summaryElements.content.hidden = true;
    summaryElements.updated.textContent = 'Unavailable';
    summaryElements.status.textContent = 'Live summary temporarily unavailable. Incoming requests are still updating.';
  }

  function renderCitySummary(summary) {
    if (!hasSummaryElements) return false;
    try {
      if (!validSummary(summary)) {
        showSummaryUnavailable();
        return false;
      }
      const currentRequests = summaryCount(summary.current.requests);
      const categories = rankedSummary(summary.categories.top, 'count-first');
      const asOf = portalDate(summary.as_of);
      const captureState = String(summary.capture.state || 'starting');

      summaryElements.eyebrow.textContent = captureState === 'fresh' ? 'NYC right now' : 'Last captured window';
      summaryElements.title.textContent = `Last ${summaryWindowLabel(summary.window_minutes)}`;
      summaryElements.updated.textContent = asOf && !Number.isNaN(asOf.getTime())
        ? `As of ${timeLabel(summary.as_of)}`
        : 'Current window';
      summaryElements.requestCount.textContent = currentRequests.toLocaleString();
      summaryElements.comparison.textContent = currentComparison(summary);
      summaryElements.categories.textContent = categories || 'No published request types in this window';
      summaryElements.otherCategories.textContent = categoryLongTail(summary.categories);
      summaryElements.boroughs.textContent = boroughSummary(summary.boroughs);
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

  async function refreshMap(dashboardStats) {
    const now = Date.now();
    if (mapRefreshInFlight || now - lastMapRefreshStartedAt < MAP_REFRESH_MS) return;
    mapRefreshInFlight = true;
    lastMapRefreshStartedAt = now;
    const sequence = ++mapRequestSequence;
    try {
      const payload = await fetchJson('/api/live-map', 'Map service');
      if (sequence !== mapRequestSequence) return;
      updateMapRecords(payload, dashboardStats);
    } catch (error) {
      if (sequence === mapRequestSequence) console.warn(error);
    } finally {
      if (sequence === mapRequestSequence) mapRefreshInFlight = false;
    }
  }

  async function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const data = await fetchJson('/api/live-dashboard?limit=750', 'Data service');
      const stats = data.stats || {};
      updateFeedRecords(data.records || []);
      updateMapStatsFromDashboard(stats);
      refreshMap(stats);
      currentPollSeconds = Number(stats.poll_interval_seconds || 15);
      pollInterval.value = String(currentPollSeconds);
      lastPortalCheck = stats.last_seen_at ? new Date(stats.last_seen_at) : null;
      renderOverviewStats(stats);
      renderCitySummary(stats.summary);
      document.getElementById('frontier-number').textContent = stats.frontier ? `311-${String(stats.frontier).padStart(8, '0')}` : '—';
      document.getElementById('last-updated').textContent = lastPortalCheck
        ? `Portal ${lastPortalCheck.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
        : 'Waiting for data';
      connection.classList.remove('offline');
      updateConnectionLabel();
    } catch (error) {
      showSummaryUnavailable();
      connection.classList.add('offline');
      connectionLabel.textContent = 'Reconnecting…';
      console.warn(error);
    } finally {
      refreshInFlight = false;
    }
  }

  feed.addEventListener('click', event => {
    const card = event.target.closest('.request-card');
    if (!card) return;
    if (window.matchMedia('(max-width: 720px)').matches) {
      setMobileView('map');
      window.setTimeout(() => selectRequest(card.dataset.number), 0);
    } else {
      selectRequest(card.dataset.number);
    }
  });
  feed.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.request-card');
    if (!card) return;
    if (window.matchMedia('(max-width: 720px)').matches) {
      setMobileView('map');
      window.setTimeout(() => selectRequest(card.dataset.number), 0);
    } else {
      selectRequest(card.dataset.number);
    }
  });
  mobileViewTabs.addEventListener('click', event => {
    const button = event.target.closest('button[data-mobile-view]');
    if (button) setMobileView(button.dataset.mobileView);
  });
  search.addEventListener('input', () => { renderFeed({ resetScroll: true }); renderMap(); });
  statusFilter.addEventListener('change', () => { renderFeed({ resetScroll: true }); renderMap(); });
  mapScopeControl.addEventListener('click', event => {
    const button = event.target.closest('button[data-map-scope]');
    if (!button || !mapScopeControl.contains(button)) return;
    mapScope = button.dataset.mapScope;
    mapScopeControl.querySelectorAll('button[data-map-scope]').forEach(scopeButton => {
      scopeButton.setAttribute('aria-pressed', String(scopeButton === button));
    });
    renderMap();
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
      refresh();
    }
  });
  document.getElementById('detail-close').addEventListener('click', () => {
    detailLoadSequence += 1;
    selectedNumber = null;
    detail.classList.add('hidden');
    renderFeed();
  });

  refresh();
  window.setInterval(refresh, 5000);
  window.setInterval(() => {
    const now = new Date();
    document.getElementById('nyc-clock').textContent = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit'
    }).format(now);
    if (lastPortalCheck) {
      const next = new Date(lastPortalCheck.getTime() + currentPollSeconds * 1000);
      const remaining = Math.max(0, Math.ceil((next.getTime() - now.getTime()) / 1000));
      document.getElementById('next-check').textContent = remaining > 0
        ? `NYC · Next check in ${remaining}s`
        : 'NYC · Checking now…';
    }
  }, 1000);
})();
