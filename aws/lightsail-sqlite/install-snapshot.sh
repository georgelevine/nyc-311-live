#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: sudo ./install-snapshot.sh [--activate] [--skip-build] [snapshot filename]" >&2
}

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

activate=0
skip_build=0
snapshot_argument=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --activate)
      activate=1
      ;;
    --skip-build)
      skip_build=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -n "${snapshot_argument}" ]]; then
        usage
        exit 1
      fi
      snapshot_argument="$1"
      ;;
  esac
  shift
done

deployment_directory="/opt/nyc-311-live/aws/lightsail-sqlite"
cd "${deployment_directory}"
install_lock="/var/lib/nyc-311-live-lock/install.lock"
static_publisher="/usr/local/sbin/nyc311-publish-static-release"
static_asset_root="/var/lib/nyc-311-live-assets"
if [[ -L "${install_lock}" || ! -f "${install_lock}"
    || "$(stat -c '%u' "${install_lock}")" != "0"
    || "$(stat -c '%a' "${install_lock}")" != "600"
    || "$(stat -c '%h' "${install_lock}")" != "1" ]]; then
  echo "The protected installer lock is missing or unsafe; rerun install-host.sh." >&2
  exit 1
fi
exec 8<>"${install_lock}"
if ! flock --nonblock 8; then
  echo "Another snapshot installation is already running; this invocation was aborted." >&2
  exit 1
fi
if [[ ! -f .env || -L .env ]]; then
  echo "Create ${deployment_directory}/.env first." >&2
  exit 1
fi
if [[ "$(stat -c '%u' .env)" != "0" || "$(stat -c '%a' .env)" != "600" ]]; then
  echo ".env must be owned by root with mode 0600." >&2
  exit 1
fi

# Parse a deliberately small dotenv grammar without evaluating it as shell code.
declare -A deployment_env=()
declare -A allowed_env_keys=(
  [COMPOSE_PROJECT_NAME]=1
  [IMAGE_TAG]=1
  [WEB_IMAGE_TAG]=1
  [SITE_ADDRESS]=1
  [ACME_EMAIL]=1
  [DASHBOARD_USERNAME]=1
  [DASHBOARD_PASSWORD]=1
  [SQLITE_IMPORT_FILE]=1
  [BACKUP_RETENTION_COUNT]=1
  [OFFSITE_BACKUPS_CONFIRMED]=1
  [RESTORE_TEST_CONFIRMED]=1
  [POLL_INTERVAL_SECONDS]=1
  [AUDIT_DELAY_MINUTES]=1
  [DETAIL_REQUEST_DELAY_MS]=1
  [AUDIT_MAX_PARALLEL]=1
  [AUDIT_REQUEST_DELAY_MS]=1
  [SQLITE_SYNCHRONOUS]=1
  [SQLITE_BUSY_TIMEOUT_MS]=1
  [INBOUND_EMAIL_DOMAIN]=1
  [INBOUND_EMAIL_WEBHOOK_SECRET]=1
  [EMAIL_SUBSCRIBE_BID_IDS]=1
  [EMAIL_SUBSCRIBE_PRECINCTS]=1
  [EMAIL_PRECINCT_START_AT]=1
  [EMAIL_SUBSCRIBE_ALL_NEW]=1
  [EMAIL_ALL_START_AT]=1
  [EMAIL_SUBSCRIPTION_DELAY_MS]=1
  [EMAIL_SUBSCRIPTION_WORKERS]=1
  [INITIAL_EMAIL_ENDPOINT]=1
  [SCHEDULED_OPEN_FOLLOWUPS_ENABLED]=1
)
env_line_number=0
while IFS= read -r env_line || [[ -n "${env_line}" ]]; do
  ((env_line_number += 1))
  if [[ -z "${env_line}" || "${env_line}" == \#* ]]; then
    continue
  fi
  if [[ ! "${env_line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
    echo "Invalid .env syntax on line ${env_line_number}; use unquoted KEY=VALUE entries." >&2
    exit 1
  fi
  env_key="${BASH_REMATCH[1]}"
  env_value="${BASH_REMATCH[2]}"
  if [[ -z "${allowed_env_keys[${env_key}]+present}" ]]; then
    echo "Unsupported .env key: ${env_key}" >&2
    exit 1
  fi
  if [[ -n "${deployment_env[${env_key}]+present}" ]]; then
    echo "Duplicate .env key: ${env_key}" >&2
    exit 1
  fi
  deployment_env[${env_key}]="${env_value}"
  printf -v "${env_key}" '%s' "${env_value}"
  export "${env_key}"
done < .env

dashboard_password="${DASHBOARD_PASSWORD:-}"
if [[ -z "${DASHBOARD_USERNAME:-}" || ${#dashboard_password} -lt 32 ]]; then
  echo "Set a dashboard username and a password of at least 32 characters." >&2
  exit 1
fi
if [[ ! "${BACKUP_RETENTION_COUNT:-}" =~ ^[1-3]$ ]]; then
  echo "BACKUP_RETENTION_COUNT must be 1, 2, or 3 on this Lightsail plan." >&2
  exit 1
fi
if [[ "${SQLITE_SYNCHRONOUS:-}" != "FULL" ]]; then
  echo "SQLITE_SYNCHRONOUS must be FULL for the cloud archive." >&2
  exit 1
fi
if [[ ! "${POLL_INTERVAL_SECONDS:-}" =~ ^(5|10|15|30|60)$ ]]; then
  echo "POLL_INTERVAL_SECONDS must be 5, 10, 15, 30, or 60." >&2
  exit 1
fi
if [[ ! "${SCHEDULED_OPEN_FOLLOWUPS_ENABLED:-1}" =~ ^(0|1)$ ]]; then
  echo "SCHEDULED_OPEN_FOLLOWUPS_ENABLED must be 0 or 1." >&2
  exit 1
fi
require_integer_range() {
  local key="$1"
  local minimum="$2"
  local maximum="$3"
  local value="${!key-}"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "${key} must be an integer from ${minimum} through ${maximum}." >&2
    exit 1
  fi
  local decimal_value=$((10#${value}))
  if (( decimal_value < minimum || decimal_value > maximum )); then
    echo "${key} must be an integer from ${minimum} through ${maximum}." >&2
    exit 1
  fi
}
require_integer_range AUDIT_DELAY_MINUTES 30 1440
require_integer_range DETAIL_REQUEST_DELAY_MS 2500 60000
require_integer_range AUDIT_MAX_PARALLEL 1 8
require_integer_range AUDIT_REQUEST_DELAY_MS 500 60000
require_integer_range EMAIL_SUBSCRIPTION_DELAY_MS 1000 60000
if [[ -n "${SQLITE_BUSY_TIMEOUT_MS:-}" ]]; then
  require_integer_range SQLITE_BUSY_TIMEOUT_MS 0 300000
fi
if [[ -n "${EMAIL_SUBSCRIPTION_WORKERS:-}" ]]; then
  require_integer_range EMAIL_SUBSCRIPTION_WORKERS 1 4
fi
if [[ -n "${SITE_ADDRESS:-}" ]]; then
  if [[ ! "${SITE_ADDRESS}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ || "${SITE_ADDRESS}" != *.* ]]; then
    echo "SITE_ADDRESS must be a DNS hostname without a scheme or path." >&2
    exit 1
  fi
  if [[ ! "${ACME_EMAIL:-}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
    echo "Set a valid ACME_EMAIL when SITE_ADDRESS is configured." >&2
    exit 1
  fi
fi

repository_directory="/opt/nyc-311-live"
if git -C "${repository_directory}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  release_commit="$(git -C "${repository_directory}" rev-parse HEAD)"
  if [[ -n "$(git -C "${repository_directory}" status --porcelain --untracked-files=all)" ]]; then
    echo "The deployed Git checkout is dirty; build only a committed release." >&2
    exit 1
  fi
elif [[ -f "${repository_directory}/RELEASE_COMMIT" ]]; then
  release_commit="$(tr -d '[:space:]' < "${repository_directory}/RELEASE_COMMIT")"
else
  echo "The release has neither Git provenance nor an exported RELEASE_COMMIT." >&2
  exit 1
fi

if [[ -z "${IMAGE_TAG:-}" || "${IMAGE_TAG}" == "local"
    || "${IMAGE_TAG}" == "replace-with-git-sha"
    || ! "${IMAGE_TAG}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Set IMAGE_TAG in .env to the immutable Git commit SHA being deployed." >&2
  exit 1
fi
if [[ ! "${release_commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The deployed release commit is invalid." >&2
  exit 1
fi
if [[ -z "${deployment_env[WEB_IMAGE_TAG]+present}" ]]; then
  # Releases installed before the web/service split used IMAGE_TAG for every
  # container. Persist that exact pointer so future Compose commands remain
  # compatible after this installer exits.
  WEB_IMAGE_TAG="${IMAGE_TAG}"
  export WEB_IMAGE_TAG
  printf '\nWEB_IMAGE_TAG=%s\n' "${WEB_IMAGE_TAG}" >> .env
  chmod 0600 .env
  echo "Initialized WEB_IMAGE_TAG from the existing immutable IMAGE_TAG."
fi
if [[ -z "${WEB_IMAGE_TAG:-}" || "${WEB_IMAGE_TAG}" == "local"
    || "${WEB_IMAGE_TAG}" == "replace-with-git-sha"
    || ! "${WEB_IMAGE_TAG}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Set WEB_IMAGE_TAG in .env to an immutable web image Git SHA." >&2
  exit 1
fi
if [[ ! -x "${static_publisher}" || -L "${static_publisher}"
    || "$(stat -c '%u:%g' "${static_publisher}")" != "0:0" ]]; then
  echo "The root-owned static publisher is missing; rerun install-host.sh." >&2
  exit 1
fi
if [[ ${activate} -eq 1 && "${OFFSITE_BACKUPS_CONFIRMED:-0}" != "1" ]]; then
  echo "Activation blocked: configure the required Lightsail recovery snapshots and set OFFSITE_BACKUPS_CONFIRMED=1." >&2
  exit 1
fi
if [[ ${activate} -eq 1 && "${RESTORE_TEST_CONFIRMED:-0}" != "1" ]]; then
  echo "Activation blocked: complete a verified restore rehearsal and set RESTORE_TEST_CONFIRMED=1." >&2
  exit 1
fi

snapshot_name="${snapshot_argument:-${SQLITE_IMPORT_FILE:-portal-archive.sqlite}}"
if [[ "${snapshot_name}" == */* || ! "${snapshot_name}" =~ ^[A-Za-z0-9._-]+\.sqlite$ ]]; then
  echo "Snapshot must be a plain .sqlite filename." >&2
  exit 1
fi

data_directory="/var/lib/nyc-311-live"
import_directory="/var/lib/nyc-311-live-imports"
collector_lock="/var/lib/nyc-311-live-lock/collector.lock"
snapshot="${import_directory}/${snapshot_name}"
manifest="${snapshot}.manifest.json"
target="${data_directory}/portal-archive.sqlite"

if [[ ! -f "${snapshot}" || ! -f "${manifest}" || -L "${snapshot}" || -L "${manifest}" ]]; then
  echo "Place regular ${snapshot_name} and ${snapshot_name}.manifest.json files in ${import_directory}." >&2
  exit 1
fi
if [[ "$(stat -c '%u' "${snapshot}")" != "0" || "$(stat -c '%u' "${manifest}")" != "0" ]]; then
  echo "The staged snapshot and manifest must be owned by root." >&2
  exit 1
fi
if [[ "$(stat -c '%h' "${snapshot}")" != "1" || "$(stat -c '%h' "${manifest}")" != "1" ]]; then
  echo "The staged snapshot and manifest must not have additional hard links." >&2
  exit 1
fi
if [[ -n "$(find "${snapshot}" "${manifest}" -maxdepth 0 -perm /022 -print -quit)" ]]; then
  echo "The staged snapshot and manifest must not be writable by group or others." >&2
  exit 1
fi

export SQLITE_IMPORT_FILE="${snapshot_name}"
docker compose config --quiet
service_image_name="nyc-311-sqlite:${IMAGE_TAG}"
web_image_name="nyc-311-sqlite:${WEB_IMAGE_TAG}"
if [[ ${skip_build} -eq 1 ]]; then
  docker image inspect "${service_image_name}" >/dev/null
  docker image inspect "${web_image_name}" >/dev/null
else
  if [[ "${IMAGE_TAG}" != "${release_commit}"
      || "${WEB_IMAGE_TAG}" != "${release_commit}" ]]; then
    echo "Split service/web rollback images must already exist; rerun with --skip-build." >&2
    exit 1
  fi
  if docker image inspect "${service_image_name}" >/dev/null 2>&1; then
    echo "Refusing to overwrite immutable image ${service_image_name}; use --skip-build or deploy a new commit." >&2
    exit 1
  fi
  # A fresh install starts with both pointers on this release. Building the
  # Compose project can make newer BuildKit versions publish that same tag
  # concurrently and fail with "image already exists". Build web once; the
  # resulting tagged image is also used by the collector and inbound receiver.
  docker compose build --pull web
fi
image_names=("${service_image_name}")
image_tags=("${IMAGE_TAG}")
if [[ "${web_image_name}" != "${service_image_name}" ]]; then
  image_names+=("${web_image_name}")
  image_tags+=("${WEB_IMAGE_TAG}")
fi
for image_index in "${!image_names[@]}"; do
  image_version="$(docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
    "${image_names[${image_index}]}")"
  if [[ "${image_version}" != "${image_tags[${image_index}]}" ]]; then
    echo "Image version label ${image_version} does not match ${image_tags[${image_index}]}." >&2
    exit 1
  fi
done

# First verification reads only the root-owned staging directory.
docker compose --profile tools run --rm --no-deps verify

# Seed Caddy's stable static mount before any service starts. The publisher
# verifies every file and switches `current` atomically, so a fresh host cannot
# report a healthy API while serving a missing or mixed dashboard shell.
"${static_publisher}" "${repository_directory}/public" "${release_commit}"
static_release_directory="${static_asset_root}/releases/${release_commit}"
expected_public_shell_sha="$(sha256sum \
  "${static_release_directory}/live.html" | cut -d' ' -f1)"
expected_public_dashboard_sha="$(sha256sum \
  "${static_release_directory}/js/live-dashboard.js" | cut -d' ' -f1)"
expected_public_css_sha="$(sha256sum \
  "${static_release_directory}/css/live-ui.css" | cut -d' ' -f1)"
expected_public_vendor_sha="$(sha256sum \
  "${static_release_directory}/vendor/leaflet/leaflet.js" | cut -d' ' -f1)"

timer_was_active=0
data_directory_locked=0
collector_guard=0
collector_lock_held=0
if systemctl is-active --quiet nyc311-backup.timer; then
  timer_was_active=1
  systemctl stop nyc311-backup.timer
fi
systemctl stop nyc311-backup.service
restore_host_state() {
  if [[ ${collector_guard} -eq 1 ]]; then
    if ! docker compose stop collector; then
      echo "WARNING: automatic collector shutdown failed; stop it manually immediately." >&2
    fi
  fi
  if [[ ${data_directory_locked} -eq 1 ]]; then
    if ! chown 10001:10001 "${data_directory}" || ! chmod 0750 "${data_directory}"; then
      echo "WARNING: could not restore application ownership on ${data_directory}." >&2
    fi
  fi
  if [[ ${collector_lock_held} -eq 1 ]]; then
    if ! flock --unlock 9; then
      echo "WARNING: could not explicitly release the collector lock; process exit will release it." >&2
    fi
    exec 9>&-
    collector_lock_held=0
  fi
  if [[ ${timer_was_active} -eq 1 ]]; then
    if ! systemctl start nyc311-backup.timer; then
      echo "WARNING: could not restart nyc311-backup.timer; restart it manually." >&2
    fi
  fi
}
trap restore_host_state EXIT

docker compose stop collector inbound-email web proxy
if [[ -L "${collector_lock}" || ! -f "${collector_lock}" || "$(stat -c '%h' "${collector_lock}")" != "1" ]]; then
  echo "The protected collector lock file is missing or unsafe." >&2
  exit 1
fi
exec 9<>"${collector_lock}"
if ! flock --nonblock 9; then
  echo "Another collector still holds the archive lock; installation was aborted." >&2
  exit 1
fi
collector_lock_held=1
if [[ -L "${target}" || ( -e "${target}" && ! -f "${target}" ) ]]; then
  echo "The installed database path must be a regular, non-symlink file." >&2
  exit 1
fi
if [[ -f "${target}" && "$(stat -c '%h' "${target}")" != "1" ]]; then
  echo "The installed database must not have additional hard links." >&2
  exit 1
fi
if [[ -f "${target}" ]]; then
  docker compose --profile tools run --rm --no-deps backup
fi

# Copy as root, verify the exact installed bytes, then atomically hand ownership
# to the unprivileged runtime. The collector cannot write either staging file.
chown root:root "${data_directory}"
chmod 0700 "${data_directory}"
data_directory_locked=1
rm -f "${target}.new"
install -m 0600 -o root -g root "${snapshot}" "${target}.new"
docker compose --profile tools run --rm --no-deps verify \
  node verify-sqlite-snapshot.js "/data/portal-archive.sqlite.new" "/imports/${snapshot_name}.manifest.json"
chown 10001:10001 "${target}.new"
mv -f "${target}.new" "${target}"
rm -f "${target}-shm" "${target}-wal"
if [[ "$(sqlite3 "${target}" 'PRAGMA quick_check;')" != "ok" ]]; then
  echo "Installed database failed SQLite quick_check; services remain stopped." >&2
  exit 1
fi
chown 10001:10001 "${data_directory}"
chmod 0750 "${data_directory}"
data_directory_locked=0

baseline_poll="$(sqlite3 "${target}" "SELECT value FROM live_monitor_state WHERE key='last_successful_poll_at';")"
if [[ -n "${SITE_ADDRESS:-}" ]]; then
  docker compose up -d web inbound-email proxy
else
  docker compose up -d web inbound-email
fi

web_ready=0
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:10000/api/health >/dev/null; then
    web_ready=1
    break
  fi
  sleep 2
done
if [[ ${web_ready} -ne 1 ]]; then
  docker compose logs --tail=100 web inbound-email proxy || true
  echo "The web service did not become healthy; the collector remains stopped." >&2
  exit 1
fi

inbound_email_ready=0
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 5 \
      http://127.0.0.1:10001/health >/dev/null; then
    inbound_email_ready=1
    break
  fi
  sleep 2
done
if [[ ${inbound_email_ready} -ne 1 ]]; then
  docker compose logs --tail=100 inbound-email || true
  echo "The inbound-email service did not become healthy; the collector remains stopped." >&2
  exit 1
fi

if [[ -n "${SITE_ADDRESS:-}" ]]; then
  tls_ready=0
  for _ in $(seq 1 24); do
    if curl --fail --silent --show-error --max-time 20 \
        "https://${SITE_ADDRESS}/api/health" >/dev/null \
        && public_shell_sha="$(curl --fail --silent --show-error --max-time 20 \
          "https://${SITE_ADDRESS}/" | sha256sum | cut -d' ' -f1)" \
        && public_manifest="$(curl --fail --silent --show-error --max-time 20 \
          "https://${SITE_ADDRESS}/release.json?release=${release_commit}")" \
        && public_dashboard_sha="$(curl --fail --silent --show-error --max-time 20 \
          "https://${SITE_ADDRESS}/_ui/${release_commit}/js/live-dashboard.js" \
          | sha256sum | cut -d' ' -f1)" \
        && public_css_sha="$(curl --fail --silent --show-error --max-time 20 \
          "https://${SITE_ADDRESS}/_ui/${release_commit}/css/live-ui.css" \
          | sha256sum | cut -d' ' -f1)" \
        && public_vendor_sha="$(curl --fail --silent --show-error --max-time 20 \
          "https://${SITE_ADDRESS}/_ui/${release_commit}/vendor/leaflet/leaflet.js" \
          | sha256sum | cut -d' ' -f1)" \
        && [[ "${public_shell_sha}" == "${expected_public_shell_sha}"
          && "$(printf '%s' "${public_manifest}" | tr -d '[:space:]')" \
            == "{\"release_sha\":\"${release_commit}\"}"
          && "${public_dashboard_sha}" == "${expected_public_dashboard_sha}"
          && "${public_css_sha}" == "${expected_public_css_sha}"
          && "${public_vendor_sha}" == "${expected_public_vendor_sha}" ]]; then
      tls_ready=1
      break
    fi
    sleep 5
  done
  if [[ ${tls_ready} -ne 1 ]]; then
    docker compose logs --tail=100 proxy || true
    echo "Public HTTPS did not serve the exact shell, manifest, and versioned UI assets; the collector remains stopped." >&2
    exit 1
  fi
fi

if [[ ${activate} -eq 1 ]]; then
  # Any error or interruption from this point stops the collector via the EXIT
  # trap. The guard is cleared only after every readiness check succeeds.
  collector_guard=1
  flock --unlock 9
  exec 9>&-
  collector_lock_held=0
  docker compose up -d collector
  fresh_poll=""
  for _ in $(seq 1 60); do
    current_poll="$(sqlite3 "${target}" "SELECT value FROM live_monitor_state WHERE key='last_successful_poll_at';")"
    current_epoch="$(date --date "${current_poll}" +%s 2>/dev/null || true)"
    now_epoch="$(date +%s)"
    if [[ -n "${current_poll}" && "${current_poll}" != "${baseline_poll}" && -n "${current_epoch}" ]] \
        && (( now_epoch - current_epoch <= 300 && now_epoch - current_epoch >= -60 )); then
      fresh_poll="${current_poll}"
      break
    fi
    sleep 2
  done
  if [[ -z "${fresh_poll}" ]]; then
    docker compose logs --tail=100 collector || true
    docker compose stop collector
    echo "The cloud collector did not complete a fresh Portal poll; it was stopped." >&2
    exit 1
  fi

  curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:10000/api/health/collector >/dev/null
  if [[ -n "${SITE_ADDRESS:-}" ]]; then
    curl --fail --silent --show-error --max-time 20 \
      "https://${SITE_ADDRESS}/api/health/collector" >/dev/null
  fi
  collector_guard=0
  echo "Snapshot installed; the single cloud collector completed a fresh Portal poll at ${fresh_poll}."
else
  echo "Snapshot installed for rehearsal. The cloud collector remains stopped."
fi
if [[ -z "${SITE_ADDRESS:-}" ]]; then
  echo "No public domain is configured; use an SSH tunnel to 127.0.0.1:10000 for rehearsal."
fi
