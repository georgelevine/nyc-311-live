'use strict';

const BOROUGH_NAMES = Object.freeze({
  'BRONX': 'Bronx',
  'BROOKLYN': 'Brooklyn',
  'MANHATTAN': 'Manhattan',
  'QUEENS': 'Queens',
  'STATEN IS': 'Staten Island',
  'STATEN ISLAND': 'Staten Island'
});

function geographyFromPortalAddress(address) {
  const value = address == null ? '' : String(address).trim();
  if (!value) return { borough: null, incident_zip: null };

  const boroughMatch = value.match(
    /,\s*(BRONX|BROOKLYN|MANHATTAN|QUEENS|STATEN IS(?:LAND)?)(?:\s*\([^)]*\))?\s*,\s*NY\s*,/i
  );
  const zipMatch = value.match(/,\s*NY\s*,\s*(\d{5})(?:-\d{4})?\s*$/i);
  const boroughKey = boroughMatch ? boroughMatch[1].toUpperCase() : null;

  return {
    borough: boroughKey ? BOROUGH_NAMES[boroughKey] || null : null,
    incident_zip: zipMatch ? zipMatch[1] : null
  };
}

function ensureSqliteRequestGeography(database) {
  const columns = new Set(database.prepare('PRAGMA table_info(live_portal_requests)').all()
    .map(column => column.name));
  if (!columns.has('borough')) {
    database.exec('ALTER TABLE live_portal_requests ADD COLUMN borough TEXT');
  }
  if (!columns.has('incident_zip')) {
    database.exec('ALTER TABLE live_portal_requests ADD COLUMN incident_zip TEXT');
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS live_portal_requests_borough_idx
      ON live_portal_requests(borough);
    CREATE INDEX IF NOT EXISTS live_portal_requests_incident_zip_idx
      ON live_portal_requests(incident_zip);
  `);
  const update = database.prepare(`
    UPDATE live_portal_requests SET borough = ?, incident_zip = ? WHERE srnumber = ?
  `);
  let updated = 0;
  for (const row of database.prepare(`
    SELECT srnumber,address FROM live_portal_requests
    WHERE address IS NOT NULL AND (borough IS NULL OR incident_zip IS NULL)
  `).all()) {
    const geography = geographyFromPortalAddress(row.address);
    updated += Number(update.run(geography.borough, geography.incident_zip, row.srnumber).changes || 0);
  }
  return updated;
}

module.exports = { ensureSqliteRequestGeography, geographyFromPortalAddress };
