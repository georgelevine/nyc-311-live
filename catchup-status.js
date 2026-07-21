'use strict';

function parseState(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function suffix(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 99999999 ? number : null;
}

function buildCatchupStatus({ windowState, runState, coverage = {}, currentSuffix, now = Date.now() }) {
  const window = parseState(windowState);
  const low = suffix(window && window.low_suffix);
  const high = suffix(window && window.high_suffix);
  if (!window || low == null || high == null || high < low) return null;

  const total = high - low + 1;
  const completed = Math.max(0, Math.min(total, Number(coverage.completed || 0)));
  const remaining = Math.max(0, total - completed);
  const run = parseState(runState) || {};
  const runLow = suffix(run.low_suffix);
  const runHigh = suffix(run.high_suffix);
  const runOverlaps = runLow != null && runHigh != null && runLow <= high && runHigh >= low;
  const active = remaining > 0 && run.status === 'running' && runOverlaps;
  const startedAt = active ? Date.parse(run.started_at) : NaN;
  const completedAtStart = Math.max(0, Number(run.completed_at_start || 0));
  const completedDuringRun = Math.max(0, completed - completedAtStart);
  const elapsedSeconds = Number.isFinite(startedAt) ? Math.max(1, (Number(now) - startedAt) / 1000) : 0;
  const perSecond = completedDuringRun > 0 && elapsedSeconds > 0
    ? completedDuringRun / elapsedSeconds
    : null;

  let status = 'queued';
  if (remaining === 0) status = 'complete';
  else if (active) status = 'running';
  else if (run.status === 'retry' && runOverlaps) status = 'retry';

  return {
    status,
    offline_from: window.offline_from || null,
    offline_to: window.offline_to || null,
    low_suffix: low,
    high_suffix: high,
    current_suffix: remaining > 0 ? suffix(currentSuffix) : null,
    total,
    completed,
    remaining,
    percent: total ? Number(((completed / total) * 100).toFixed(1)) : 100,
    found: Math.max(0, Number(coverage.found || 0)),
    not_found: Math.max(0, Number(coverage.not_found || 0)),
    retry: Math.max(0, Number(coverage.retry || 0)),
    requests_per_second: perSecond == null ? null : Number(perSecond.toFixed(2)),
    estimated_seconds_remaining: perSecond ? Math.ceil(remaining / perSecond) : null,
    started_at: active ? run.started_at || null : null,
    finished_at: remaining === 0 ? run.finished_at || window.completed_at || null : null
  };
}

module.exports = { buildCatchupStatus, parseState };
