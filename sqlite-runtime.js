'use strict';

const SYNCHRONOUS_MODES = new Set(['OFF', 'NORMAL', 'FULL', 'EXTRA']);
const DEFAULT_BUSY_TIMEOUT_MS = 30_000;
const MAX_BUSY_TIMEOUT_MS = 5 * 60_000;

function resolveSynchronousMode(value, fallback = 'NORMAL') {
  const selected = String(value || fallback).trim().toUpperCase();
  if (!SYNCHRONOUS_MODES.has(selected)) {
    throw new Error(`SQLITE_SYNCHRONOUS must be one of ${Array.from(SYNCHRONOUS_MODES).join(', ')}`);
  }
  return selected;
}

function resolveBusyTimeoutMs(value, fallback = DEFAULT_BUSY_TIMEOUT_MS) {
  const selected = value == null || String(value).trim() === ''
    ? Number(fallback)
    : Number(value);
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > MAX_BUSY_TIMEOUT_MS) {
    throw new TypeError(
      `SQLITE_BUSY_TIMEOUT_MS must be an integer from 0 through ${MAX_BUSY_TIMEOUT_MS}`
    );
  }
  return selected;
}

module.exports = {
  DEFAULT_BUSY_TIMEOUT_MS,
  MAX_BUSY_TIMEOUT_MS,
  resolveBusyTimeoutMs,
  resolveSynchronousMode,
  SYNCHRONOUS_MODES
};
