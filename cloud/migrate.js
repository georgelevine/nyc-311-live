const { migrate, close } = require('./db');

migrate()
  .then(result => console.log(JSON.stringify({
    schema_current: true,
    version: result.currentVersion,
    migrations_applied: result.applied,
    postgis_version: result.postgisVersion
  })))
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(close);
