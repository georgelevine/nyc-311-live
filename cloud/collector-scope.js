'use strict';

function parseLegacyCollectorScope(environment = process.env) {
  const scope = String(environment && environment.COLLECTOR_SCOPE || '')
    .trim()
    .toLowerCase();
  if (!scope) {
    throw new Error(
      'COLLECTOR_SCOPE must be explicitly set to citywide for the legacy PostgreSQL worker'
    );
  }
  if (scope === 'bid_only') {
    throw new Error(
      'COLLECTOR_SCOPE=bid_only is supported by the SQLite/Lightsail collector only; '
      + 'the legacy PostgreSQL worker will not fall back to citywide collection'
    );
  }
  if (scope !== 'citywide') {
    throw new Error('COLLECTOR_SCOPE must be citywide for the legacy PostgreSQL worker');
  }
  return scope;
}

module.exports = { parseLegacyCollectorScope };
