# Advanced AWS deployment: PostgreSQL/PostGIS

> **Not the recommended first deployment.** The current low-cost path keeps the
> verified SQLite archive on one Lightsail instance. See
> [LIGHTSAIL_SQLITE_DEPLOYMENT.md](LIGHTSAIL_SQLITE_DEPLOYMENT.md). This document
> remains as the later PostgreSQL/PostGIS migration path.

> **Preparation status, not a cutover approval:** these files package the existing
> cloud code, but they do not fix its data-parity or importer guarantees. Do not
> replace the Mac collector until the parity gates below pass against a copy of
> real data. This deployment also cannot promise that the NYC311 Portal exposes a
> complete historical record.

The recommended first AWS target is one Linux instance in Amazon Lightsail. It
runs four long-lived containers plus two on-demand tool roles with Docker Compose:

- Caddy terminates public HTTPS on ports 80 and 443.
- `web` serves the dashboard on the private Compose network.
- exactly one `worker` polls the NYC311 Portal.
- PostgreSQL 16 with PostGIS 3.5 stores data in a named Docker volume.
- `migrate` and `import` are explicit, short-lived tools and do not run normally.

This avoids a load balancer, NAT gateways, ECS, ECR, and RDS charges during the
initial proving period. It is a single-server design, so host failure causes an
outage. Off-host database backups are mandatory.

The application image still accepts one `DATABASE_URL`. Compose constructs that
URL for its private `db` service. The same image can later run in ECS with an RDS
URL supplied by Secrets Manager; the schema and application API do not need to
change merely because the database moves.

## Files

- `Dockerfile.cloud` builds one non-root Node 22 production image for all roles.
- `aws/lightsail/compose.yml` defines the runtime and role-specific health checks.
- `aws/lightsail/.env.example` is a secret-free configuration template.
- `aws/lightsail/Caddyfile` provides automatic HTTPS and reverse proxying.
- `aws/lightsail/imports/` is the ignored staging directory for one SQLite snapshot.

PostgreSQL and the web service have no host port mapping. Only Caddy publishes
ports. The absence of a `ports` entry for `db` is deliberate—do not add one, even
temporarily. The PostGIS project warns that Docker-published database ports can
bypass host firewall expectations. See the [PostGIS image documentation](https://github.com/postgis/docker-postgis).
PostgreSQL joins only an internal Docker network. Web and worker join that network
for database access and a second bridge for required Portal HTTPS egress; Caddy
joins only the second bridge and therefore cannot connect directly to PostgreSQL.

## Gates before a real cutover

All of these must be green first:

1. Prove that the PostgreSQL path preserves the local closure lifecycle: status
   source/effective time, closure snapshots, reopen cycles, and the follow-up
   queue. Schema alone is insufficient; worker and API behavior must also match.
2. Add PostgreSQL/PostGIS migration tests that apply a blank schema, upgrade an
   old schema, and apply every migration twice.
3. Add an import test using a copy of the real SQLite archive. A repeated import
   must not move the frontier backward, downgrade terminal audit outcomes, erase
   newer detail fields, or discard status/closure history.
4. Compare per-table counts and sampled request histories between SQLite and
   PostgreSQL, including open, closed, cancelled, reopened, map-only, and
   audit-only requests.
5. Exercise a worker restart and prove that the PostgreSQL advisory lock permits
   exactly one collector.
6. Exercise backup restoration into a clean Compose project.
7. Before RDS, replace the current `rejectUnauthorized: false` behavior with AWS
   RDS CA verification and separate migration/runtime database roles.

The current importer prevents duplicate primary keys, but a rerun can overwrite
newer cloud state with an older SQLite value. Until gate 3 is complete, import
only into a fresh database while the worker is stopped, and never rerun it after
collection begins.

## Prepare the Lightsail host

No AWS resources are created by this repository. In the AWS console:

1. Create a current LTS, x86-64 Linux Lightsail instance in the desired Region.
   The pinned Debian PostGIS image is published for `amd64`. Choose the smallest
   plan that passes the import and polling load test with memory and disk
   headroom; do not size solely from idle usage.
2. Attach a static IP and point a DNS `A` record such as
   `311.example.org` at it. A DNS name is required for normal public TLS.
3. In both the Lightsail IPv4 and IPv6 firewalls, allow TCP 80 and 443 from the
   internet. Allow SSH only from the administrator's current IP. Do not open
   10000 or 5432. Lightsail maintains separate IPv4 and IPv6 firewalls; see the
   [Lightsail firewall guide](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html).
4. Install Docker Engine and the Docker Compose plugin from Docker's official
   repository. Enable Docker at boot. Treat membership in the `docker` group as
   root access.
5. Use SSH keys, disable password SSH, enable unattended security updates, and
   monitor disk usage. Docker logs are capped by the Compose file, but database
   and image growth still need monitoring.
6. Put a private checkout at `/opt/nyc-311-live` and restrict who can read it.

Lightsail automatic snapshots are useful as a second recovery layer, but a
running PostgreSQL volume snapshot is not a substitute for a tested logical
database backup. Lightsail documents that instance and attached-disk snapshots
are encrypted at rest; see [Lightsail block storage](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-block-storage.html).

## Configure and start a rehearsal

Run every Compose command from the deployment directory:

```bash
cd /opt/nyc-311-live/aws/lightsail
cp .env.example .env
chmod 600 .env
```

Generate a different URL-safe value for `POSTGRES_PASSWORD` and
`DASHBOARD_PASSWORD`:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Fill the blank values in `.env`. `SITE_ADDRESS` is only the DNS name, without
`https://`. Do not put AWS keys, S3 keys, or a SQLite path in this file. Verify
that Compose can resolve the configuration without printing the resolved secrets:

```bash
docker compose config --quiet
```

Build one image, start the database, and run the migration tool once:

```bash
docker compose build --pull
docker compose up -d db
docker compose run --rm migrate
```

For an empty rehearsal database, start the long-running services:

```bash
docker compose up -d web worker proxy
docker compose ps
```

Caddy obtains and renews the public certificate automatically after DNS and
ports 80/443 are correct. Check the unauthenticated health route, then sign into
the dashboard with the configured credentials:

```bash
curl --fail --show-error https://311.example.org/api/health
```

Replace the example hostname. The web health check verifies the HTTP route and
database. The worker health check verifies its database path; collector freshness
is reported separately by `/api/health` and must be monitored. A portal outage
should trigger an alert, not a worker restart loop.

## Make and upload a consistent SQLite snapshot

These are cutover-rehearsal steps. Do not run them against the only copy of the
archive.

1. Quit the Mac application so its SQLite database stops changing.
2. Use SQLite's backup operation rather than copying the main file while a WAL
   might still contain committed data:

   ```bash
   SOURCE_DB="/Users/you/Library/Application Support/nyc-bid-311/portal-archive.sqlite"
   SNAPSHOT="portal-archive-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
   sqlite3 "$SOURCE_DB" ".backup '$SNAPSHOT'"
   sqlite3 "$SNAPSHOT" "PRAGMA quick_check;"
   shasum -a 256 "$SNAPSHOT"
   ```

   Continue only when `quick_check` prints `ok`.
3. Copy the immutable snapshot over SSH to
   `/opt/nyc-311-live/aws/lightsail/imports/` and record its SHA-256 digest:

   ```bash
   scp "$SNAPSHOT" deploy@LIGHTSAIL_STATIC_IP:/opt/nyc-311-live/aws/lightsail/imports/
   ```

4. On the server, compare the digest and restrict the file:

   ```bash
   cd /opt/nyc-311-live/aws/lightsail
   sha256sum "imports/portal-archive-YYYYMMDDTHHMMSSZ.sqlite"
   chmod 600 "imports/portal-archive-YYYYMMDDTHHMMSSZ.sqlite"
   ```

The snapshot directory is ignored by Git and mounted read-only into the import
container. Delete the server copy only after the PostgreSQL backup and validation
are complete; retain the original Mac database as a recovery copy.

## Import and validate

Never let the Mac collector and cloud worker act as the active collector during
the same cutover window. Stop the cloud-facing services before import:

```bash
cd /opt/nyc-311-live/aws/lightsail
docker compose stop proxy web worker
docker compose run --rm migrate
SQLITE_IMPORT_FILE=portal-archive-YYYYMMDDTHHMMSSZ.sqlite \
  docker compose run --rm import
```

The `tools` profile does not run during ordinary `docker compose up`; explicitly
targeting `migrate` or `import` runs the requested one-off service and its database
dependency. This follows Docker's documented [Compose profile behavior](https://docs.docker.com/compose/how-tos/profiles/).

Inspect PostgreSQL counts without exposing the database port:

```bash
docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT '\''live_portal_requests'\'' AS table_name, COUNT(*) FROM live_portal_requests
    UNION ALL SELECT '\''portal_requests'\'', COUNT(*) FROM portal_requests
    UNION ALL SELECT '\''number_ledger'\'', COUNT(*) FROM number_ledger
    UNION ALL SELECT '\''request_status_history'\'', COUNT(*) FROM request_status_history;
  "'
```

Compare these with direct SQLite counts and sample records from every lifecycle
category in the parity gates. Counts are not all expected to be identical: the
current importer promotes archived detail rows into the cloud live table. Explain
every difference rather than accepting one total count.

Only after the parity gates pass, start one cloud collector:

```bash
docker compose up -d web worker proxy
docker compose ps
docker compose logs --since=10m worker
```

Keep the Mac database untouched. If validation fails, stop `worker`, preserve the
PostgreSQL data for diagnosis, and resume the Mac application. There is no
automatic merge from PostgreSQL back to SQLite, so keep the decision window short.

## Routine operation

Useful non-destructive checks are:

```bash
docker compose ps
docker compose logs --since=30m web worker proxy db
docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT PostGIS_Full_Version();"'
```

Alert on at least these conditions:

- `/api/health` is unreachable or reports an unavailable database.
- `last_successful_poll_at` is older than the expected portal interval.
- the worker container is restarting or more than one worker is attempted.
- disk usage, database volume usage, or memory remains above an agreed threshold.
- the nightly S3 backup or periodic restore test fails.

The Compose project defines only one worker, and the application also takes a
PostgreSQL advisory lock. Never use `docker compose up --scale worker=2`.

## Encrypted off-host backups

Use a private S3 bucket with Block Public Access, default encryption, versioning,
and a lifecycle rule. For the lowest operational cost, SSE-S3 is sufficient for
encryption at rest; use a customer-managed KMS key when its added controls and
request cost are justified. Give a dedicated IAM principal write access only to
the backup prefix, keep its credentials outside `.env`, and rotate them.

Create a consistent custom-format dump with the matching PostgreSQL client in the
database container, hash it, and upload both files:

```bash
install -d -m 700 /var/backups/nyc311
backup="/var/backups/nyc311/nyc311-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
  > "$backup"
chmod 600 "$backup"
sha256sum "$backup" > "$backup.sha256"
aws s3 cp "$backup" s3://YOUR_PRIVATE_BUCKET/nyc311/ --sse AES256 --only-show-errors
aws s3 cp "$backup.sha256" s3://YOUR_PRIVATE_BUCKET/nyc311/ --sse AES256 --only-show-errors
```

Schedule this from a root-owned script and verify that a new object arrived; do
not treat a successful command exit as the only backup check. Choose retention
from the required recovery point, storage growth, and budget. A reasonable first
policy is daily dumps with longer weekly/monthly retention, adjusted after actual
archive growth is measured.

### Restore test

Never test by overwriting the live volume. Compose scopes named volumes by project,
so restore into a separate project:

```bash
cd /opt/nyc-311-live/aws/lightsail
COMPOSE_PROJECT_NAME=nyc311-restore docker compose up -d db
COMPOSE_PROJECT_NAME=nyc311-restore docker compose exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --exit-on-error' \
  < /var/backups/nyc311/nyc311-YYYYMMDDTHHMMSSZ.dump
COMPOSE_PROJECT_NAME=nyc311-restore docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT COUNT(*) FROM live_portal_requests;"'
```

Verify PostGIS, table counts, representative histories, and application migration
compatibility. Only after confirming that `nyc311-restore` is disposable may it
be removed with `COMPOSE_PROJECT_NAME=nyc311-restore docker compose down -v`.

For a real recovery, restore to a separate project/volume first, validate it,
stop the live web/worker/proxy, and then promote the restored project. Do not erase
the failed live volume until the recovered service and a fresh S3 backup are
verified.

## Updates and rollback

Use an immutable source revision as `IMAGE_TAG` and keep the prior image locally.
Before every application or schema update:

1. Create and upload a fresh `pg_dump`.
2. Run the automated tests and the parity suite.
3. Build the new image and run migration before replacing services.
4. Check health, logs, data counts, and collector leadership.

```bash
docker compose build --pull
docker compose run --rm migrate
docker compose up -d web worker proxy
```

If only application code must roll back, restore the prior `IMAGE_TAG` in `.env`
and recreate `web` and `worker`. There are no automatic down migrations. If a
schema change is not backward compatible, stop collection and restore the
pre-deploy dump into a new volume rather than attempting ad hoc SQL reversal.

## Upgrade path to RDS and ECS

The single-host layout is intentionally a stepping stone, not a second data
model.

### Move PostgreSQL to RDS

Before the move, complete the RDS TLS and migration-role gate above. Then:

1. Provision private RDS for PostgreSQL in at least two Availability Zones,
   enable storage encryption, backups/PITR, deletion protection, and
   `rds.force_ssl=1`, and allow port 5432 only from the future ECS task security
   group.
2. Use an elevated bootstrap role once to enable the RDS-supported PostGIS
   extension. Give the runtime role only required DML privileges.
3. Stop the worker, create a final custom-format dump, restore it from a
   VPC-connected task/host, and run count/history validation.
4. Supply the RDS `DATABASE_URL` and verified AWS RDS CA bundle to the application.
   Do not rely on `sslmode=require` plus disabled certificate verification.
5. Start exactly one worker against RDS, verify leadership and fresh polls, then
   retire the local database only after the rollback window and an RDS snapshot.

AWS documents that PostGIS setup needs `rds_superuser`; see [Managing spatial
data with PostGIS on RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.PostGIS.html).

### Move the same image to ECS/Fargate

1. Build `Dockerfile.cloud` in CI, tag it immutably, and push it to ECR.
2. Create separate Fargate task definitions using the same image:
   `node cloud/server.js`, `node cloud/worker.js`, and one-off migration/import
   commands. Inject database and dashboard secrets from Secrets Manager; never
   bake them into the image or task definition text.
3. Put the web service behind an HTTPS ALB with `/api/health` as the initial target
   check. Put web and worker tasks in private subnets with outbound HTTPS access
   to the NYC311 Portal.
4. Keep worker desired count at one. Because the current worker exits when it
   cannot acquire its advisory lock, configure a stop-before-start deployment
   (`minimumHealthyPercent: 0`, `maximumPercent: 100`) or first change leadership
   acquisition to wait safely.
5. Run migration as a one-off task and require success before updating either
   long-running service. Remove startup migration after that application change.
6. Send logs and collector/database freshness metrics to CloudWatch, configure a
   deployment circuit breaker, and test SIGTERM drain and RDS failover.

ECS secret values injected as environment variables are read when a task starts;
a rotated secret requires a new task or forced deployment. See the [ECS Secrets
Manager guidance](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html).

At the end of either upgrade, the public dashboard and worker still speak the
same PostgreSQL schema through `DATABASE_URL`; infrastructure changes do not
justify dropping lifecycle history or weakening the import validation gates.
