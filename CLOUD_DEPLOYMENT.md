# NYC 311 Live cloud deployment

The cloud deployment has three persistent components:

1. `nyc-311-live-collector` polls the NYC311 Portal, hydrates submitted details,
   audits missing request numbers, and revisits requests when they close.
2. `nyc-311-live-db` is PostgreSQL with PostGIS. It is the source of truth.
3. `nyc-311-live-web` serves the live dashboard and its authenticated API.

The Mac app is not required for collection. After cutover, closing the Mac or
losing a home internet connection does not stop the archive.

## Safety properties

- The request number is the primary key, so repeated Portal polls update the
  same row instead of creating duplicates.
- A PostgreSQL advisory lock permits only one active collector.
- Database credentials remain inside Render's private network and are never
  embedded in the dashboard.
- The dashboard uses HTTPS Basic Authentication when `DASHBOARD_PASSWORD` is
  configured.
- The managed database blocks public connections by default.
- Status changes are written to `request_status_history`.
- Closed requests are requeued once so the final close time can be captured.
- Audit-only requests are included in the main cloud feed, even without map
  coordinates.

## Create the cloud environment

1. Put this repository in a private GitHub repository.
2. In Render, choose **New > Blueprint** and select the repository.
3. Render reads `render.yaml` and proposes one database, one web service, and
   one background worker.
4. Enter a long random value when Render asks for `DASHBOARD_PASSWORD`.
5. Create the Blueprint and wait until both services are healthy.
6. Open the web service's `onrender.com` URL and sign in as `admin`.

The Blueprint deliberately uses paid starter services and a paid PostgreSQL
plan. A temporary database that expires is not appropriate for this archive.

## Import the existing Mac archive

The database is private by default. For the one-time import:

1. In Render, temporarily add your current public IP to the PostgreSQL inbound
   rules.
2. Copy the database's **external** connection URL from its Connect menu.
3. Quit NYC 311 Live briefly so the final local snapshot stops changing.
4. From this project directory, run:

   ```bash
   DATABASE_URL='the-external-render-url' \
   PGSSLMODE=require \
   SQLITE_PATH="$HOME/Library/Application Support/nyc-bid-311/portal-archive.sqlite" \
   npm run cloud:import
   ```

5. Compare the cloud dashboard's Captured and Details counts with the local
   app.
6. Remove the temporary database inbound rule.
7. Leave the local file untouched as a recovery copy.

The importer is idempotent: it can be run again without creating duplicates.

## Operations

- `/api/health` reports database connectivity and whether the collector has
  completed a successful poll in the last two minutes.
- Render runs `npm run cloud:migrate` before web deployments.
- PostgreSQL/PostGIS provides durable concurrent reads and writes, spatial
  indexes, and a clean path to read replicas later.
- Keep Render's managed backups enabled. Periodically download a logical
  backup to a second provider as an additional recovery copy.

## Remaining account-level handoff

Creating the actual services requires authorization to the chosen Render and
GitHub accounts. No cloud resources are created merely by committing
`render.yaml`; Render shows the proposed paid resources before creation.
