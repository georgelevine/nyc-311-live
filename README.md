# NYC BID 311 Live

NYC BID 311 Live is a local-first collector and monitoring dashboard for public
NYC311 service requests. Its default BID-only scope captures only exact Business
Improvement District polygon matches. An explicit citywide rollback scope keeps
the Portal's live map feed and missing-request-number audit available. Both
scopes store public request details in SQLite, follow admitted requests until
closure, and display the archive in a dashboard with a live map.

## What it stores

- Public request number, status, problem, address, and Portal timestamps
- Portal-provided coordinates when they are available
- A coordinate-derived NYPD precinct and the exact DCP boundary release used
- Zero or more coordinate-derived Business Improvement District memberships
  and the exact NYC Maps boundary snapshot used
- Status history, scheduled follow-ups, and closure snapshots
- Per-request NYC311 Submitted, Updated, and Closed subscription emails,
  including parsed agency routing and response text
- In citywide mode, audit-only requests that do not appear in the Portal's map
  feed

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

The desktop entry point defaults to BID-only. On a new archive, the collector
installs the tracked, checksummed 78-feature boundary bundle before its first
Portal poll. A missing, modified, or incomplete release fails closed. Set
`COLLECTOR_SCOPE=citywide` only for an explicit rollback launch.

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
  with SQLite's cooperative online-backup API, one integrity pass, one hash pass,
  a logical-size/WAL-aware free-space preflight, and manifest-only nightly
  retention checks for unchanged older backups. Small page batches and the
  backup container's device bandwidth cgroup preserve live dashboard access.
- `npm run db:verify-snapshot` — verify a transferred snapshot and its manifest
- `npm run cloud:migrate` — apply the PostgreSQL/PostGIS cloud schema
- `npm run cloud:import` — import the finalized SQLite archive
- `npm run cloud:web` — run the cloud dashboard service
- `npm run cloud:worker` — run the cloud collector and monitoring worker

## Collector scopes

`COLLECTOR_SCOPE=bid_only` is the default for the SQLite collector used locally
and by the current Lightsail deployment. In this mode:

- The collector queries 12 deterministic rectangular zones with bounded
  concurrency. Those rectangles are retrieval tools only.
- A request is written only when it has finite Portal coordinates and the point
  is covered by at least one polygon in the complete active 78-feature BID
  release.
- Rectangle-only matches and coordinate-less requests are discarded before any
  request, detail, closure, or subscription work is queued.
- One request can retain multiple BID memberships without being counted twice.
- The citywide SR-number frontier and gap audit are disabled and reported as
  not applicable.
- A 100-record Portal response or an offline gap enters resumable date/spatial
  recovery. Each zone has its own success watermark; a failed recovery preserves
  the prior watermark and appears in health output.
- Startup fails closed if the active BID release is missing or incomplete. It
  never falls back to citywide collection.

`COLLECTOR_SCOPE=citywide` is an explicit rollback mode. It restores the
citywide Portal map poll, SR-number frontier, and delayed suffix-gap audit; it
is never selected implicitly by the SQLite/Lightsail configuration.

Use a dedicated database for a clean BID-only archive. A mixed database is also
safe: background work and unfiltered dashboard, map, and summary reads are
automatically restricted to requests with an active BID membership, while old
citywide rows remain intact.

New BID-only archives bootstrap the pinned release automatically. To install or
repair it explicitly while the collector is stopped, target the exact database:

```bash
npm run bids:import -- \
  --db /absolute/path/to/bid-only-portal-archive.sqlite \
  --file exports/nyc-bid-boundaries-2026-04-28.geojson
```

Then run a finite smoke test:

```bash
DATABASE_PATH=/absolute/path/to/bid-only-portal-archive.sqlite \
LIVE_DURATION_SECONDS=75 \
BID_POLL_INTERVAL_SECONDS=60 \
BID_QUERY_CONCURRENCY=3 \
BID_QUERY_ZONE_TARGET=12 \
npm run live:monitor
```

To roll a stopped collector back to citywide behavior explicitly:

```bash
COLLECTOR_SCOPE=citywide \
DATABASE_PATH=/absolute/path/to/portal-archive.sqlite \
npm run live:monitor
```

The legacy PostgreSQL `cloud/worker.js` path deliberately rejects `bid_only`;
it requires an explicit `COLLECTOR_SCOPE=citywide`. Use the SQLite collector for
the default BID-only product behavior.

## Cloud deployment

The recommended first deployment keeps SQLite on a single inexpensive Lightsail
instance. See [LIGHTSAIL_SQLITE_DEPLOYMENT.md](LIGHTSAIL_SQLITE_DEPLOYMENT.md).
The later PostgreSQL/PostGIS path remains in [AWS_DEPLOYMENT.md](AWS_DEPLOYMENT.md),
and [CLOUD_DEPLOYMENT.md](CLOUD_DEPLOYMENT.md) covers managed PostgreSQL/Render.

Copy an example environment file and supply real credentials outside Git. Never
commit `.env` files, database files, passwords, private keys, or cloud secrets.

After the first Lightsail installation, use `npm run deploy`. It compares the
production release with `main` and automatically chooses the narrowest safe
path:

- `assets` for HTML, CSS, browser JavaScript, and vendor files. Static files
  switch atomically and no container restarts.
- `web` for the Express dashboard/API and its read-only presentation modules.
  Only the web container restarts; collection and email intake remain live.
- `service` for collectors, inbound email, dependencies, Docker, Caddy,
  database, or other infrastructure changes. This retains the full coordinated
  restart and fresh-poll health gate.

The explicit commands `npm run deploy:assets`, `npm run deploy:web`, and
`npm run deploy:service` remain available. Each fast path independently rejects
changes outside its permitted scope instead of silently deploying a partial
release.

On Lightsail, `DATABASE_PATH` must name a plain `.sqlite` file directly inside
`/data`. The service deployment's fresh-poll gate, snapshot installer, and
nightly verified backup all resolve that same configured file. Leaving it at
`/data/portal-archive.sqlite` is the supported mixed-archive BID-only switch:
historic citywide rows remain recoverable while BID-only reads and background
work stay scoped. A service release is accepted only after the collector records
a fresh poll with the exact configured `collector_scope`, including an explicit
citywide rollback; a failed release does not report a successful rollback until
the previous runtime records that expected scope in a new poll and becomes
healthy again.

## Read-only live statistics

`GET /api/live-summary` returns the same deterministic statistics shown in the
dashboard. It does not call an AI service. The newest and preceding 15-minute
windows use Portal map-feed discoveries only and are explicitly marked
provisional. In citywide mode, a separate delayed window combines map and
request-number-audit discoveries without claiming the audit is complete. In
BID-only mode, number auditing is not applicable. The response also reports
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

Coordinates are stored only when supplied by the NYC311 Portal. In citywide
mode, audit-recovered requests without Portal coordinates remain in the archive
and incoming feed but are not assigned derived or fabricated map positions. In
BID-only mode, a request without Portal coordinates cannot establish polygon
membership and is not admitted. Precincts are derived
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
