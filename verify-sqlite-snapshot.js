#!/usr/bin/env node
'use strict';

const { verifySnapshot } = require('./sqlite-snapshot');

function usage() {
  return 'Usage: node verify-sqlite-snapshot.js SNAPSHOT.sqlite [SNAPSHOT.sqlite.manifest.json]';
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (argv.length < 1 || argv.length > 2) throw new Error(usage());
  const result = await verifySnapshot({ databasePath: argv[0], manifestPath: argv[1] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, usage };
