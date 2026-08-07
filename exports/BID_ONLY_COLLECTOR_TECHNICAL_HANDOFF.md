# BID-Only NYC 311 Collector: Technical Handoff

Generated: 2026-08-06  
Implementation status updated: 2026-08-07

Repository: `/Users/georgelevine/nyc-bid-311`

> **Current status:** The implementation is complete and BID-only is now the
> default for the supported SQLite collector, web service, inbound email path,
> desktop app, and Lightsail deployment. Fresh BID archives automatically
> install the pinned 78-feature boundary release. `COLLECTOR_SCOPE=citywide` is
> retained only as an explicit rollback setting. The remaining sections record
> the original implementation handoff and may describe the earlier opt-in plan.

## Objective

Add an opt-in collector mode that retrieves and stores only NYC 311 Portal
requests whose Portal-supplied coordinates fall inside at least one official
Business Improvement District (BID) polygon.

The result must preserve overlapping BID memberships, avoid citywide request
number auditing, and never use a rectangular query area as proof of BID
membership.

## Implementation Status

There are two collectors in this repository:

1. `scripts/export-sr-bids.js` is a batch, date-range BID exporter. It already
   performs BID-only spatial filtering correctly.
2. `live-311.js` is the continuous SQLite collector. It now supports the
   opt-in `COLLECTOR_SCOPE=bid_only` implementation specified in this handoff;
   `citywide` remains the unchanged default.

The SQLite/Lightsail production path supports the same BID-only behavior. The
legacy PostgreSQL `cloud/worker.js` path explicitly rejects `bid_only` and will
not silently fall back to citywide collection.

The code and tests are implemented locally as of 2026-08-06. They have not been
deployed merely by editing this repository; production remains on its configured
scope until an explicit service deployment and environment change.

## Existing Source of Truth

Use the pinned boundary release already in the repository:

- GeoJSON: `exports/nyc-bid-boundaries-2026-04-28.geojson`
- Public copy: `public/data/nyc-bid-boundaries-2026-04-28.geojson`
- Manifest: `exports/nyc-bid-boundaries-2026-04-28.manifest.json`
- Boundary version: `2026-04-28`
- CRS: `EPSG:4326`
- Coordinate order: longitude, latitude
- Features: 78
- Export SHA-256:
  `c8c06c9ecb8b733aa829c9907e918e153c9a4230fa796d228ad3f27042208a9f`

The boundary file contains 73 `Polygon` and 5 `MultiPolygon` features. It is
valid for a request to match more than one BID.

Install this release into a SQLite collector database with:

```bash
npm run bids:import -- \
  --file exports/nyc-bid-boundaries-2026-04-28.geojson
```

In BID-only mode, collector startup must fail closed if there is no complete,
active BID boundary release. It must not silently fall back to citywide
collection.

## Existing Correct Batch Algorithm

`scripts/export-sr-bids.js` is the reference implementation for spatial
retrieval and exact membership filtering.

For every official BID feature it:

1. Calculates the feature's minimum bounding rectangle with `featureBbox()`.
2. Calls the Portal map endpoint with that rectangle and the requested dates.
3. Recursively splits date ranges when the Portal returns its 100-record cap.
4. Spatially subdivides a capped single-day rectangle.
5. Uses Portal problem-area and problem filters for pathological same-coordinate
   caps that spatial subdivision cannot resolve.
6. Deduplicates Portal pins.
7. Applies `featureContainsPoint()` to the exact `Polygon` or `MultiPolygon`.
8. Writes only points inside the feature.

Relevant code:

- `scripts/export-sr-bids.js`: `featureBbox()`
- `scripts/export-sr-bids.js`: `featureContainsPoint()`
- `scripts/export-sr-bids.js`: `collectRange()` and `collectTile()`
- `scripts/export-sr-bids.js`: exact filter inside `exportBid()`

The bounding rectangle is only a retrieval optimization. Portal results inside
the rectangle but outside the polygon are discarded locally.

## Continuous Collector Scope Behavior

In the default `citywide` scope, `live-311.js` does the following:

1. `fetchLatest()` calls
   `https://portal.311.nyc.gov/entity-pin-fetch-service-requests/` without a
   geographic filter.
2. `savePoll()` iterates over the citywide records.
3. `businessImprovementDistrictMatcher.match(latitude, longitude)` calculates
   zero or more BID memberships.
4. Every map record is upserted, including records with no BID membership.
5. Sequential SR suffix gaps are inserted into `live_number_queue` and later
   fetched through the Portal detail pages.

The suffix-gap audit is intentionally citywide. Leaving it enabled in BID-only
mode would reintroduce non-BID requests even if map polling were geographically
filtered.

In `bid_only`, the collector instead runs the query-zone plan, applies exact
polygon admission before persistence, scopes downstream work to admitted rows,
and never advances or runs the citywide suffix-gap audit.

## Target Invariants

The BID-only collector must maintain all of these invariants:

1. A request is persisted only if it has finite Portal latitude and longitude
   and exactly matches one or more active BID polygons.
2. One SR number has one row in `live_portal_requests`.
3. An overlapping request has one membership row per matched BID in
   `live_request_bid_memberships`.
4. Results duplicated across query areas are counted and stored once by SR
   number.
5. The active boundary version is saved on both the request assignment and each
   membership.
6. Rectangular query membership is never treated as BID membership.
7. Missing coordinates are not geocoded, fabricated, or inferred from an
   address.
8. Citywide SR suffix-gap auditing is disabled in BID-only mode.
9. Detail hydration, closure tracking, and email subscriptions operate only on
   requests already admitted by the BID spatial filter.
10. A failed or incomplete geographic poll does not advance its success
    watermark.

## Recommended Configuration

Introduce an explicit scope instead of changing the existing default:

```env
COLLECTOR_SCOPE=bid_only
BID_POLL_INTERVAL_SECONDS=60
BID_QUERY_CONCURRENCY=3
BID_QUERY_ZONE_TARGET=12
BID_CATCHUP_MAX_DAYS=2
```

Supported values should be:

- `citywide`: existing behavior and backward-compatible default
- `bid_only`: the behavior specified in this document

Log the selected scope, boundary version, boundary hash, query-zone count, and
query-plan hash at startup. Also save them in `live_monitor_state`.

## Query-Zone Plan

Do not issue 78 Portal requests every 15 seconds. Build a smaller deterministic
set of rectangular retrieval zones from the 78 BID bounding rectangles.

Recommended zone-builder behavior:

1. Start with one rectangle per BID from the active matcher rows.
2. Group only rectangles from the same borough initially.
3. Merge intersecting or nearby rectangles when the merged rectangle does not
   add excessive empty area.
4. If the result exceeds `BID_QUERY_ZONE_TARGET`, greedily merge the pair with
   the smallest added-area cost until the target is reached.
5. Retain the contributing BID IDs on each zone for diagnostics only.
6. Verify that every BID bounding rectangle is fully covered by at least one
   final query zone.
7. Sort zones deterministically and hash the serialized plan.

The exact polygon matcher still runs against all active BIDs after retrieval.
Contributing zone IDs are not a membership shortcut.

A simpler first implementation may use one envelope per borough. It is easier
to verify but retrieves more non-BID pins. Exact polygon filtering still makes
the stored result correct.

## Steady-State Poll Algorithm

For each poll:

1. Refresh the active BID matcher before network retrieval.
2. Rebuild the zone plan if the active boundary version changed.
3. Fetch the latest Portal map pins for every query zone, with bounded
   concurrency.
4. Combine results from all zones into a `Map` keyed by normalized SR number.
5. Reject pins without an SR number or finite coordinates.
6. Call `businessImprovementDistrictMatcher.match(latitude, longitude)`.
7. Reject pins where `match.districts.length === 0`.
8. Pass only accepted pins and their computed matches to the database
   transaction.
9. Upsert one request row and replace its memberships with all matched BID IDs.
10. Queue detail hydration, closure tracking, and optional subscriptions only
    after the request has passed the exact spatial test.
11. Commit the poll and then advance each successful zone watermark.

Pseudocode:

```js
async function fetchBidOnlyPoll({ matcher, zones }) {
  const responses = await mapWithConcurrency(
    zones,
    BID_QUERY_CONCURRENCY,
    zone => fetchPortalPins(zone.bbox)
  );

  const pinsBySr = new Map();
  for (const pins of responses) {
    for (const pin of pins) {
      const normalized = normalizePin(pin);
      if (!normalized.srNumber) continue;
      if (!Number.isFinite(normalized.latitude)) continue;
      if (!Number.isFinite(normalized.longitude)) continue;
      pinsBySr.set(normalized.srNumber, normalized);
    }
  }

  const accepted = [];
  for (const pin of pinsBySr.values()) {
    const bidMatch = matcher.match(pin.latitude, pin.longitude);
    if (!bidMatch || bidMatch.districts.length === 0) continue;
    accepted.push({ pin, bidMatch });
  }
  return accepted;
}
```

Be careful with coordinate order:

- GeoJSON geometry helpers use `(longitude, latitude)`.
- `BusinessImprovementDistrictMatcher.match()` currently accepts
  `(latitude, longitude)`.

## Portal Cap and Recovery

The Portal map endpoint has a 100-record response cap. A steady-state query is
safe only while fewer than 100 unseen pins can accumulate in a zone between
successful polls.

Maintain a success watermark for every query zone. If a zone returns 100
records and all or nearly all are newer than its previous watermark, treat the
zone as potentially saturated. Do not assume the response is complete.

Recovery should reuse or extract the proven logic from
`scripts/export-sr-bids.js`:

1. Query the affected local date range.
2. Split multi-day ranges recursively when capped.
3. Split capped single-day rectangles spatially.
4. Fall back to Portal problem-area and problem filters if spatial subdivision
   remains capped at one coordinate.
5. Deduplicate by SR number.
6. Apply exact BID polygon matching before persistence.

If recovery remains capped or fails, record a failed poll and preserve the old
watermark. Surface this state in health output.

## Database Behavior

Reuse these existing tables:

- `live_portal_requests`
- `business_improvement_district_boundary_versions`
- `business_improvement_districts`
- `live_request_bid_memberships`
- `live_request_bid_assignment_versions`
- `live_detail_queue`
- status and closure tracking tables

Add a small zone-state table through the normal SQLite migration path:

```sql
CREATE TABLE bid_collector_zone_state (
  boundary_version TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  bbox_json TEXT NOT NULL CHECK(json_valid(bbox_json)),
  last_successful_poll_at TEXT,
  last_result_count INTEGER,
  saturation_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (boundary_version, plan_hash, zone_id)
);
```

The exact schema can be adjusted to local migration conventions, but zone
watermarks must not share the citywide `live_frontier` state.

### Existing Database Warning

Enabling BID-only mode does not automatically delete historical non-BID rows
from an existing citywide database. Prefer a separate database path for a clean
BID-only deployment:

```env
DATABASE_PATH=/absolute/path/to/bid-only-portal-archive.sqlite
```

If an existing mixed database must be reused, all detail, follow-up,
subscription, and dashboard queries need explicit active BID membership scope.
Do not delete old data as part of enabling the mode unless separately requested.

## Disable Citywide Audit in BID-Only Mode

In `live-311.js`, BID-only mode must not:

- advance `live_frontier`
- generate integer suffix ranges
- enqueue missing suffixes into `live_number_queue`
- run `startEligibleAudit()`
- promote citywide audit discoveries at startup
- seed detail work from non-BID archive rows

This is not merely a performance optimization. A request number contains no
geographic information, so a detail lookup by SR number cannot establish BID
membership without a Portal coordinate.

Health and UI wording must report that number-audit completeness is not
applicable in BID-only mode, rather than reporting it as complete.

## Status and Closure Tracking

Once a request has been admitted by the BID spatial filter, keep the existing
detail hydration, status history, closure follow-up, and email subscription
logic. These later requests may use the stored Portal ID or SR number because
the request's BID membership was already established from its Portal map
coordinate.

Do not require a request to continue appearing in the map feed to remain in the
archive. Closed or otherwise removed map pins must be retained and updated by
the existing monitoring mechanisms.

## Suggested Code Organization

Avoid embedding all new behavior directly in `live-311.js`. Extract testable
functions into a module such as `bid-collector-scope.js`:

```text
bid-collector-scope.js
  parseCollectorScope(env)
  buildBidQueryZones(districts, options)
  verifyZoneCoverage(districts, zones)
  queryPlanHash(boundaryVersion, zones)
  deduplicatePortalPins(pins)
  filterPinsToBids(pins, matcher)
  zoneNeedsCatchup(result, priorState)
```

Then update:

- `live-311.js` for local polling and audit branching
- `cloud/portal.js` to accept a bounding rectangle
- `cloud/worker.js` for cloud polling and audit branching
- `server.js` and cloud health endpoints to expose collector scope
- `README.md` and `.env.cloud.example` with configuration and limitations

Keep local and cloud behavior in parity. If only one runtime is implemented in
the first change, state that limitation explicitly and fail deployment checks
for the unsupported runtime.

## Tests Required

Add focused unit tests covering:

1. All 78 BID rectangles are covered by the generated zone plan.
2. Zone generation is deterministic regardless of input feature order.
3. A point inside one BID is accepted with one membership.
4. A point in overlapping BIDs is stored once with multiple memberships.
5. A point inside a query rectangle but outside every polygon is rejected.
6. A point in a polygon hole is rejected.
7. `MultiPolygon` membership works.
8. A point exactly on a polygon edge follows the existing `geometryCovers`
   behavior.
9. Pins duplicated across zones are deduplicated by SR number.
10. Missing or invalid coordinates are rejected.
11. BID-only mode fails startup without an active boundary release.
12. BID-only mode does not update `live_frontier` or enqueue suffix gaps.
13. Detail work is queued only after exact BID acceptance.
14. A saturated zone triggers catch-up and does not advance its watermark on
    failure.
15. Citywide mode remains behaviorally unchanged.

Integration-test a single poll against a temporary database. Assertions should
verify that every stored request has at least one membership for the active
boundary version.

Useful invariant query:

```sql
SELECT COUNT(*) AS invalid_rows
FROM live_portal_requests AS request
WHERE NOT EXISTS (
  SELECT 1
  FROM live_request_bid_memberships AS membership
  WHERE membership.srnumber = request.srnumber
    AND membership.boundary_version =
      request.business_improvement_district_boundary_version
);
```

For a clean BID-only database, `invalid_rows` must be zero.

## Operational Runbook

1. Use a new database path for the BID-only collector.
2. Import the pinned BID boundary release into that database.
3. Run database verification.
4. Start with `COLLECTOR_SCOPE=bid_only` and a finite
   `LIVE_DURATION_SECONDS` smoke test.
5. Confirm startup logs show 78 features, the expected boundary version, and a
   nonzero query-zone count.
6. Confirm the first poll stores only requests with memberships.
7. Confirm `live_number_queue` remains empty in the clean database.
8. Confirm detail hydration processes admitted BID requests.
9. Run the full test suite.
10. Only then start the continuous service and deploy the collector change.

Example smoke-test shape after implementation:

```bash
COLLECTOR_SCOPE=bid_only \
DATABASE_PATH=/tmp/nyc-bid-311-smoke.sqlite \
LIVE_DURATION_SECONDS=75 \
BID_POLL_INTERVAL_SECONDS=60 \
npm run live:monitor
```

The boundary import must be run against the same temporary database before this
command.

## Acceptance Criteria

The implementation is complete only when:

- Every newly stored map request has at least one active BID membership.
- Overlapping memberships do not duplicate the request row or citywide totals.
- Non-BID points returned by a query rectangle are discarded before database
  insertion and downstream work queues.
- Citywide suffix auditing is inactive in BID-only mode.
- Zone saturation and catch-up failures are visible in health output.
- Boundary version and query-plan provenance are recorded.
- Existing citywide mode tests still pass.
- Local and supported production collector paths behave consistently.

## Things Not To Do

- Do not use one outer hull around all BID parcels as the membership boundary.
- Do not use the query rectangle as the membership boundary.
- Do not query each of 78 BIDs every 15 seconds without a rate budget.
- Do not count overlapping BID memberships as separate service requests in
  citywide totals.
- Do not run the sequential SR audit in BID-only mode.
- Do not infer coordinates from an address.
- Do not silently collect citywide records when boundaries are unavailable.
- Do not purge existing non-BID records during a mode switch without explicit
  approval and a verified backup.

## Ready-To-Paste Prompt For Another Chat

```text
Implement the BID-only continuous collector described in
exports/BID_ONLY_COLLECTOR_TECHNICAL_HANDOFF.md.

Read the repository before editing. Preserve citywide mode as the default and
add COLLECTOR_SCOPE=bid_only as an opt-in mode. Use the pinned active BID
polygons for exact point membership, deduplicate by SR number, preserve multiple
BID memberships, and disable citywide suffix-gap auditing in BID-only mode.
Fail closed if the active BID boundary release is missing. Add unit and temporary
database integration tests, update local/cloud parity or clearly limit the
supported runtime, run the full test suite, and report the exact files changed.
Do not purge existing database rows and do not deploy until explicitly asked.
```
