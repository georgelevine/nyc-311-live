'use strict';

const ACTIVE_PRECINCT_VERSION_SQL = `
  SELECT version
  FROM police_precinct_boundary_versions
  WHERE active=1
  LIMIT 1
`;

const ACTIVE_BID_VERSION_SQL = `
  SELECT version
  FROM business_improvement_district_boundary_versions
  WHERE active=1
  LIMIT 1
`;

function matcherVersion(matcher) {
  return matcher && matcher.version != null ? String(matcher.version) : null;
}

function activeVersion(database, sql) {
  const row = database.prepare(sql).get();
  return row && row.version != null ? String(row.version) : null;
}

function refreshedMatcher(database, {
  active,
  current,
  label,
  load
}) {
  if (matcherVersion(current) === active) {
    return { matcher: current, reloaded: false };
  }
  const matcher = load(database);
  const loaded = matcherVersion(matcher);
  if (loaded !== active) {
    throw new Error(
      `Active ${label} boundary changed while its matcher was loading `
      + `(expected ${active || 'none'}, loaded ${loaded || 'none'})`
    );
  }
  return { matcher, reloaded: true };
}

function refreshActiveBoundaryMatchers(database, current, loaders) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('database is required');
  }
  if (!current || !loaders
      || typeof loaders.loadPolicePrecinctMatcher !== 'function'
      || typeof loaders.loadBusinessImprovementDistrictMatcher !== 'function') {
    throw new TypeError('current matchers and matcher loaders are required');
  }

  const activeVersions = {
    policePrecinct: activeVersion(database, ACTIVE_PRECINCT_VERSION_SQL),
    businessImprovementDistrict: activeVersion(database, ACTIVE_BID_VERSION_SQL)
  };
  const policePrecinct = refreshedMatcher(database, {
    active: activeVersions.policePrecinct,
    current: current.policePrecinctMatcher,
    label: 'police precinct',
    load: loaders.loadPolicePrecinctMatcher
  });
  const businessImprovementDistrict = refreshedMatcher(database, {
    active: activeVersions.businessImprovementDistrict,
    current: current.businessImprovementDistrictMatcher,
    label: 'business improvement district',
    load: loaders.loadBusinessImprovementDistrictMatcher
  });

  return {
    policePrecinctMatcher: policePrecinct.matcher,
    businessImprovementDistrictMatcher: businessImprovementDistrict.matcher,
    activeVersions,
    reloaded: {
      policePrecinct: policePrecinct.reloaded,
      businessImprovementDistrict: businessImprovementDistrict.reloaded
    }
  };
}

module.exports = {
  ACTIVE_BID_VERSION_SQL,
  ACTIVE_PRECINCT_VERSION_SQL,
  matcherVersion,
  refreshActiveBoundaryMatchers
};
