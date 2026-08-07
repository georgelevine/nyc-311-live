'use strict';

const TimelineMap = (() => {
  const INDEX_URL = '/data/sr-bid-timeline/index.json';
  const BOUNDARIES_URL = '/data/nyc-bid-boundaries-2026-04-28.geojson';
  const MONTH_URL = month => `/data/sr-bid-timeline/${month}.json`;
  const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

  let map;
  let index;
  let boundaryLayer;
  let pointsLayer;
  let pointRenderer;
  let currentDayIndex = 0;
  let currentCounts = new Map();
  let currentMaximum = 1;
  let selectedBidId = null;
  let playbackTimer = null;
  let renderToken = 0;
  let pointLoadTimer = null;
  const monthCache = new Map();

  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
  const shortDateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric'
  });
  const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
  const countFormatter = new Intl.NumberFormat('en-US');

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function dateValue(day) {
    return new Date(`${day}T12:00:00-04:00`);
  }

  function requestNumber(suffix) {
    return `311-${String(suffix).padStart(8, '0')}`;
  }

  function initializeMap() {
    map = L.map('timeline-map', {
      center: [40.7128, -74.006],
      zoom: 10,
      zoomControl: false,
      preferCanvas: true,
      doubleClickZoom: true,
      touchZoom: true
    });
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    L.tileLayer(TILE_URL, {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(map);
    pointRenderer = L.canvas({ padding: 0.5 });
    pointsLayer = L.layerGroup().addTo(map);
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load ${url}`);
    return response.json();
  }

  function showLoading(message) {
    document.getElementById('timeline-loading-text').textContent = message;
    document.getElementById('timeline-loading').hidden = false;
  }

  function hideLoading() {
    document.getElementById('timeline-loading').hidden = true;
  }

  function dayCount(bidId) {
    return currentCounts.get(Number(bidId)) || 0;
  }

  function boundaryStyle(feature) {
    const bidId = Number(feature.properties && feature.properties.bid_id);
    const count = dayCount(bidId);
    const ratio = count ? Math.min(1, Math.sqrt(count / currentMaximum)) : 0;
    const selected = bidId === selectedBidId;
    return {
      color: selected ? '#fbbf24' : count ? '#7ab8ff' : '#4f9cf7',
      weight: selected ? 3 : count ? 1.4 : 1,
      opacity: selected ? 1 : count ? 0.92 : 0.34,
      fillColor: '#4f9cf7',
      fillOpacity: selected ? Math.max(0.28, 0.12 + ratio * 0.58) : 0.03 + ratio * 0.56
    };
  }

  function boundaryTooltip(feature) {
    const properties = feature.properties || {};
    const count = dayCount(properties.bid_id);
    return `<strong>${escapeHtml(properties.name)}</strong><span>${countFormatter.format(count)} ${count === 1 ? 'request' : 'requests'}</span>`;
  }

  function updateSelectionPanel() {
    const panel = document.getElementById('bid-selection');
    if (selectedBidId == null) {
      panel.hidden = true;
      return;
    }
    const bid = index.bids[String(selectedBidId)];
    const count = dayCount(selectedBidId);
    document.getElementById('selected-bid-name').textContent = bid ? bid.name : 'Selected BID';
    document.getElementById('selected-bid-count').textContent =
      `${countFormatter.format(count)} ${count === 1 ? 'request' : 'requests'} on this date`;
    panel.hidden = false;
  }

  function selectBoundary(feature, layer) {
    selectedBidId = Number(feature.properties.bid_id);
    boundaryLayer.setStyle(boundaryStyle);
    layer.bringToFront();
    updateSelectionPanel();
  }

  function addBoundaries(collection) {
    boundaryLayer = L.geoJSON(collection, {
      style: boundaryStyle,
      onEachFeature(feature, layer) {
        layer.bindTooltip(() => boundaryTooltip(feature), {
          className: 'timeline-tooltip',
          sticky: true,
          direction: 'top',
          opacity: 1
        });
        layer.on('click', () => selectBoundary(feature, layer));
        layer.on('mouseover', () => layer.setStyle({ weight: 2.4, opacity: 1 }));
        layer.on('mouseout', () => boundaryLayer.resetStyle(layer));
      }
    }).addTo(map);
    map.fitBounds(boundaryLayer.getBounds(), {
      paddingTopLeft: [24, 24],
      paddingBottomRight: [24, 150],
      maxZoom: 11
    });
  }

  function monthData(month) {
    if (!monthCache.has(month)) {
      monthCache.set(month, fetchJson(MONTH_URL(month)).catch(error => {
        monthCache.delete(month);
        throw error;
      }));
    }
    return monthCache.get(month);
  }

  function bidNames(value) {
    const ids = Array.isArray(value) ? value : [value];
    return ids.map(id => index.bids[String(id)] && index.bids[String(id)].name)
      .filter(Boolean)
      .join(', ');
  }

  function popupHtml(record) {
    const [suffix, bidIds, , , epoch, problemIndex, statusIndex, address] = record;
    const number = requestNumber(suffix);
    const problem = index.problems[problemIndex] || '311 request';
    const status = index.statuses[statusIndex] || 'Unknown';
    return `<div class="request-popup">
      <strong>${escapeHtml(problem)}</strong>
      <dl>
        <dt>SR</dt><dd>${escapeHtml(number)}</dd>
        <dt>Status</dt><dd>${escapeHtml(status)}</dd>
        <dt>Reported</dt><dd>${escapeHtml(dateTimeFormatter.format(new Date(epoch * 1000)))}</dd>
        <dt>BID</dt><dd>${escapeHtml(bidNames(bidIds))}</dd>
        <dt>Address</dt><dd>${escapeHtml(address)}</dd>
      </dl>
      <a href="https://portal.311.nyc.gov/sr-details/?srnum=${encodeURIComponent(number)}" target="_blank" rel="noopener">Open 311 record</a>
    </div>`;
  }

  function pointTooltip(record) {
    const [suffix, , , , , problemIndex, statusIndex] = record;
    return `<strong>${escapeHtml(index.problems[problemIndex] || '311 request')}</strong><span>${escapeHtml(requestNumber(suffix))} · ${escapeHtml(index.statuses[statusIndex] || 'Unknown')}</span>`;
  }

  function drawPoints(records) {
    pointsLayer.clearLayers();
    const mobile = window.matchMedia('(max-width: 700px)').matches;
    const radius = mobile ? 6 : 4;
    for (const record of records) {
      const [, , latitude, longitude, , , statusIndex] = record;
      const inProgress = /progress|open/i.test(index.statuses[statusIndex] || '');
      const marker = L.circleMarker([latitude, longitude], {
        renderer: pointRenderer,
        radius,
        color: '#eef2f7',
        weight: mobile ? 1.2 : 0.9,
        opacity: 0.92,
        fillColor: inProgress ? '#fb923c' : '#7ab8ff',
        fillOpacity: 0.88,
        bubblingMouseEvents: false
      });
      marker.bindTooltip(() => pointTooltip(record), {
        className: 'timeline-tooltip',
        sticky: true,
        direction: 'top',
        opacity: 1
      });
      marker.bindPopup(() => popupHtml(record), {
        className: 'timeline-popup',
        maxWidth: 300,
        autoPanPaddingTopLeft: [12, 70],
        autoPanPaddingBottomRight: [12, 150]
      });
      marker.addTo(pointsLayer);
    }
  }

  async function loadPoints(day, token) {
    const month = day.date.slice(0, 7);
    try {
      const payload = await monthData(month);
      if (token !== renderToken) return;
      drawPoints(payload.days[day.date] || []);
      hideLoading();
    } catch (error) {
      if (token !== renderToken) return;
      showLoading('Could not load request locations');
      console.error(error);
    }
  }

  function setDate(dayIndex, { immediatePoints = false } = {}) {
    currentDayIndex = Math.max(0, Math.min(index.days.length - 1, Number(dayIndex)));
    const day = index.days[currentDayIndex];
    currentCounts = new Map(day.counts);
    const positiveCounts = [...currentCounts.values()].filter(Boolean).sort((a, b) => a - b);
    currentMaximum = positiveCounts.length
      ? positiveCounts[Math.min(positiveCounts.length - 1, Math.floor(positiveCounts.length * 0.9))]
      : 1;

    document.getElementById('timeline-slider').value = String(currentDayIndex);
    const date = dateValue(day.date);
    const totalLabel = `${countFormatter.format(day.requests)} ${day.requests === 1 ? 'request' : 'requests'}`;
    const dateElement = document.getElementById('selected-date');
    dateElement.textContent = dateFormatter.format(date);
    dateElement.dateTime = day.date;
    document.getElementById('selected-total').textContent = totalLabel;
    document.getElementById('timeline-live-status').textContent = `${dateFormatter.format(date)}, ${totalLabel}`;
    boundaryLayer.setStyle(boundaryStyle);
    updateSelectionPanel();

    renderToken += 1;
    const token = renderToken;
    clearTimeout(pointLoadTimer);
    if (immediatePoints) {
      showLoading('Loading request locations');
      loadPoints(day, token);
    } else {
      pointLoadTimer = setTimeout(() => {
        showLoading('Loading request locations');
        loadPoints(day, token);
      }, 90);
    }
  }

  function stopPlayback() {
    clearInterval(playbackTimer);
    playbackTimer = null;
    const button = document.getElementById('timeline-play');
    button.dataset.playing = 'false';
    button.setAttribute('aria-label', 'Play timeline');
    button.title = 'Play';
  }

  function togglePlayback() {
    if (playbackTimer) {
      stopPlayback();
      return;
    }
    if (currentDayIndex >= index.days.length - 1) setDate(0, { immediatePoints: true });
    const button = document.getElementById('timeline-play');
    button.dataset.playing = 'true';
    button.setAttribute('aria-label', 'Pause timeline');
    button.title = 'Pause';
    playbackTimer = setInterval(() => {
      if (currentDayIndex >= index.days.length - 1) {
        stopPlayback();
        return;
      }
      setDate(currentDayIndex + 1, { immediatePoints: true });
    }, 800);
  }

  function connectControls() {
    const slider = document.getElementById('timeline-slider');
    slider.max = String(index.days.length - 1);
    slider.addEventListener('input', event => setDate(event.target.value));
    slider.addEventListener('change', event => setDate(event.target.value, { immediatePoints: true }));
    document.getElementById('timeline-play').addEventListener('click', togglePlayback);
    document.getElementById('clear-bid-selection').addEventListener('click', () => {
      selectedBidId = null;
      boundaryLayer.setStyle(boundaryStyle);
      updateSelectionPanel();
    });
  }

  function setMetadata() {
    const metadata = index.metadata;
    const start = dateValue(metadata.from);
    const end = dateValue(metadata.to);
    document.getElementById('coverage-label').textContent =
      `${shortDateFormatter.format(start)}–${shortDateFormatter.format(end)} · ${countFormatter.format(metadata.unique_requests)} Portal requests`;
    document.getElementById('timeline-start-label').textContent = shortDateFormatter.format(start);
    document.getElementById('timeline-end-label').textContent = shortDateFormatter.format(end);
  }

  async function initialize() {
    initializeMap();
    showLoading('Loading timeline');
    try {
      const [timelineIndex, boundaries] = await Promise.all([
        fetchJson(INDEX_URL),
        fetchJson(BOUNDARIES_URL)
      ]);
      index = timelineIndex;
      setMetadata();
      addBoundaries(boundaries);
      connectControls();
      setDate(index.days.length - 1, { immediatePoints: true });
    } catch (error) {
      showLoading('Timeline data is unavailable');
      console.error(error);
    }
  }

  document.addEventListener('DOMContentLoaded', initialize);
  return { initialize };
})();
