'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function timestampOrNull(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return textOrNull(value);
}

function safelyParseFields(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const fields = JSON.parse(value);
    return fields && typeof fields === 'object' && !Array.isArray(fields)
      ? fields
      : {};
  } catch {
    return {};
  }
}

function storedPortalDetailFromRow(row) {
  if (!row) return null;
  return {
    srnumber: textOrNull(row.srnumber),
    status: textOrNull(row.status),
    problem: textOrNull(row.problem),
    problemDetails: textOrNull(row.problem_details),
    additionalDetails: textOrNull(row.additional_details),
    address: textOrNull(row.address),
    nextUpdate: textOrNull(row.next_update),
    dateReported: timestampOrNull(row.date_reported),
    updatedOn: timestampOrNull(row.updated_on),
    dateClosed: timestampOrNull(row.date_closed),
    fields: safelyParseFields(row.fields_json)
  };
}

function readStoredPortalDetail(databasePath, portalId, {
  existsSync = fs.existsSync,
  openDatabase = (filename, options) => new DatabaseSync(filename, options)
} = {}) {
  const normalizedPortalId = textOrNull(portalId);
  if (!databasePath || !normalizedPortalId || !existsSync(databasePath)) return null;

  let database;
  try {
    database = openDatabase(databasePath, { readOnly: true });
    const hasTable = database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'portal_requests'
    `).get();
    if (!hasTable) return null;

    const row = database.prepare(`
      SELECT srnumber, status, problem, problem_details, additional_details,
        address, next_update, date_reported, updated_on, date_closed, fields_json
      FROM portal_requests
      WHERE portal_id = ?
      LIMIT 1
    `).get(normalizedPortalId);
    if (!row) return null;

    return storedPortalDetailFromRow(row);
  } finally {
    if (database) database.close();
  }
}

module.exports = { readStoredPortalDetail, storedPortalDetailFromRow };
