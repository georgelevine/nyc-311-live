'use strict';

const SYNCHRONOUS_MODES = new Set(['OFF', 'NORMAL', 'FULL', 'EXTRA']);

function resolveSynchronousMode(value, fallback = 'NORMAL') {
  const selected = String(value || fallback).trim().toUpperCase();
  if (!SYNCHRONOUS_MODES.has(selected)) {
    throw new Error(`SQLITE_SYNCHRONOUS must be one of ${Array.from(SYNCHRONOUS_MODES).join(', ')}`);
  }
  return selected;
}

module.exports = { resolveSynchronousMode, SYNCHRONOUS_MODES };
