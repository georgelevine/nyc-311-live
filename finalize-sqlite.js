#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
  BUSY_TIMEOUT_MS,
  finalizeDatabase,
  resolveDatabasePath
} = require('./sqlite-finalization');

function usage() {
  return `Usage: node finalize-sqlite.js [database.sqlite] [options]

Options:
  --db PATH          Explicit source database (overrides SQLITE_PATH)
  --backup PATH      Finalized-copy destination; must not already exist
  --busy-timeout MS  SQLite lock wait (default ${BUSY_TIMEOUT_MS})
  --verify-only      Run health, migration, and repair-candidate checks only
  --dry-run          Show migrations/repairs/backup that would run, without writes
  --help             Show this help

With no path, SQLITE_PATH is used; on macOS the fallback is the app's Application
Support database. Finalization opens the supplied database read-only, performs
all mutations on a private copy, and atomically publishes the verified destination.
The tool refuses a missing file or unknown SQLite application_id and never
overwrites an existing destination or partial artifact.`;
}

function parseArguments(argv) {
  const options = {
    cliPath: null,
    backupPath: null,
    verifyOnly: false,
    dryRun: false,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--verify-only') options.verifyOnly = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--db' || argument === '--backup' || argument === '--busy-timeout') {
      const value = argv[++index];
      if (value == null) throw new Error(`${argument} requires a value`);
      if (argument === '--db') options.cliPath = value;
      else if (argument === '--backup') options.backupPath = value;
      else {
        options.busyTimeoutMs = Number(value);
        if (!Number.isInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 0) {
          throw new Error('--busy-timeout must be a nonnegative integer');
        }
      }
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (options.cliPath) {
      throw new Error('Provide only one database path');
    } else {
      options.cliPath = argument;
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const databasePath = resolveDatabasePath({ cliPath: options.cliPath });
  if (!fs.existsSync(databasePath)) throw new Error(`SQLite database does not exist: ${databasePath}`);
  const result = await finalizeDatabase({
    databasePath,
    backupPath: options.backupPath,
    verifyOnly: options.verifyOnly,
    dryRun: options.dryRun,
    busyTimeoutMs: options.busyTimeoutMs
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments, usage };
