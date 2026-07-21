ALTER TABLE live_portal_requests
  ADD COLUMN IF NOT EXISTS borough TEXT,
  ADD COLUMN IF NOT EXISTS incident_zip TEXT;

UPDATE live_portal_requests
SET borough = CASE UPPER(SUBSTRING(address FROM
      ',[[:space:]]*(BRONX|BROOKLYN|MANHATTAN|QUEENS|STATEN IS|STATEN ISLAND)([[:space:]]*\([^)]*\))?,[[:space:]]*NY,'))
    WHEN 'BRONX' THEN 'Bronx'
    WHEN 'BROOKLYN' THEN 'Brooklyn'
    WHEN 'MANHATTAN' THEN 'Manhattan'
    WHEN 'QUEENS' THEN 'Queens'
    WHEN 'STATEN IS' THEN 'Staten Island'
    WHEN 'STATEN ISLAND' THEN 'Staten Island'
    ELSE borough
  END,
  incident_zip = COALESCE(
    SUBSTRING(address FROM ',[[:space:]]*NY,[[:space:]]*([0-9]{5})(-[0-9]{4})?[[:space:]]*$'),
    incident_zip
  )
WHERE address IS NOT NULL AND (borough IS NULL OR incident_zip IS NULL);

CREATE INDEX IF NOT EXISTS live_portal_requests_borough_idx
  ON live_portal_requests (borough);
CREATE INDEX IF NOT EXISTS live_portal_requests_incident_zip_idx
  ON live_portal_requests (incident_zip);
