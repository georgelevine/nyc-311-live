#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  applyMigrations,
  openDatabase
} = require('./sqlite-finalization');
const {
  createRequestAlias,
  markAliasSubscribed
} = require('./nyc311-email-aliases');

function usage() {
  return [
    'Usage:',
    '  node create-nyc311-email-alias.js 311-12345678 [--db PATH] [--domain DOMAIN]',
    '  node create-nyc311-email-alias.js --mark-subscribed ADDRESS [--db PATH]'
  ].join('\n');
}

function parseArguments(argv) {
  const options = {
    srnumber: null,
    markSubscribed: null,
    databasePath: process.env.DATABASE_PATH
      ? path.resolve(process.env.DATABASE_PATH)
      : path.join(__dirname, 'data', 'portal-archive.sqlite'),
    domain: process.env.INBOUND_EMAIL_DOMAIN || undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') {
      options.databasePath = path.resolve(argv[++index] || '');
    } else if (value === '--domain') {
      options.domain = argv[++index];
    } else if (value === '--mark-subscribed') {
      options.markSubscribed = argv[++index];
    } else if (!value.startsWith('-') && !options.srnumber) {
      options.srnumber = value;
    } else {
      throw new Error(`Unknown or incomplete argument: ${value}`);
    }
  }
  if (options.markSubscribed && options.srnumber) {
    throw new Error('Choose either alias creation or --mark-subscribed');
  }
  if (!options.markSubscribed && !options.srnumber) throw new Error(usage());
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const database = openDatabase(options.databasePath);
  try {
    applyMigrations(database);
    const result = options.markSubscribed
      ? markAliasSubscribed(database, options.markSubscribed)
      : createRequestAlias(database, {
          srnumber: options.srnumber,
          domain: options.domain
        });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    database.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArguments,
  usage
};
