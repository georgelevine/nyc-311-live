(() => {
  const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([40.7128, -74.0060], 11);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap &copy; CARTO'
  }).addTo(map);
  const GEOGRAPHY_PANE = 'boundary';
  const geographyPane = map.createPane(GEOGRAPHY_PANE);
  geographyPane.style.zIndex = '350';
  geographyPane.style.pointerEvents = 'none';
  const geographyRenderer = L.svg({ pane: GEOGRAPHY_PANE });
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
  const precinctFilter = document.getElementById('precinct-filter');
  const bidFilter = document.getElementById('bid-filter');
  const connection = document.querySelector('.live-state');
  const connectionLabel = document.getElementById('connection-label');
  const pollInterval = document.getElementById('poll-interval');
  const detail = document.getElementById('request-detail');
  const mapScopeControl = document.getElementById('map-scope');
  const mapCounts = document.getElementById('map-counts');
  const mapBoundaryKey = document.getElementById('map-boundary-key');
  const detailPendingBadge = document.getElementById('detail-pending-badge');
  const detailEmailUpdates = document.getElementById('detail-email-updates');
  const detailEmailCount = document.getElementById('detail-email-count');
  const detailEmailEvents = document.getElementById('detail-email-events');
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
  const MAX_VISIBLE_RECORDS = 750;
  const MAP_REFRESH_MS = 15_000;
  const EMAIL_UPDATES_REFRESH_MS = 15_000;
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
  let highestObservedSuffix = null;
  let arrivingNumbers = new Set();
  let lastGoodSummary = null;
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
    }
    if (view === 'map') {
      scheduleMapLayout({ attemptBoundaryFit: true });
    }
    return usesViewTabs && normalizedView === 'map';
  }

  const submittedMillis = record => {
    const date = portalDate(record && record.submitted_at);
    return date && !Number.isNaN(date.getTime()) ? date.getTime() : null;
  };
  const suffixOf = record => Number(String(record && record.srnumber || '').replace(/^311-/, '')) || 0;
  function exactSrnumberQuery() {
    const value = search.value.trim().toUpperCase().replace(/\s+/g, '');
    if (/^\d{8}$/.test(value)) return `311-${value}`;
    const match = value.match(/^311-?(\d{8})$/);
    return match ? `311-${match[1]}` : null;
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
    const visible = records.filter(matchesFilters);
    const exact = exactSrnumberQuery();
    if (!exact) return visible;
    const archived = archiveSearchRecord && archiveSearchRecord.srnumber === exact
      ? archiveSearchRecord
      : mapByNumber.get(exact);
    if (archived && matchesFilters(archived)
        && !visible.some(record => record.srnumber === archived.srnumber)) {
      visible.unshift(archived);
    }
    return visible;
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
      const exact = exactSrnumberQuery();
      const message = exact && archiveSearchState === 'loading'
        ? `Searching the full archive for ${exact}…`
        : exact && archiveSearchState === 'not_found'
          ? `${exact} is not in the captured archive.`
          : exact && archiveSearchState === 'error'
            ? 'The full archive search is temporarily unavailable.'
            : 'No requests match the current filters.';
      feed.innerHTML = `<div class="empty-state"><p>${esc(message)}</p></div>`;
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
    const cachedDetail = portalDetailByNumber.get(record.srnumber);
    if (cachedDetail) {
      renderSubmittedDetails(cachedDetail, 'success');
    } else if (record.details_fetched_at) {
      const savedDetail = {
        problemDetails: record.problem_details,
        additionalDetails: record.additional_details,
        nextUpdate: record.next_update,
        dateReported: record.date_reported,
        updatedOn: record.updated_on,
        dateClosed: record.date_closed
      };
      portalDetailByNumber.set(record.srnumber, savedDetail);
      renderSubmittedDetails(savedDetail, 'stored');
    }
  }

  function clearEmailUpdatesPanel({ resetDisclosure = false } = {}) {
    detailEmailCount.textContent = '';
    detailEmailEvents.replaceChildren();
    detailEmailUpdates.hidden = true;
    if (resetDisclosure) detailEmailUpdates.open = true;
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
    if (String(update && update.event_kind || '').toLowerCase() !== 'closed') return null;
    const followupState = String(record && record.followup_state || '').toLowerCase();
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
      return { label: 'Portal verified', state: 'verified' };
    }
    return { label: 'Awaiting Portal verification', state: 'waiting' };
  }

  function appendEmailUpdate(record, update) {
    const item = document.createElement('li');
    item.className = 'detail-email-event';

    const heading = document.createElement('div');
    heading.className = 'detail-email-event-heading';
    const eventKind = String(update && update.event_kind || '').toLowerCase() === 'closed'
      ? 'Closed'
      : 'Updated';
    const title = document.createElement('strong');
    title.textContent = eventKind;
    const received = document.createElement('time');
    received.textContent = fullTimeLabel(update && update.received_at);
    if (update && update.received_at) received.dateTime = update.received_at;
    heading.append(title, received);

    const agency = document.createElement('p');
    agency.className = 'detail-email-agency';
    agency.textContent = emailAgencyLabel(update);
    item.append(heading, agency);

    const type = String(update && update.request_type || '').trim();
    const subtype = String(update && update.request_subtype || '').trim();
    if (type || subtype) {
      const requestType = document.createElement('p');
      requestType.className = 'detail-email-request-type';
      requestType.textContent = [type, subtype].filter(Boolean).join(' · ');
      item.append(requestType);
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
    if (verification) {
      const state = document.createElement('span');
      state.className = 'detail-email-verification';
      state.dataset.state = verification.state;
      state.textContent = verification.label;
      item.append(state);
    }

    detailEmailEvents.append(item);
  }

  function renderEmailUpdates(record, payload, { resetDisclosure = false } = {}) {
    if (!record || selectedNumber !== record.srnumber) return;
    const updates = Array.isArray(payload && payload.updates) ? payload.updates : [];
    clearEmailUpdatesPanel({ resetDisclosure });
    if (!updates.length) return;
    const total = Number(payload && payload.total);
    const totalUpdates = Number.isFinite(total) && total >= updates.length ? total : updates.length;
    detailEmailCount.textContent = totalUpdates > updates.length
      ? `${updates.length} of ${totalUpdates} updates`
      : `${updates.length} ${updates.length === 1 ? 'update' : 'updates'}`;
    for (const update of updates) appendEmailUpdate(record, update);
    detailEmailUpdates.hidden = false;
  }

  function beginEmailUpdatesSelection(record) {
    emailUpdatesLoadSequence += 1;
    if (emailUpdatesAbortController) emailUpdatesAbortController.abort();
    emailUpdatesAbortController = null;
    emailUpdatesInFlightFor = null;
    clearEmailUpdatesPanel({ resetDisclosure: true });
    const cached = emailUpdatesByNumber.get(record.srnumber);
    if (cached) renderEmailUpdates(record, cached, { resetDisclosure: true });
    loadEmailUpdates(record, { force: true });
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
        renderEmailUpdates(record, payload);
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

  async function loadPortalDetails(record) {
    const sequence = ++detailLoadSequence;
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
      renderSubmittedDetails(saved, 'stored');
      return;
    }
    const cached = portalDetailByNumber.get(record.srnumber);
    if (cached) {
      renderSubmittedDetails(cached, 'success');
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
    selectedNumber = number;
    renderDetail(record);
    setDetailPanelVisible(true);
    renderFeed();
    loadPortalDetails(record);
    beginEmailUpdatesSelection(record);
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
        srnumber
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
      renderFeed();
      renderMap();
      if (selectedNumber) renderDetail(findRecord(selectedNumber));
    } catch (error) {
      bidFilter.innerHTML = '<option value="">BID filter unavailable</option>';
      bidFilter.disabled = true;
      console.warn(error);
    }
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

  async function fetchJson(url, label, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options });
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
    const now = Date.now();
    if (force) {
      mapRequestSequence += 1;
      mapRefreshInFlight = false;
      lastMapRefreshStartedAt = 0;
    }
    if (mapRefreshInFlight || now - lastMapRefreshStartedAt < MAP_REFRESH_MS) return;
    mapRefreshInFlight = true;
    lastMapRefreshStartedAt = now;
    const sequence = ++mapRequestSequence;
    try {
      const payload = await fetchJson(scopedUrl('/api/live-map'), 'Map service');
      if (sequence !== mapRequestSequence) return;
      updateMapRecords(payload, dashboardStats);
    } catch (error) {
      if (sequence === mapRequestSequence) console.warn(error);
    } finally {
      if (sequence === mapRequestSequence) mapRefreshInFlight = false;
    }
  }

  async function refresh({ force = false } = {}) {
    if (refreshInFlight && !force) return;
    if (force && dashboardAbortController) dashboardAbortController.abort();
    const controller = new AbortController();
    dashboardAbortController = controller;
    const sequence = ++dashboardRequestSequence;
    refreshInFlight = true;
    try {
      const data = await fetchJson(scopedUrl('/api/live-dashboard', { limit: 750 }), 'Data service', {
        signal: controller.signal
      });
      if (sequence !== dashboardRequestSequence) return;
      const stats = data.stats || {};
      updateFeedRecords(data.records || []);
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
      renderOverviewStats(stats);
      renderCitySummary(stats.summary);
      document.getElementById('frontier-number').textContent = stats.frontier ? `311-${String(stats.frontier).padStart(8, '0')}` : '—';
      document.getElementById('last-updated').textContent = lastPortalCheck
        ? `Portal ${lastPortalCheck.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
        : 'Waiting for data';
      connection.classList.remove('offline');
      updateConnectionLabel();
      if (selectedNumber) loadEmailUpdates(findRecord(selectedNumber));
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (sequence !== dashboardRequestSequence) return;
      showSummaryUnavailable();
      connection.classList.add('offline');
      connectionLabel.textContent = 'Reconnecting…';
      console.warn(error);
    } finally {
      if (sequence === dashboardRequestSequence) {
        refreshInFlight = false;
        dashboardAbortController = null;
      }
    }
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
  feed.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.request-card');
    if (!card) return;
    event.preventDefault();
    openRequestFromFeed(card.dataset.number);
  });
  mobileViewTabs.addEventListener('click', event => {
    const button = event.target.closest('button[data-mobile-view]');
    if (button) setMobileView(button.dataset.mobileView);
  });
  search.addEventListener('input', scheduleArchiveSearch);
  statusFilter.addEventListener('change', () => { renderFeed({ resetScroll: true }); renderMap(); });
  function handleGeographyFilterChange() {
    lastGoodSummary = null;
    highestObservedSuffix = null;
    detailLoadSequence += 1;
    emailUpdatesLoadSequence += 1;
    if (emailUpdatesAbortController) emailUpdatesAbortController.abort();
    emailUpdatesAbortController = null;
    emailUpdatesInFlightFor = null;
    clearEmailUpdatesPanel({ resetDisclosure: true });
    archiveSearchSequence += 1;
    archiveSearchRecord = null;
    archiveSearchState = 'idle';
    if (archiveSearchTimer !== null) {
      window.clearTimeout(archiveSearchTimer);
      archiveSearchTimer = null;
    }
    selectedNumber = null;
    setDetailPanelVisible(false);
    renderFeed({ resetScroll: true });
    renderMap();
    syncSelectedBoundaries();
    refresh({ force: true });
    scheduleArchiveSearch();
  }
  precinctFilter.addEventListener('change', handleGeographyFilterChange);
  bidFilter.addEventListener('change', handleGeographyFilterChange);
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
    emailUpdatesLoadSequence += 1;
    if (emailUpdatesAbortController) emailUpdatesAbortController.abort();
    emailUpdatesAbortController = null;
    emailUpdatesInFlightFor = null;
    clearEmailUpdatesPanel({ resetDisclosure: true });
    const closedNumber = selectedNumber;
    selectedNumber = null;
    setDetailPanelVisible(false);
    renderFeed();
    const returnTarget = compactLayout.matches && viewTabsVisible()
      ? mobileViewTabs.querySelector('button[aria-pressed="true"]')
      : [...feed.querySelectorAll('.request-card')]
        .find(card => card.dataset.number === closedNumber);
    if (returnTarget) returnTarget.focus();
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
