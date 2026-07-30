# NYC 311 Live

NYC 311 Live is a local-first collector and monitoring dashboard for public
NYC311 service requests. It captures the Portal's live map feed, audits missing
request numbers, stores public request details in SQLite, follows requests until
closure, and displays the archive in a macOS dashboard with a live map.

## What it stores

- Public request number, status, problem, address, and Portal timestamps
- Portal-provided coordinates when they are available
- A coordinate-derived NYPD precinct and the exact DCP boundary release used
- Zero or more coordinate-derived Business Improvement District memberships
  and the exact NYC Maps boundary snapshot used
- Status history, scheduled follow-ups, and closure snapshots
- Per-request NYC311 Submitted, Updated, and Closed subscription emails,
  including parsed agency routing and response text
- Audit-only requests that do not appear in the Portal's map feed

The live database is intentionally excluded from Git. It remains on the Mac at:

```text
~/Library/Application Support/nyc-bid-311/portal-archive.sqlite
```

## Local development

Requirements: macOS and Node.js 22.

```bash
npm install
npm test
npm run desktop
```

Build the standalone Mac application with:

```bash
npm run desktop:package
```

## Important scripts

- `npm run live:monitor` — run the local Portal collector
- `npm run precincts:import` — install the pinned official precinct boundaries and backfill coordinates
- `npm run bids:import` — install the pinned official BID polygons and backfill memberships
- `npm run db:verify` — verify the SQLite archive without changing it
- `npm run db:finalize` — create a verified migration-ready SQLite backup
- `npm run db:backup` — create a non-mutating verified routine SQLite backup
  with one copy, one integrity pass, one hash pass, and manifest-only nightly
  retention checks for unchanged older backups
- `npm run db:verify-snapshot` — verify a transferred snapshot and its manifest
- `npm run cloud:migrate` — apply the PostgreSQL/PostGIS cloud schema
- `npm run cloud:import` — import the finalized SQLite archive
- `npm run cloud:web` — run the cloud dashboard service
- `npm run cloud:worker` — run the cloud collector and monitoring worker

## Cloud deployment

The recommended first deployment keeps SQLite on a single inexpensive Lightsail
instance. See [LIGHTSAIL_SQLITE_DEPLOYMENT.md](LIGHTSAIL_SQLITE_DEPLOYMENT.md).
The later PostgreSQL/PostGIS path remains in [AWS_DEPLOYMENT.md](AWS_DEPLOYMENT.md),
and [CLOUD_DEPLOYMENT.md](CLOUD_DEPLOYMENT.md) covers managed PostgreSQL/Render.

Copy an example environment file and supply real credentials outside Git. Never
commit `.env` files, database files, passwords, private keys, or cloud secrets.

## Read-only live statistics

`GET /api/live-summary` returns the same deterministic statistics shown in the
dashboard. It does not call an AI service. The newest and preceding 15-minute
windows use Portal map-feed discoveries only and are explicitly marked
provisional. A separate delayed window combines map and request-number-audit
discoveries without claiming the audit is complete. The response also reports
collector freshness, archive time coverage, missing submitted times, request
type and borough distributions, and detail/map-pin coverage.

`GET /api/email-metrics` reports accepted and usable NYC311 emails, subscription
queue state, measured closure-email coverage, and observed response-time
distributions by agency and complaint type. Update time and Portal closure time
are reported separately from email-notification delay; these are observational
archive statistics, not official agency service levels.

`GET /api/police-precincts` lists the active precinct release. Add
`police_precinct=NUMBER` to `/api/live-dashboard`, `/api/live-map`, or
`/api/live-summary` to scope those results to one precinct. The selected
precinct's complete GeoJSON feature is available from
`GET /api/police-precincts/NUMBER/geometry`.

`GET /api/business-improvement-districts` lists the active BID release. Add
`bid_id=NUMBER` to the same live endpoints to scope results to a BID. Precinct
and BID parameters may be combined; their intersection is returned. The
selected district's complete GeoJSON feature is available from
`GET /api/business-improvement-districts/NUMBER/geometry`.

## Data-source note

Coordinates are stored only when supplied by the NYC311 Portal. Audit-recovered
requests without Portal coordinates remain in the archive and incoming feed but
are not assigned derived or fabricated map positions. Precincts are derived
locally by matching those coordinates to the versioned official NYC Department
of City Planning [police-precinct boundary dataset](https://www.nyc.gov/content/planning/pages/resources/datasets/police-precincts);
the polygons live in related tables while the matched precinct and boundary
version live on each request.

Business Improvement Districts are derived from the official NYC Maps
[Business Improvement District layer](https://www.arcgis.com/home/item.html?id=423ffb8f85e643e98c386601189523cb).
The imported GeoJSON bytes and SHA-256 are pinned because the ArcGIS endpoint is
mutable. BID polygons can overlap, so memberships live in a related table and a
request may correctly belong to multiple BIDs. A current boundary version and
match timestamp with no membership means the coordinate was checked and lies
outside every BID.

The collector loads the active boundary release at startup. For a boundary
update, stop the collector, run `npm run precincts:import`, and then restart the
collector so newly arriving requests use the activated release.

The BID matcher is also loaded at collector startup. Stop the collector, run
`npm run bids:import`, and restart it when installing a new pinned BID release.
