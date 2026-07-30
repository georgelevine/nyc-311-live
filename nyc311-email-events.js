'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_RESPONSE_TEXT = 64 * 1024;
const MAX_NEXT_UPDATE_TEXT = 4 * 1024;

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizedLimit(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return DEFAULT_LIMIT;
  return Math.min(numeric, MAX_LIMIT);
}

function emptyResult(srnumber) {
  return {
    srnumber,
    subscription: null,
    updates: [],
    total: 0
  };
}

function tableNames(database) {
  return new Set(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map(row => row.name));
}

function readRequestEmailUpdates(databasePath, srnumber, {
  existsSync = fs.existsSync,
  openDatabase = (filename, options) => new DatabaseSync(filename, options),
  limit = DEFAULT_LIMIT
} = {}) {
  const normalizedSrnumber = textOrNull(srnumber);
  const result = emptyResult(normalizedSrnumber);
  if (!databasePath || !normalizedSrnumber || !existsSync(databasePath)) return result;

  let database;
  try {
    database = openDatabase(databasePath, { readOnly: true });
    const tables = tableNames(database);

    if (tables.has('nyc311_email_aliases')) {
      const row = database.prepare(`
        SELECT state,subscribed_at,last_received_at
        FROM nyc311_email_aliases
        WHERE srnumber=?
        LIMIT 1
      `).get(normalizedSrnumber);
      if (row) {
        result.subscription = {
          state: textOrNull(row.state),
          subscribed_at: textOrNull(row.subscribed_at),
          last_received_at: textOrNull(row.last_received_at)
        };
      }
    }

    if (!tables.has('nyc311_email_events')) return result;

    const eligibleWhere = `
      reconciled_srnumber=?
        AND parse_outcome='parsed'
        AND srnumber_mismatch=0
        AND alias_match_status IN ('matched','attached')
    `;
    result.total = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM nyc311_email_events INDEXED BY nyc311_email_events_request_idx
      WHERE ${eligibleWhere}
    `).get(normalizedSrnumber).count || 0);

    result.updates = database.prepare(`
      SELECT id,event_kind,agency_name,agency_acronym,request_type,request_subtype,
        substr(response_text,1,${MAX_RESPONSE_TEXT}) AS response_text,
        substr(next_update_text,1,${MAX_NEXT_UPDATE_TEXT}) AS next_update_text,
        received_at,closure_wake_queued
      FROM nyc311_email_events INDEXED BY nyc311_email_events_request_idx
      WHERE ${eligibleWhere}
      ORDER BY received_at DESC,id DESC
      LIMIT ?
    `).all(normalizedSrnumber, normalizedLimit(limit)).map(row => ({
      id: Number(row.id),
      event_kind: textOrNull(row.event_kind),
      agency_name: textOrNull(row.agency_name),
      agency_acronym: textOrNull(row.agency_acronym),
      request_type: textOrNull(row.request_type),
      request_subtype: textOrNull(row.request_subtype),
      response_text: textOrNull(row.response_text),
      next_update_text: textOrNull(row.next_update_text),
      received_at: textOrNull(row.received_at),
      closure_wake_queued: Boolean(row.closure_wake_queued)
    }));

    return result;
  } finally {
    if (database) database.close();
  }
}

module.exports = {
  MAX_NEXT_UPDATE_TEXT,
  MAX_RESPONSE_TEXT,
  readRequestEmailUpdates
};
