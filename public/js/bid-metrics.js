'use strict';

const BidMetrics = (() => {
  const DATA_URL = './data/sr-bid-metrics.json?v=20260804-1';
  const integer = new Intl.NumberFormat('en-US');
  const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric'
  });
  const monthLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', year: 'numeric'
  });
  const snapshotLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  });

  let payload = null;

  function element(id) { return document.getElementById(id); }
  function dateObject(value) { return new Date(`${value}T12:00:00.000Z`); }
  function displayDate(value) { return dateLabel.format(dateObject(value)); }
  function dateShift(value, days) {
    const date = dateObject(value);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
  function daySpan(from, to) {
    return Math.round((dateObject(to) - dateObject(from)) / 86400000) + 1;
  }
  function addCounts(target, pairs) {
    for (const [key, count] of pairs || []) {
      target.set(Number(key), (target.get(Number(key)) || 0) + Number(count || 0));
    }
  }
  function selectedBidId() {
    const value = element('bid-select').value;
    return value === '' ? null : Number(value);
  }
  function groupForDay(day, bidId) {
    if (!day) return null;
    if (bidId == null) return day.all;
    const row = day.bids.find(candidate => Number(candidate[0]) === bidId);
    return row ? [row[1], row[2], row[3]] : [0, [], []];
  }

  function aggregate(from, to, bidId, { includeBidRanking = false } = {}) {
    const result = {
      requests: 0,
      statuses: new Map(),
      problems: new Map(),
      months: new Map(),
      bids: new Map()
    };
    for (const [date, day] of Object.entries(payload.days)) {
      if (date < from || date > to) continue;
      const group = groupForDay(day, bidId);
      const requests = Number(group && group[0] || 0);
      result.requests += requests;
      addCounts(result.statuses, group && group[1]);
      addCounts(result.problems, group && group[2]);
      const month = date.slice(0, 7);
      result.months.set(month, (result.months.get(month) || 0) + requests);
      if (includeBidRanking) {
        for (const bid of day.bids || []) {
          result.bids.set(Number(bid[0]), (result.bids.get(Number(bid[0])) || 0) + Number(bid[1] || 0));
        }
      }
    }
    return result;
  }

  function sortedCounts(map) {
    return [...map.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  }

  function monthEnd(month) {
    const next = new Date(`${month}-01T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(0);
    return next.toISOString().slice(0, 10);
  }

  function renderMonthly(months, from, to) {
    const chart = element('monthly-chart');
    const values = [...months.entries()].sort((left, right) => left[0].localeCompare(right[0]));
    const maximum = Math.max(1, ...values.map(entry => entry[1]));
    chart.replaceChildren();
    chart.style.setProperty('--month-count', String(Math.max(1, values.length)));
    for (const [month, count] of values) {
      const column = document.createElement('div');
      const isPartial = from > `${month}-01`
        || to < monthEnd(month)
        || (Boolean(payload.metadata.final_day_partial)
          && to >= payload.metadata.to
          && month === payload.metadata.to.slice(0, 7));
      column.className = `month-column${isPartial ? ' is-partial' : ''}`;
      const value = document.createElement('strong');
      value.textContent = integer.format(count);
      const wrap = document.createElement('div');
      wrap.className = 'month-bar-wrap';
      const bar = document.createElement('span');
      bar.className = 'month-bar';
      bar.style.setProperty('--bar-height', `${Math.max(2, count / maximum * 100)}%`);
      bar.title = `${monthLabel.format(dateObject(`${month}-01`))}: ${integer.format(count)} requests`;
      const label = document.createElement('span');
      label.textContent = monthLabel.format(dateObject(`${month}-01`));
      if (isPartial) {
        const partial = document.createElement('em');
        partial.textContent = 'Partial';
        label.append(document.createElement('br'), partial);
      }
      wrap.append(bar);
      column.append(value, wrap, label);
      chart.append(column);
    }
    chart.setAttribute('aria-label', values.map(([month, count]) =>
      `${monthLabel.format(dateObject(`${month}-01`))}: ${integer.format(count)}`
    ).join('; '));
    const peak = values.reduce((highest, candidate) =>
      !highest || candidate[1] > highest[1] ? candidate : highest, null);
    const hasPartialMonth = values.some(([month]) => from > `${month}-01`
      || to < monthEnd(month)
      || (Boolean(payload.metadata.final_day_partial)
        && to >= payload.metadata.to
        && month === payload.metadata.to.slice(0, 7)));
    element('monthly-context').textContent = peak
      ? `Peak ${monthLabel.format(dateObject(`${peak[0]}-01`))} · ${integer.format(peak[1])}${
        hasPartialMonth ? ' · striped months are partial' : ''
      }`
      : 'No requests in this period';
  }

  function rankingItem(label, value, maximum) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'ranking-label';
    name.textContent = label;
    const count = document.createElement('span');
    count.className = 'ranking-value';
    count.textContent = integer.format(value);
    const track = document.createElement('span');
    track.className = 'ranking-track';
    const fill = document.createElement('span');
    fill.className = 'ranking-fill';
    fill.style.setProperty('--ranking-width', `${maximum ? value / maximum * 100 : 0}%`);
    track.append(fill);
    item.append(name, count, track);
    return item;
  }

  function renderProblems(problems) {
    const ranking = element('problem-ranking');
    const values = sortedCounts(problems).slice(0, 10);
    const maximum = values[0] && values[0][1] || 1;
    ranking.replaceChildren(...values.map(([index, count]) =>
      rankingItem(payload.problems[index] || 'Other request', count, maximum)
    ));
    if (!values.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No requests in this period.';
      ranking.append(empty);
    }
  }

  function renderStatuses(statuses, total) {
    const values = sortedCounts(statuses);
    const bar = element('status-bar');
    const breakdown = element('status-breakdown');
    bar.replaceChildren();
    breakdown.replaceChildren();
    values.forEach(([index, count]) => {
      const statusName = payload.statuses[index] || 'Unknown';
      const segment = document.createElement('span');
      segment.className = /closed/i.test(statusName)
        ? 'status-closed'
        : /progress|open/i.test(statusName) ? 'status-open' : 'status-other';
      segment.style.width = `${total ? count / total * 100 : 0}%`;
      bar.append(segment);
      const row = document.createElement('div');
      const name = document.createElement('dt');
      name.textContent = statusName;
      const value = document.createElement('dd');
      value.textContent = `${integer.format(count)} · ${percent.format(total ? count / total : 0)}`;
      row.append(name, value);
      breakdown.append(row);
    });
  }

  function renderBidRanking(bids) {
    const panel = element('bid-ranking-panel');
    const ranking = element('bid-ranking');
    const values = sortedCounts(bids).slice(0, 10);
    const maximum = values[0] && values[0][1] || 1;
    ranking.replaceChildren(...values.map(([bidId, count]) => {
      const bid = payload.bids[String(bidId)];
      return rankingItem(bid ? bid.name : `BID ${bidId}`, count, maximum);
    }));
    panel.hidden = selectedBidId() != null;
  }

  function previousComparison(from, to, bidId) {
    const days = daySpan(from, to);
    const previousTo = dateShift(from, -1);
    const previousFrom = dateShift(previousTo, -(days - 1));
    if (previousFrom < payload.metadata.from) return null;
    const previous = aggregate(previousFrom, previousTo, bidId);
    return { ...previous, from: previousFrom, to: previousTo };
  }

  function syncUrl(from, to, bidId) {
    const url = new URL(window.location.href);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    if (bidId == null) url.searchParams.delete('bid');
    else url.searchParams.set('bid', String(bidId));
    window.history.replaceState(null, '', url);
  }

  function render() {
    const from = element('date-from').value;
    const to = element('date-to').value;
    const bidId = selectedBidId();
    const status = element('metrics-status');
    if (!from || !to || from > to) {
      status.dataset.error = 'true';
      status.textContent = 'Choose a valid date range.';
      element('metrics-content').hidden = true;
      return;
    }
    delete status.dataset.error;
    status.textContent = '';
    const days = daySpan(from, to);
    const result = aggregate(from, to, bidId, { includeBidRanking: bidId == null });
    const previous = previousComparison(from, to, bidId);
    const selectedBid = bidId == null ? null : payload.bids[String(bidId)];
    const closedIndex = payload.statuses.findIndex(value => /closed/i.test(value));
    const closed = result.statuses.get(closedIndex) || 0;

    element('page-title').textContent = selectedBid ? selectedBid.name : 'All BIDs';
    const includesPartialDay = Boolean(payload.metadata.final_day_partial)
      && to >= payload.metadata.to;
    element('range-summary').textContent =
      `${displayDate(from)}–${displayDate(to)} · ${integer.format(days)} ${days === 1 ? 'day' : 'days'}${
        includesPartialDay ? ' · partial final day included' : ''
      }`;
    element('metric-total').textContent = integer.format(result.requests);
    element('metric-total-note').textContent = bidId == null
      ? 'Unique requests across all BIDs'
      : `Requests assigned to this ${selectedBid && selectedBid.borough || ''} BID`;
    element('metric-daily').textContent = decimal.format(result.requests / Math.max(1, days));
    element('metric-days-note').textContent = `Across ${integer.format(days)} calendar ${
      days === 1 ? 'day' : 'days'
    }${includesPartialDay ? ' · provisional' : ''}`;
    element('metric-closed').textContent = percent.format(result.requests ? closed / result.requests : 0);

    const changeValue = element('metric-change');
    if (!previous || !previous.requests) {
      changeValue.textContent = '—';
      changeValue.removeAttribute('data-tone');
      element('metric-change-note').textContent = 'No equal earlier period in this archive';
    } else {
      const change = (result.requests - previous.requests) / previous.requests;
      changeValue.textContent = `${change > 0 ? '+' : ''}${percent.format(change)}`;
      changeValue.dataset.tone = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
      element('metric-change-note').textContent =
        `${includesPartialDay ? 'Provisional · ' : ''}versus ${displayDate(previous.from)}–${displayDate(previous.to)}`;
    }

    renderMonthly(result.months, from, to);
    renderProblems(result.problems);
    renderStatuses(result.statuses, result.requests);
    renderBidRanking(result.bids);
    element('metrics-content').hidden = false;
    syncUrl(from, to, bidId);
  }

  function populateControls() {
    const metadata = payload.metadata;
    const select = element('bid-select');
    const bids = Object.entries(payload.bids)
      .sort((left, right) => left[1].name.localeCompare(right[1].name));
    for (const [id, bid] of bids) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `${bid.name} — ${bid.borough}`;
      select.append(option);
    }
    const parameters = new URLSearchParams(window.location.search);
    const requestedBid = parameters.get('bid');
    const from = parameters.get('from');
    const to = parameters.get('to');
    if (requestedBid && payload.bids[requestedBid]) select.value = requestedBid;
    element('date-from').min = metadata.from;
    element('date-from').max = metadata.to;
    element('date-to').min = metadata.from;
    element('date-to').max = metadata.to;
    element('date-from').value = from && from >= metadata.from && from <= metadata.to
      ? from : metadata.from;
    element('date-to').value = to && to >= metadata.from && to <= metadata.to
      ? to : (metadata.last_complete_date || metadata.to);
    for (const control of [select, element('date-from'), element('date-to'), element('apply-filters')]) {
      control.disabled = false;
    }
  }

  function connectControls() {
    element('metrics-filters').addEventListener('submit', event => {
      event.preventDefault();
      render();
    });
    element('bid-select').addEventListener('change', render);
    document.querySelectorAll('.quick-ranges button').forEach(button => {
      button.addEventListener('click', () => {
        const range = button.dataset.days;
        const end = payload.metadata.last_complete_date || payload.metadata.to;
        element('date-to').value = end;
        element('date-from').value = range === 'all'
          ? payload.metadata.from
          : [dateShift(end, -(Number(range) - 1)), payload.metadata.from].sort().at(-1);
        render();
      });
    });
  }

  async function initialize() {
    try {
      if (globalThis.__BID_METRICS_DATA__) {
        payload = globalThis.__BID_METRICS_DATA__;
        globalThis.__BID_METRICS_DATA__ = null;
      } else {
        const response = await fetch(DATA_URL, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`Metrics data returned HTTP ${response.status}`);
        payload = await response.json();
      }
      populateControls();
      connectControls();
      const metadata = payload.metadata;
      element('coverage-label').textContent =
        `${displayDate(metadata.from)}–${displayDate(metadata.to)} · ${integer.format(metadata.unique_requests)} requests`;
      element('data-badge').textContent = 'Historical Portal snapshot';
      const captured = new Date(metadata.source_snapshot_at || metadata.created_at);
      element('source-note').textContent =
        `Historical Portal queries completed ${snapshotLabel.format(captured)}.${
          metadata.final_day_partial ? ` ${displayDate(metadata.to)} is a partial day and is excluded from the default range.` : ''
        }`;
      render();
    } catch (error) {
      const status = element('metrics-status');
      status.dataset.error = 'true';
      status.textContent = 'BID metrics could not be loaded. Please try again.';
      console.error(error);
    }
  }

  document.addEventListener('DOMContentLoaded', initialize);
  return { aggregate, daySpan, dateShift };
})();
