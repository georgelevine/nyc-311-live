# NYC 311 Live

NYC 311 Live is a local-first collector and monitoring dashboard for public
NYC311 service requests. It captures the Portal's live map feed, audits missing
request numbers, stores public request details in SQLite, follows requests until
closure, and displays the archive in a macOS dashboard with a live map.

## What it stores

- Public request number, status, problem, address, and Portal timestamps
- Portal-provided coordinates when they are available
- Status history, scheduled follow-ups, and closure snapshots
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
- `npm run db:verify` — verify the SQLite archive without changing it
- `npm run db:finalize` — create a verified migration-ready SQLite backup
- `npm run db:backup` — create a non-mutating verified routine SQLite backup
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

## Data-source note

Coordinates are stored only when supplied by the NYC311 Portal. Audit-recovered
requests without Portal coordinates remain in the archive and incoming feed but
are not assigned derived or fabricated map positions.
