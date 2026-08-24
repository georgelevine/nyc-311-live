# Lightsail deployment: SQLite first

This is the recommended first cloud deployment for NYC 311 Live. It preserves
the existing SQLite archive and lifecycle state instead of converting the data
to PostgreSQL. One collector and one web service share the persistent Lightsail
disk. Caddy provides HTTPS, the dashboard requires a password, and a nightly job
creates verified SQLite backups.

The planned public-IPv4 instance is $7 USD per month. Lightsail snapshot storage
is billed separately at $0.05 per GB-month, so the protected deployment is not a
strictly flat $7 bill. Transfer overages and a separately purchased domain, if
any, are also outside the instance price.

The PostgreSQL/PostGIS design in `aws/lightsail/` remains an optional later
migration if measured load eventually requires more than one application host.

## Fast automatic releases

After the first full release is installed, install the root-owned UI deployment
helper once:

```bash
sudo install -m 0755 -o root -g root \
  /opt/nyc-311-live/aws/lightsail-sqlite/deploy-ui-release.sh \
  /usr/local/sbin/nyc311-deploy-ui-release
```

Future changes are one command from a clean, pushed `main` branch:

```bash
cd /Users/georgelevine/nyc-bid-311
npm run deploy
```

The command runs the tests, archives the exact pushed commit, verifies it on
Lightsail, and automatically chooses the narrowest safe release lane. Browser
files switch atomically without restarting a container. Express/API changes
replace only `web`; the collector and inbound-email receiver remain live.
Collector, dependency, Compose, and infrastructure changes use the complete
health-checked service lane. Every fast lane refuses changes outside its
allowlist, verifies the exact public release, and rolls back on failure. None of
the lanes mutates, copies, migrates, or replaces the SQLite database; bounded
read-only health checks confirm that the archive remains available.

Explicit `npm run deploy:assets`, `npm run deploy:web`, and
`npm run deploy:service` commands are available for controlled testing, but the
normal command is always `npm run deploy`.

## Safety rules

- The Mac remains the only collector throughout the rehearsal.
- Finalization is performed on a copy. The original Mac database is never
  migrated or rewritten.
- The cloud collector cannot activate until Lightsail recovery snapshots and a
  successful restore rehearsal are explicitly confirmed.
- Activation succeeds only after the cloud collector advances the stored Portal
  poll timestamp. On failure, the script stops it automatically.
- Never run the Mac and cloud collectors at the same time after cutover.

One launch limitation remains: Docker marks a stale collector unhealthy but does
not notify anyone or restart it. Before treating the service as unattended, add
an external HTTPS uptime monitor for `/api/health/collector` with alerts. During
the private SSH-tunnel rehearsal, use the routine checks below manually. Avoid an
automatic restart loop because a real NYC311 Portal outage also makes readiness
stale.

## What is deployed

- `collector`: polls the NYC311 Portal, audits request-number gaps, loads public
  details, subscribes new requests to NYC311 email updates, and monitors
  requests through closure.
- `web`: serves the live dashboard and API from the same SQLite archive.
- `proxy`: exposes the web service through Caddy on ports 80 and 443.
- `backup`: uses SQLite's cooperative online-backup API, validates the complete
  archive, records a SHA-256 manifest, and retains three verified local copies.

The Node services run as UID 10001 with a read-only container filesystem and
dropped Linux capabilities. An operating-system lock prevents a second collector
from using the same archive. Cloud SQLite uses `SQLITE_SYNCHRONOUS=FULL`.

The collector normally treats authenticated, request-matched NYC311 email as the
primary closure signal and immediately verifies a closure against the Portal.
Set `SCHEDULED_OPEN_FOLLOWUPS_ENABLED=0` in the protected `.env` to stop blanket
24-hour checks of every still-open request. Map polling, number-gap auditing,
initial detail loading, email subscriptions, and email-triggered closure
verification continue. This mode is reversible by restoring the value to `1`
and recreating the collector.

## 1. Create the Lightsail instance

In the AWS Lightsail console, create:

1. An Ubuntu 24.04 LTS Linux instance in `us-east-1` (Virginia).
2. The 1 GB RAM / 40 GB SSD Linux plan.
3. A static IP attached to the instance.
4. Firewall rules for TCP 80 and 443. Restrict TCP 22 to the administrator's IP
   whenever practical. Do not expose ports 10000 or 5432.
5. Optionally, a DNS `A` record such as `311.example.com` pointing at the static
   IP. A domain may be added after the private rehearsal.

Lightsail's browser SSH works without a local key, but `scp` from the Mac does
not. In **Account → SSH keys** in Lightsail, download the private key for the
instance's region (or add the Mac's existing public key during instance setup).
The commands below assume the downloaded regional key:

```bash
export LIGHTSAIL_KEY="$HOME/Downloads/LightsailDefaultKey-us-east-1.pem"
chmod 600 "$LIGHTSAIL_KEY"
ssh -o IdentitiesOnly=yes -i "$LIGHTSAIL_KEY" \
  ubuntu@LIGHTSAIL_STATIC_IP
```

Keep the private key only on the Mac and never put it in the repository or
release archive. Re-export `LIGHTSAIL_KEY` in each new Mac terminal.

Without a domain, leave `SITE_ADDRESS` blank and use an SSH tunnel. The collector
can run privately, but do not expose the HTTP-only tunnel endpoint to the public.

## 2. Install the release

Put the checked and committed repository at `/opt/nyc-311-live`. Use either a
clean Git checkout or an archive produced by `git archive`; that command expands
the checked-in `RELEASE_COMMIT` marker. A generic tar of a working tree is refused
because its provenance cannot be proved. Do not transfer `node_modules`, `.env`,
a Mac application bundle, or an active SQLite main file by itself.

For the private repository, the simplest first install is a release archive made
from the committed SHA. On the Mac:

```bash
cd /Users/georgelevine/nyc-bid-311
test -z "$(git status --porcelain)"
RELEASE_SHA="$(git rev-parse HEAD)"
git archive --format=tar.gz \
  --output "$HOME/Desktop/nyc-311-live-$RELEASE_SHA.tar.gz" \
  "$RELEASE_SHA"
scp -o IdentitiesOnly=yes -i "$LIGHTSAIL_KEY" \
  "$HOME/Desktop/nyc-311-live-$RELEASE_SHA.tar.gz" \
  ubuntu@LIGHTSAIL_STATIC_IP:/tmp/nyc-311-live.tar.gz
```

On the new Lightsail instance:

```bash
sudo test ! -e /opt/nyc-311-live
sudo install -d -m 0755 -o root -g root /opt/nyc-311-live
sudo tar --extract --gzip --file /tmp/nyc-311-live.tar.gz \
  --directory /opt/nyc-311-live --no-same-owner
tr -d '[:space:]' < /opt/nyc-311-live/RELEASE_COMMIT
```

The printed value must equal `RELEASE_SHA` from the Mac.

Prepare the host:

```bash
cd /opt/nyc-311-live/aws/lightsail-sqlite
sudo ./install-host.sh
```

The installer adds Docker Compose, the SQLite CLI, unattended security updates,
a 1 GB swap file, protected storage directories, and the nightly backup timer.
Application data paths are intentionally fixed so Compose and systemd cannot
silently point at different disks.

## 3. Configure the deployment

```bash
cd /opt/nyc-311-live/aws/lightsail-sqlite
sudo cp .env.example .env
sudo chmod 600 .env
openssl rand -hex 32
git -C /opt/nyc-311-live rev-parse HEAD 2>/dev/null || \
  tr -d '[:space:]' < /opt/nyc-311-live/RELEASE_COMMIT
sudoedit .env
```

Put the generated password in `DASHBOARD_PASSWORD`. Put the exact Git commit SHA
in both `IMAGE_TAG` and `WEB_IMAGE_TAG`; tags are immutable so the previous
images remain available for rollback. When DNS is ready, set `SITE_ADDRESS` to
the hostname without `https://` and set `ACME_EMAIL`. Leave both activation
confirmations at `0` for now. Never commit `.env`.

## 4. Rehearse while the Mac keeps collecting

Never copy the active main database with `cp`; committed transactions may still
be in its WAL. Use SQLite's online backup operation, then finalize only that copy:

```bash
cd /Users/georgelevine/nyc-bid-311
SOURCE_DB="$HOME/Library/Application Support/nyc-bid-311/portal-archive.sqlite"
REHEARSAL_DIR="$(mktemp -d /private/tmp/nyc311-rehearsal.XXXXXX)"
test -f "$SOURCE_DB"
sqlite3 -readonly "$SOURCE_DB" \
  ".timeout 10000" \
  ".backup '$REHEARSAL_DIR/online-copy.sqlite'"
node finalize-sqlite.js \
  --db "$REHEARSAL_DIR/online-copy.sqlite" \
  --backup "$REHEARSAL_DIR/portal-archive.sqlite"
node verify-sqlite-snapshot.js \
  "$REHEARSAL_DIR/portal-archive.sqlite" \
  "$REHEARSAL_DIR/portal-archive.sqlite.manifest.json"
```

The live Mac archive and collector remain untouched. Upload the two immutable
outputs:

```bash
scp -o IdentitiesOnly=yes -i "$LIGHTSAIL_KEY" \
  "$REHEARSAL_DIR/portal-archive.sqlite" \
  ubuntu@LIGHTSAIL_STATIC_IP:/tmp/
scp -o IdentitiesOnly=yes -i "$LIGHTSAIL_KEY" \
  "$REHEARSAL_DIR/portal-archive.sqlite.manifest.json" \
  ubuntu@LIGHTSAIL_STATIC_IP:/tmp/
```

Stage them in the root-only import directory and install without activation:

```bash
sudo install -m 0600 -o root -g root /tmp/portal-archive.sqlite \
  /var/lib/nyc-311-live-imports/portal-archive.sqlite
sudo install -m 0600 -o root -g root \
  /tmp/portal-archive.sqlite.manifest.json \
  /var/lib/nyc-311-live-imports/portal-archive.sqlite.manifest.json
cd /opt/nyc-311-live/aws/lightsail-sqlite
sudo ./install-snapshot.sh
```

The installer builds the immutable image, verifies the root-owned staging files,
copies the database, verifies the installed bytes again, and starts only the web
service. If a domain is configured, it also requires the public HTTPS health
check to pass.

Without a domain, make a private tunnel from the Mac:

```bash
ssh -o IdentitiesOnly=yes -i "$LIGHTSAIL_KEY" \
  -L 3115:127.0.0.1:10000 ubuntu@LIGHTSAIL_STATIC_IP
```

Open `http://127.0.0.1:3115/live.html`. Confirm the captured total, latest request
number, recent cards, map totals, status histories, and archive health. The cloud
collector is still stopped; the Mac remains the only writer.

## 5. Prove backup and restore before activation

Create a routine backup and inspect its verifier output:

```bash
sudo systemctl start nyc311-backup.service
sudo systemctl status nyc311-backup.service --no-pager
sudo journalctl -u nyc311-backup.service -n 100 --no-pager
sudo ls -lh /var/backups/nyc-311-live
```

Reinstall the newest verified backup as a restore rehearsal:

```bash
LATEST_MANIFEST="$(sudo find /var/backups/nyc-311-live -maxdepth 1 -type f \
  -name '*.manifest.json' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
LATEST_DATABASE="${LATEST_MANIFEST%.manifest.json}"
sudo install -m 0600 -o root -g root "$LATEST_DATABASE" \
  /var/lib/nyc-311-live-imports/restore-test.sqlite
sudo install -m 0600 -o root -g root "$LATEST_MANIFEST" \
  /var/lib/nyc-311-live-imports/restore-test.sqlite.manifest.json
cd /opt/nyc-311-live/aws/lightsail-sqlite
sleep 2
sudo ./install-snapshot.sh --skip-build restore-test.sqlite
```

Confirm the dashboard again. Then enable automatic Lightsail snapshots and create
one manual snapshot in the AWS console. Wait until the manual snapshot reports
`Available`, and record its name and creation time. Automatic snapshots cover
host/disk loss, but AWS deletes them if the source instance is deleted; the manual
snapshot is kept until you explicitly remove it. The three local SQLite backups
alone do not protect against instance loss.

Prove the manual snapshot is bootable before activation. In Lightsail, create a
temporary same-size instance from that manual snapshot. This temporary instance
is billed at the selected plan's prorated rate until it is deleted. The original
cloud collector is still stopped at this stage, and the rehearsal install was run
without `--activate`, so no collector should be running in the snapshot. Connect
to the temporary instance with browser SSH and run:

```bash
cd /opt/nyc-311-live/aws/lightsail-sqlite
sudo docker compose stop collector
sudo docker compose up -d --no-build web
sudo docker compose --profile tools run --rm --no-deps verify \
  node verify-sqlite-snapshot.js \
  /data/portal-archive.sqlite \
  /imports/restore-test.sqlite.manifest.json
curl --fail --show-error http://127.0.0.1:10000/api/health
```

The verifier must pass and report the expected request count and frontier. Delete
only the temporary recovery instance afterward; keep the manual snapshot. Record
the recovery instance name and successful verification time. Only after the
logical restore, automatic snapshots, manual snapshot, and recovered-instance
test all pass, set these in the root-owned `.env`:

```text
OFFSITE_BACKUPS_CONFIRMED=1
RESTORE_TEST_CONFIRMED=1
```

## 6. Final cutover

1. Fully quit the Mac application with Command-Q. Closing its window is not
   sufficient. The current source sends a shutdown signal to any running audit
   child, but cutover still fails closed unless the listener, collector/audit
   processes, and database handles are all gone:

   ```bash
   SOURCE_DB="$HOME/Library/Application Support/nyc-bid-311/portal-archive.sqlite"
   if lsof -nP -iTCP:3114 -sTCP:LISTEN; then
     echo "STOP: the Mac app is still listening" >&2
     exit 1
   fi
   if pgrep -fl 'live-311\.js|archive-311\.js|NYC 311 Live\.app/Contents/MacOS'; then
     echo "STOP: a Mac collector or audit process is still running" >&2
     exit 1
   fi
   if lsof -nP "$SOURCE_DB"; then
     echo "STOP: a process still has the SQLite archive open" >&2
     exit 1
   fi
   ```

   If any command prints a process, do not continue. Wait for it to exit or stop
   that exact listed collector/audit process, then rerun all three checks.
2. Make a stopped copy first, then finalize that copy. The original source remains
   an untouched rollback artifact:

   ```bash
   cd /Users/georgelevine/nyc-bid-311
   SOURCE_DB="$HOME/Library/Application Support/nyc-bid-311/portal-archive.sqlite"
   CUTOVER_DIR="$HOME/Desktop/NYC311-Cutover"
   mkdir -p "$CUTOVER_DIR"
   test -f "$SOURCE_DB"
   sqlite3 -readonly "$SOURCE_DB" \
     ".timeout 10000" \
     ".backup '$CUTOVER_DIR/cutover-source.sqlite'"
   node finalize-sqlite.js \
     --db "$CUTOVER_DIR/cutover-source.sqlite" \
     --backup "$CUTOVER_DIR/portal-archive.sqlite"
   node verify-sqlite-snapshot.js \
     "$CUTOVER_DIR/portal-archive.sqlite" \
     "$CUTOVER_DIR/portal-archive.sqlite.manifest.json"
   ```

3. Upload and root-stage the two new output files exactly as in the rehearsal.
4. Activate the already-built image without adding a network-dependent build to
   the offline window:

   ```bash
   cd /opt/nyc-311-live/aws/lightsail-sqlite
   sudo ./install-snapshot.sh --activate --skip-build
   sudo docker compose ps
   sudo docker compose logs --since=10m collector web proxy
   ```

The activation command does not return success until `last_successful_poll_at`
advances and is fresh. If that proof fails, it stops the cloud collector. If DNS
is configured, public TLS and `/api/health/collector` must also pass.

After success, sign in and compare the dashboard with the transferred manifest.
Do not reopen the Mac collector. Preserve its original database unchanged.

## Backups, restore, and rollback

The timer runs nightly and keeps three verified local backups. Each run uses
SQLite's online-backup API in small page batches so live readers and writers can
continue between copy steps, then verifies the new copy with one full
`integrity_check`, a foreign-key check, the migration and archive contracts, and
one SHA-256 pass. `quick_check` is deliberately omitted because
`integrity_check` is the stronger superset. The command's JSON result lists
the logical database size, current WAL size, required safety headroom, and
available space checked before the snapshot begins. The exclusive service lock
also permits the next run to remove incomplete partials left by an interrupted
earlier run. SQLite page batching and the backup container's 8 MiB/s read and
write cgroup limits keep this work subordinate to the live services.
The result also includes `io_operations`, `io_operation_counts`, and the three
whole-file operations in `full_file_passes`; every listed new-backup operation
should have a count of one.

Retention does not re-hash or reopen unchanged older databases every night.
Instead, it trusts their atomically published verification manifests, exact
paths and sizes, schema identity, health receipts, and the requirement that the
database file has not changed since its manifest was written. Existing legacy
manifests created by the prior atomic routine remain eligible because that
routine verified them before returning. A changed, malformed, unpaired, or
untrusted artifact is preserved for investigation and never consumes a
retention slot. Under the service's exclusive lock, all pre-existing managed
`.partial` files are known to be abandoned and are removed before the
free-space check; non-exclusive library callers preserve partials they cannot
prove are inactive. The job refuses to start without safe free space.

Use the explicit snapshot verifier when you want to re-read and deeply scrub a
retained backup (for example, during a restore rehearsal or periodic audit):

```bash
node verify-sqlite-snapshot.js \
  /var/backups/nyc-311-live/portal-archive-YYYYMMDDTHHMMSSZ.sqlite
```

On the small instance, the backup process runs at idle disk priority and the
lowest CPU priority inside its container. Because the verified
Lightsail root partition `/dev/nvme0n1p1` uses the `none` scheduler and therefore
does not honor `ionice`, Compose also applies cgroup-v2 ceilings of 1 MB/s for
both reads and writes to its parent block device, `/dev/nvme0n1`, on the backup
container only. The parent is required because this host's cgroup v2 controller
rejects limits on the partition itself. SQLite copies 64 pages per step by
default so foreground collection, email ingestion, and dashboard reads can run
between short backup bursts. Set `BACKUP_PAGE_RATE` in `.env` only after
measuring production I/O latency; a larger value creates larger bursts but
cannot exceed the container bandwidth ceiling.

Before moving this deployment to a different instance or disk layout, verify the
root filesystem device with `findmnt -no SOURCE,MAJ:MIN /`, find its parent with
`lsblk -o NAME,MAJ:MIN,TYPE,PKNAME,MOUNTPOINTS`, and update both `blkio_config`
paths if the parent is no longer `/dev/nvme0n1`. A missing or incorrect device
path makes the backup job fail safely rather than running unthrottled.

```bash
sudo systemctl status nyc311-backup.timer --no-pager
sudo systemctl start nyc311-backup.service
sudo journalctl -u nyc311-backup.service --since today --no-pager
sudo ls -lh /var/backups/nyc-311-live
```

To restore a healthy prior backup, stop the collector, root-stage the selected
database and matching manifest as `rollback.sqlite`, and run the following. Set
`ROLLBACK_DATABASE` to the selected verified file; its adjacent manifest must
have the same name followed by `.manifest.json`.

```bash
ROLLBACK_DATABASE=/var/backups/nyc-311-live/portal-archive-YYYYMMDDTHHMMSSZ.sqlite
ROLLBACK_MANIFEST="${ROLLBACK_DATABASE}.manifest.json"
sudo test -f "$ROLLBACK_DATABASE" && sudo test -f "$ROLLBACK_MANIFEST"
sudo install -m 0600 -o root -g root "$ROLLBACK_DATABASE" \
  /var/lib/nyc-311-live-imports/rollback.sqlite
sudo install -m 0600 -o root -g root "$ROLLBACK_MANIFEST" \
  /var/lib/nyc-311-live-imports/rollback.sqlite.manifest.json
cd /opt/nyc-311-live/aws/lightsail-sqlite
sudo docker compose stop collector web proxy
sudo ./install-snapshot.sh --activate --skip-build rollback.sqlite
```

If the current database is corrupt, preserve it before running the installer so
its normal pre-replacement backup cannot block recovery:

```bash
cd /opt/nyc-311-live/aws/lightsail-sqlite
sudo docker compose stop collector web proxy
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
sudo mv /var/lib/nyc-311-live/portal-archive.sqlite \
  "/var/lib/nyc-311-live/portal-archive.failed-$STAMP.sqlite"
sudo mv /var/lib/nyc-311-live/portal-archive.sqlite-wal \
  "/var/lib/nyc-311-live/portal-archive.failed-$STAMP.sqlite-wal" 2>/dev/null || true
sudo mv /var/lib/nyc-311-live/portal-archive.sqlite-shm \
  "/var/lib/nyc-311-live/portal-archive.failed-$STAMP.sqlite-shm" 2>/dev/null || true
sudo ./install-snapshot.sh --activate --skip-build rollback.sqlite
```

For code rollback, fail closed unless the prior immutable image and matching
version label are both still present. Then set both `IMAGE_TAG` and
`WEB_IMAGE_TAG` in `.env` to that exact prior SHA and recreate without allowing
Compose to build the current checkout:

```bash
cd /opt/nyc-311-live/aws/lightsail-sqlite
PRIOR_SHA=PUT_THE_40_CHARACTER_PRIOR_GIT_SHA_HERE
PRIOR_RELEASE_DIRECTORY=/opt/PUT_THE_RETAINED_PRIOR_RELEASE_DIRECTORY_HERE
sudo docker image inspect "nyc-311-sqlite:$PRIOR_SHA" >/dev/null
IMAGE_LABEL="$(sudo docker image inspect \
  --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
  "nyc-311-sqlite:$PRIOR_SHA")"
test "$IMAGE_LABEL" = "$PRIOR_SHA"
sudoedit .env
test "$(sudo sed -n 's/^IMAGE_TAG=//p' .env)" = "$PRIOR_SHA"
test "$(sudo sed -n 's/^WEB_IMAGE_TAG=//p' .env)" = "$PRIOR_SHA"
sudo /usr/local/sbin/nyc311-publish-static-release \
  "$PRIOR_RELEASE_DIRECTORY/public" "$PRIOR_SHA"
sudo docker compose up -d --no-build --force-recreate \
  web inbound-email collector proxy
```

If activation fails before a fresh cloud poll, the script stops the cloud
collector and the untouched Mac collector can be restarted. Once any cloud poll
has succeeded, do not restart the stale Mac copy: first transfer a verified cloud
backup back to the Mac or continue from a verified Lightsail restore. Never merge
two independently active SQLite archives.

To return the current cloud archive to the Mac after cloud collection has begun,
first stop the cloud collector and make one final verified cloud backup:

```bash
cd /opt/nyc-311-live/aws/lightsail-sqlite
sudo docker compose stop collector
sudo systemctl start nyc311-backup.service
sudo systemctl status nyc311-backup.service --no-pager
LATEST_MANIFEST="$(sudo find /var/backups/nyc-311-live -maxdepth 1 -type f \
  -name '*.manifest.json' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
LATEST_DATABASE="${LATEST_MANIFEST%.manifest.json}"
sudo test -f "$LATEST_DATABASE" && sudo test -f "$LATEST_MANIFEST"
sudo install -m 0600 -o ubuntu -g ubuntu "$LATEST_DATABASE" \
  /home/ubuntu/nyc311-mac-restore.sqlite
sudo install -m 0600 -o ubuntu -g ubuntu "$LATEST_MANIFEST" \
  /home/ubuntu/nyc311-mac-restore.sqlite.manifest.json
```

On the Mac, while the cloud collector remains stopped:

```bash
scp -o IdentitiesOnly=yes -i "$LIGHTSAIL_KEY" \
  ubuntu@LIGHTSAIL_STATIC_IP:/home/ubuntu/nyc311-mac-restore.sqlite \
  "$HOME/Downloads/"
scp -o IdentitiesOnly=yes -i "$LIGHTSAIL_KEY" \
  ubuntu@LIGHTSAIL_STATIC_IP:/home/ubuntu/nyc311-mac-restore.sqlite.manifest.json \
  "$HOME/Downloads/"
cd /Users/georgelevine/nyc-bid-311
node verify-sqlite-snapshot.js \
  "$HOME/Downloads/nyc311-mac-restore.sqlite" \
  "$HOME/Downloads/nyc311-mac-restore.sqlite.manifest.json"
SOURCE_DB="$HOME/Library/Application Support/nyc-bid-311/portal-archive.sqlite"
if lsof -nP "$SOURCE_DB"; then
  echo "STOP: the Mac app still has the database open" >&2
  exit 1
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STALE_DIR="$HOME/Desktop/NYC311-Stale-Mac-$STAMP"
mkdir -p "$STALE_DIR"
mv "$SOURCE_DB" "$STALE_DIR/"
test ! -e "$SOURCE_DB-wal" || mv "$SOURCE_DB-wal" "$STALE_DIR/"
test ! -e "$SOURCE_DB-shm" || mv "$SOURCE_DB-shm" "$STALE_DIR/"
install -m 0600 "$HOME/Downloads/nyc311-mac-restore.sqlite" "$SOURCE_DB"
sqlite3 -readonly "$SOURCE_DB" 'PRAGMA quick_check;'
```

Only after `quick_check` prints `ok` may the Mac collector be restarted. Keep the
cloud collector stopped, and remove the two temporary files from `/home/ubuntu`
after the Mac dashboard and a fresh Mac Portal poll are verified.

## Routine checks

```bash
cd /opt/nyc-311-live/aws/lightsail-sqlite
sudo docker compose ps
sudo docker compose logs --since=30m collector web proxy
curl --fail --show-error https://YOUR_DOMAIN/api/health
curl --fail --show-error https://YOUR_DOMAIN/api/health/collector
df -h /var/lib/nyc-311-live /var/backups/nyc-311-live
```

Before a code update, create a verified backup, build the new Git-SHA image while
the existing services remain active, and only then recreate `web` and `collector`.
