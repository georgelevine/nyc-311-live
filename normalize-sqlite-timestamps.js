#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { normalizePortalTimestamp } = require('./portal-timestamp');

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

const TIMESTAMP_TARGETS = Object.freeze([
  Object.freeze({ table: 'live_portal_requests', column: 'submitted_at' }),
  Object.freeze({ table: 'portal_requests', column: 'date_reported' }),
  Object.freeze({ table: 'portal_requests', column: 'updated_on' }),
  Object.freeze({ table: 'portal_requests', column: 'date_closed' }),
  Object.freeze({ table: 'request_status_history', column: 'effective_at' }),
  Object.freeze({ table: 'request_closure_snapshots', column: 'date_closed' })
]);

class TimestampRepairError extends Error {
  constructor(message, report = null) {
    super(message);
    this.name = 'TimestampRepairError';
    this.report = report;
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function tableExists(database, table) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table));
}

function tableColumns(database, table) {
  return new Set(database.prepare(
    `PRAGMA table_info(${quoteIdentifier(table)})`
  ).all().map(row => row.name));
}

function quickCheck(database) {
  const messages = database.prepare('PRAGMA quick_check').all()
    .map(row => String(Object.values(row)[0]));
  return {
    ok: messages.length === 1 && messages[0] === 'ok',
    messages
  };
}

function inspectTimestampRepairs(database) {
  const changes = [];
  const invalidValues = [];
  const skippedTargets = [];
  const columns = [];
  const rowCounts = {};
  const knownTables = new Map();

  for (const target of TIMESTAMP_TARGETS) {
    if (!knownTables.has(target.table)) {
      if (!tableExists(database, target.table)) {
        knownTables.set(target.table, null);
      } else {
        const identifier = quoteIdentifier(target.table);
        const count = Number(database.prepare(
          `SELECT COUNT(*) AS count FROM ${identifier}`
        ).get().count);
        rowCounts[target.table] = count;
        knownTables.set(target.table, tableColumns(database, target.table));
      }
    }

    const availableColumns = knownTables.get(target.table);
    if (!availableColumns) {
      skippedTargets.push({ ...target, reason: 'missing_table' });
      continue;
    }
    if (!availableColumns.has(target.column)) {
      skippedTargets.push({ ...target, reason: 'missing_column' });
      continue;
    }

    const tableIdentifier = quoteIdentifier(target.table);
    const columnIdentifier = quoteIdentifier(target.column);
    const rows = database.prepare(`
      SELECT rowid AS repair_rowid, ${columnIdentifier} AS timestamp_value
      FROM ${tableIdentifier}
      WHERE ${columnIdentifier} IS NOT NULL
        AND TRIM(CAST(${columnIdentifier} AS TEXT)) <> ''
      ORDER BY rowid
    `).all();
    let canonical = 0;
    let planned = 0;
    let invalid = 0;

    for (const row of rows) {
      const normalized = normalizePortalTimestamp(row.timestamp_value);
      if (!normalized) {
        invalid += 1;
        invalidValues.push({
          table: target.table,
          column: target.column,
          rowid: row.repair_rowid,
          value: row.timestamp_value
        });
      } else if (normalized === row.timestamp_value) {
        canonical += 1;
      } else {
        planned += 1;
        changes.push({
          table: target.table,
          column: target.column,
          rowid: row.repair_rowid,
          from: row.timestamp_value,
          to: normalized
        });
      }
    }

    columns.push({
      ...target,
      table_rows: rowCounts[target.table],
      nonempty_values: rows.length,
      null_or_empty_values: rowCounts[target.table] - rows.length,
      canonical_values: canonical,
      planned_changes: planned,
      invalid_values: invalid
    });
  }

  return {
    changes,
    invalid_values: invalidValues,
    skipped_targets: skippedTargets,
    columns,
    row_counts: rowCounts,
    planned_changes: changes.length
  };
}

function sameRowCounts(before, after) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  return beforeKeys.length === afterKeys.length
    && beforeKeys.every((key, index) => key === afterKeys[index] && before[key] === after[key]);
}

function baseReport({ databasePath, apply, inspection, beforeQuickCheck }) {
  return {
    database_path: databasePath,
    mode: apply ? 'apply' : 'dry-run',
    status: apply ? 'pending' : 'dry-run',
    can_apply: inspection.invalid_values.length === 0 && beforeQuickCheck.ok,
    summary: {
      planned_changes: inspection.planned_changes,
      applied_changes: 0,
      invalid_values: inspection.invalid_values.length,
      skipped_targets: inspection.skipped_targets.length
    },
    columns: inspection.columns,
    skipped_targets: inspection.skipped_targets,
    invalid_values: inspection.invalid_values,
    row_counts: {
      before: inspection.row_counts,
      after: apply ? null : inspection.row_counts,
      unchanged: apply ? null : true
    },
    quick_check: {
      before: beforeQuickCheck,
      after: apply ? null : beforeQuickCheck
    },
    post_inspection: null
  };
}

function openDatabase(databasePath, { readOnly, busyTimeoutMs }) {
  const database = new DatabaseSync(databasePath, { readOnly });
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  return database;
}

function repairSqliteTimestamps({
  databasePath,
  apply = false,
  busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS
}) {
  const resolvedPath = path.resolve(String(databasePath || ''));
  if (!databasePath || !fs.existsSync(resolvedPath)) {
    throw new TimestampRepairError(`SQLite database does not exist: ${resolvedPath}`);
  }
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError('busyTimeoutMs must be a nonnegative integer');
  }

  const database = openDatabase(resolvedPath, { readOnly: !apply, busyTimeoutMs });
  let transactionOpen = false;
  let report = null;
  try {
    const beforeQuickCheck = quickCheck(database);
    if (!apply) {
      const inspection = inspectTimestampRepairs(database);
      return baseReport({
        databasePath: resolvedPath,
        apply,
        inspection,
        beforeQuickCheck
      });
    }

    if (!beforeQuickCheck.ok) {
      report = {
        database_path: resolvedPath,
        mode: 'apply',
        status: 'aborted',
        can_apply: false,
        summary: { planned_changes: 0, applied_changes: 0, invalid_values: 0, skipped_targets: 0 },
        columns: [],
        skipped_targets: [],
        invalid_values: [],
        row_counts: { before: {}, after: {}, unchanged: true },
        quick_check: { before: beforeQuickCheck, after: null },
        post_inspection: null
      };
      throw new TimestampRepairError('Pre-repair PRAGMA quick_check failed', report);
    }

    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const inspection = inspectTimestampRepairs(database);
    report = baseReport({
      databasePath: resolvedPath,
      apply,
      inspection,
      beforeQuickCheck
    });

    if (inspection.invalid_values.length) {
      report.status = 'aborted';
      report.can_apply = false;
      report.row_counts.after = inspection.row_counts;
      report.row_counts.unchanged = true;
      throw new TimestampRepairError(
        `Refusing to apply while ${inspection.invalid_values.length} invalid nonempty timestamp value(s) remain`,
        report
      );
    }

    let actualChanges = 0;
    for (const change of inspection.changes) {
      const tableIdentifier = quoteIdentifier(change.table);
      const columnIdentifier = quoteIdentifier(change.column);
      const result = database.prepare(`
        UPDATE ${tableIdentifier}
        SET ${columnIdentifier} = ?
        WHERE rowid = ? AND ${columnIdentifier} = ?
      `).run(change.to, change.rowid, change.from);
      const changed = Number(result.changes || 0);
      if (changed !== 1) {
        throw new TimestampRepairError(
          `Conditional update mismatch for ${change.table}.${change.column} rowid ${change.rowid}: expected 1, changed ${changed}`,
          report
        );
      }
      actualChanges += changed;
    }
    if (actualChanges !== inspection.planned_changes) {
      throw new TimestampRepairError(
        `Repair count mismatch: planned ${inspection.planned_changes}, changed ${actualChanges}`,
        report
      );
    }

    const postInspection = inspectTimestampRepairs(database);
    const afterQuickCheck = quickCheck(database);
    const rowCountsUnchanged = sameRowCounts(inspection.row_counts, postInspection.row_counts);
    report.quick_check.after = afterQuickCheck;
    report.row_counts.after = postInspection.row_counts;
    report.row_counts.unchanged = rowCountsUnchanged;
    report.post_inspection = {
      planned_changes: postInspection.planned_changes,
      invalid_values: postInspection.invalid_values.length
    };

    if (!rowCountsUnchanged) {
      throw new TimestampRepairError('Target-table row counts changed during timestamp repair', report);
    }
    if (postInspection.planned_changes !== 0 || postInspection.invalid_values.length !== 0) {
      throw new TimestampRepairError('Post-repair inspection did not converge to zero pending changes', report);
    }
    if (!afterQuickCheck.ok) {
      throw new TimestampRepairError('Post-repair PRAGMA quick_check failed', report);
    }

    database.exec('COMMIT');
    transactionOpen = false;
    report.status = 'applied';
    report.summary.applied_changes = actualChanges;
    return report;
  } catch (error) {
    if (transactionOpen) {
      database.exec('ROLLBACK');
      transactionOpen = false;
    }
    if (report) {
      report.status = 'aborted';
      report.summary.applied_changes = 0;
    }
    if (error instanceof TimestampRepairError) {
      if (!error.report) error.report = report;
      throw error;
    }
    throw new TimestampRepairError(error.message, report);
  } finally {
    database.close();
  }
}

function usage() {
  return `Usage: node normalize-sqlite-timestamps.js [database.sqlite] [options]

Options:
  --db PATH          Explicit SQLite database path
  --apply            Apply the inspected changes transactionally
  --dry-run          Inspect only (the default)
  --busy-timeout MS  SQLite lock wait (default ${DEFAULT_BUSY_TIMEOUT_MS})
  --help             Show this help

The command is read-only unless --apply is supplied. Apply mode refuses any
invalid nonempty target timestamp, uses conditional rowid-and-old-value updates,
checks row counts, verifies a zero-change second inspection, and runs SQLite's
quick_check before committing.`;
}

function parseArguments(argv) {
  const options = {
    databasePath: null,
    apply: false,
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    help: false
  };
  let explicitDryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--dry-run') explicitDryRun = true;
    else if (argument === '--db' || argument === '--busy-timeout') {
      const value = argv[++index];
      if (value == null) throw new Error(`${argument} requires a value`);
      if (argument === '--db') options.databasePath = value;
      else {
        options.busyTimeoutMs = Number(value);
        if (!Number.isInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 0) {
          throw new Error('--busy-timeout must be a nonnegative integer');
        }
      }
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (options.databasePath) {
      throw new Error('Provide only one database path');
    } else {
      options.databasePath = argument;
    }
  }
  if (explicitDryRun && options.apply) throw new Error('Choose either --dry-run or --apply');
  return options;
}

function resolveDatabasePath(cliPath, env = process.env) {
  return path.resolve(cliPath || env.DATABASE_PATH || env.SQLITE_PATH
    || path.join(__dirname, 'data', 'portal-archive.sqlite'));
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = repairSqliteTimestamps({
    databasePath: resolveDatabasePath(options.databasePath),
    apply: options.apply,
    busyTimeoutMs: options.busyTimeoutMs
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (error && error.report) {
      process.stderr.write(`${JSON.stringify(error.report, null, 2)}\n`);
    }
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_BUSY_TIMEOUT_MS,
  TIMESTAMP_TARGETS,
  TimestampRepairError,
  inspectTimestampRepairs,
  main,
  parseArguments,
  repairSqliteTimestamps,
  resolveDatabasePath,
  usage
};
