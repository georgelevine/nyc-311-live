#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this deployment helper with sudo." >&2
  exit 1
fi

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: deploy-ui-release.sh GIT_SHA ARCHIVE_SHA256 [assets|web|service]" >&2
  exit 1
fi

release_sha="$1"
archive_sha256="$2"
deployment_scope="${3:-service}"
if [[ ! "${release_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The release must be identified by a full lowercase Git SHA." >&2
  exit 1
fi
if [[ ! "${archive_sha256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "The archive checksum must be a lowercase SHA-256 digest." >&2
  exit 1
fi
if [[ "${deployment_scope}" != "assets"
    && "${deployment_scope}" != "web"
    && "${deployment_scope}" != "service" ]]; then
  echo "Deployment scope must be assets, web, or service." >&2
  exit 1
fi

current_directory="/opt/nyc-311-live"
release_root="/var/lib/nyc-311-live-releases"
archive="${release_root}/inbox/${release_sha}.tar.gz"
staging_directory="/opt/nyc-311-live-stage-${release_sha}"
lock_file="/var/lib/nyc-311-live-lock/install.lock"
public_health_url="https://311.georgelevine.com/api/health"
public_shell_url="https://311.georgelevine.com/"
public_manifest_url="https://311.georgelevine.com/release.json"
asset_root="/var/lib/nyc-311-live-assets"
static_publisher="/usr/local/sbin/nyc311-publish-static-release"
public_js_url="https://311.georgelevine.com/_ui/${release_sha}/js/live-dashboard.js"
public_css_url="https://311.georgelevine.com/_ui/${release_sha}/css/live-ui.css"
public_vendor_url="https://311.georgelevine.com/_ui/${release_sha}/vendor/leaflet/leaflet.js"

exec 9>"${lock_file}"
if ! flock --exclusive --nonblock 9; then
  echo "Another install or deployment is already running." >&2
  exit 1
fi

current_env="${current_directory}/aws/lightsail-sqlite/.env"
if [[ ! -d "${current_directory}" || ! -f "${current_env}" || -L "${current_env}" ]]; then
  echo "The current Lightsail release or its protected environment file is missing." >&2
  exit 1
fi
if [[ "$(stat -c '%u' "${current_env}")" != "0"
    || "$(stat -c '%a' "${current_env}")" != "600" ]]; then
  echo "The protected environment file must be owned by root with mode 0600." >&2
  exit 1
fi
read_protected_env_value() {
  local key="$1"
  local file="$2"
  awk -v key="${key}" '
    index($0, key "=") == 1 {
      count += 1
      value = substr($0, length(key) + 2)
    }
    END {
      if (count > 1) exit 2
      if (count == 1) printf "%s", value
    }
  ' "${file}"
}
if ! expected_collector_scope="$(read_protected_env_value COLLECTOR_SCOPE "${current_env}")"; then
  echo "The protected environment has duplicate COLLECTOR_SCOPE entries." >&2
  exit 1
fi
expected_collector_scope="${expected_collector_scope:-bid_only}"
if [[ "${expected_collector_scope}" != "citywide"
    && "${expected_collector_scope}" != "bid_only" ]]; then
  echo "COLLECTOR_SCOPE must be citywide or bid_only." >&2
  exit 1
fi
if ! container_database_path="$(read_protected_env_value DATABASE_PATH "${current_env}")"; then
  echo "The protected environment has duplicate DATABASE_PATH entries." >&2
  exit 1
fi
container_database_path="${container_database_path:-/data/portal-archive.sqlite}"
if [[ ! "${container_database_path}" =~ ^/data/[A-Za-z0-9][A-Za-z0-9._-]*\.sqlite$ ]]; then
  echo "DATABASE_PATH must be a plain .sqlite file directly inside /data." >&2
  exit 1
fi
database_host_path="/var/lib/nyc-311-live/${container_database_path#/data/}"
if [[ ! -f "${database_host_path}" || -L "${database_host_path}" ]]; then
  echo "The configured SQLite database is missing or is not a regular file." >&2
  exit 1
fi
collector_activity_key="$(sqlite3 "${database_host_path}" \
  "SELECT CASE value WHEN 'bid_only' THEN 'bid_collector_last_attempt_at' ELSE 'last_successful_poll_at' END FROM live_monitor_state WHERE key='collector_scope';")"
collector_activity_key="${collector_activity_key:-last_successful_poll_at}"
if [[ ! -f "${archive}" || -L "${archive}" ]]; then
  echo "The fixed release inbox does not contain ${release_sha}." >&2
  exit 1
fi
if [[ "$(stat -c '%U:%G' "${archive}")" != "root:root" ]]; then
  echo "The release archive must be owned by root." >&2
  exit 1
fi

actual_sha256="$(sha256sum "${archive}" | cut -d' ' -f1)"
if [[ "${actual_sha256}" != "${archive_sha256}" ]]; then
  echo "The uploaded release archive checksum does not match." >&2
  exit 1
fi
if tar --list --gzip --file "${archive}" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "The release archive contains an unsafe path." >&2
  exit 1
fi

rm -rf -- "${staging_directory}"
install -d -m 0755 -o root -g root "${staging_directory}"
tar --extract --gzip --file "${archive}" \
  --directory "${staging_directory}" \
  --no-same-owner --no-same-permissions
chown -R root:root "${staging_directory}"
chmod -R go-w "${staging_directory}"

if [[ ! -f "${staging_directory}/RELEASE_COMMIT" ]]; then
  echo "The release provenance marker is missing." >&2
  exit 1
fi
expanded_release_sha="$(tr -d '[:space:]' < "${staging_directory}/RELEASE_COMMIT")"
if [[ "${expanded_release_sha}" != "${release_sha}" ]]; then
  echo "The archive provenance marker does not match ${release_sha}." >&2
  exit 1
fi

# Fast paths cannot silently deploy collector, database, dependency, or
# infrastructure changes. The assets lane is stricter still: it permits only
# the browser bundle and its tests.
if [[ "${deployment_scope}" == "assets" ]]; then
  if non_asset_changes="$(diff --recursive --brief \
    --exclude=public --exclude=test --exclude='*.md' \
    --exclude=.env --exclude=RELEASE_COMMIT \
    "${current_directory}" "${staging_directory}")"; then
    true
  else
    diff_status=$?
    if [[ ${diff_status} -ne 1 ]]; then
      echo "Could not compare the current and proposed releases." >&2
      exit 1
    fi
    echo "Refusing the assets fast path because non-asset files changed:" >&2
    printf '%s\n' "${non_asset_changes}" >&2
    exit 1
  fi
elif [[ "${deployment_scope}" == "web" ]]; then
  if non_ui_changes="$(diff --recursive --brief \
    --exclude=public --exclude=test --exclude='*.md' \
    --exclude=.env --exclude=RELEASE_COMMIT \
    --exclude=server.js \
    --exclude=nyc311-email-events.js \
    --exclude=sqlite-live-summary.js \
    --exclude=sqlite-email-metrics.js --exclude=email-metrics-presentation.js \
    --exclude=email-metrics-background.js --exclude=email-metrics-worker.js \
    --exclude=operational-health.js \
    --exclude=deploy-ui-release.sh --exclude=deploy-ui.sh \
    "${current_directory}" "${staging_directory}")"; then
    true
  else
    diff_status=$?
    if [[ ${diff_status} -ne 1 ]]; then
      echo "Could not compare the current and proposed releases." >&2
      exit 1
    fi
    echo "Refusing the web fast path because protected application files changed:" >&2
    printf '%s\n' "${non_ui_changes}" >&2
    exit 1
  fi
fi

staging_env="${staging_directory}/aws/lightsail-sqlite/.env"
install -m 0600 -o root -g root "${current_env}" "${staging_env}"
set_env_value() {
  local key="$1"
  local value="$2"
  local target="$3"
  if grep -q "^${key}=" "${target}"; then
    sed -i "s/^${key}=.*/${key}=${value}/" "${target}"
  else
    printf '\n%s=%s\n' "${key}" "${value}" >> "${target}"
  fi
}
if [[ "${deployment_scope}" == "web" ]]; then
  set_env_value WEB_IMAGE_TAG "${release_sha}" "${staging_env}"
elif [[ "${deployment_scope}" == "service" ]]; then
  set_env_value IMAGE_TAG "${release_sha}" "${staging_env}"
  set_env_value WEB_IMAGE_TAG "${release_sha}" "${staging_env}"
fi
chmod 0600 "${staging_env}"

old_sha="$(tr -d '[:space:]' < "${current_directory}/RELEASE_COMMIT")"
if [[ ! "${old_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The current release provenance marker is invalid." >&2
  exit 1
fi
if [[ ! -x "${static_publisher}" ]]; then
  echo "The protected static-release publisher is missing." >&2
  exit 1
fi
# Seed the previous UI before the first stable-mount Caddy cutover. Later
# service releases keep serving this known-good UI until the new API is ready.
"${static_publisher}" "${current_directory}/public" "${old_sha}"
static_before="$(readlink "${asset_root}/current")"
if [[ "${static_before}" != "releases/${old_sha}" ]]; then
  echo "The previous static release was not activated exactly." >&2
  exit 1
fi

release_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
previous_directory="/opt/nyc-311-live-pre-${old_sha}-${release_timestamp}-$$"
failed_directory="/opt/nyc-311-live-failed-${release_sha}-${release_timestamp}-$$"

cd "${current_directory}/aws/lightsail-sqlite"
web_before="$(docker compose ps -q web)"
proxy_before="$(docker compose ps -q proxy)"
collector_before="$(docker compose ps -q collector)"
inbound_email_before="$(docker compose ps -q inbound-email)"
container_fingerprint() {
  local container_id="$1"
  if [[ -z "${container_id}" ]]; then
    printf 'missing'
    return
  fi
  docker inspect --format '{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}' \
    "${container_id}"
}
web_fingerprint_before="$(container_fingerprint "${web_before}")"
proxy_fingerprint_before="$(container_fingerprint "${proxy_before}")"
collector_fingerprint_before="$(container_fingerprint "${collector_before}")"
inbound_email_fingerprint_before="$(container_fingerprint "${inbound_email_before}")"
baseline_poll=""
if [[ "${deployment_scope}" == "service" ]]; then
  baseline_poll="$(sqlite3 "${database_host_path}" \
    "SELECT value FROM live_monitor_state WHERE key='${collector_activity_key}';")"
fi

if [[ "${deployment_scope}" != "assets" ]]; then
  cd "${staging_directory}/aws/lightsail-sqlite"
  docker compose config --quiet
  new_image="nyc-311-sqlite:${release_sha}"
  if ! docker image inspect "${new_image}" >/dev/null 2>&1; then
    docker compose build web
  fi
  image_version="$(docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
    "${new_image}")"
  if [[ "${image_version}" != "${release_sha}" ]]; then
    echo "The built image version label does not match the release." >&2
    exit 1
  fi
fi

directory_phase=0
runtime_activation_started=0
rollback() {
  # An ERR trap inherits the shell's execution context. Disable it before
  # attempting recovery so a failed recovery command cannot recursively move
  # the restored release or let the failed deployment continue.
  trap - ERR
  set +e
  rollback_failures=0
  # Stop the failed release's writer before changing the release directory.
  # The previous release may predate the dedicated inbound-email service, so
  # its Compose file cannot necessarily address this container afterward.
  if [[ ${runtime_activation_started} -eq 1
      && "${deployment_scope}" == "service"
      && -f "${current_directory}/aws/lightsail-sqlite/compose.yml" ]]; then
    if ! (
      cd "${current_directory}/aws/lightsail-sqlite"
      docker compose stop inbound-email
    ); then
      echo "Rollback could not stop the failed inbound-email service." >&2
      rollback_failures=1
    fi
  fi
  if [[ ${directory_phase} -eq 2 && -d "${current_directory}" ]]; then
    if ! mv -- "${current_directory}" "${failed_directory}"; then
      echo "Rollback could not quarantine the failed release." >&2
      rollback_failures=1
    fi
  fi
  if [[ ${directory_phase} -ge 1 ]]; then
    if [[ -d "${previous_directory}" ]]; then
      if ! mv -- "${previous_directory}" "${current_directory}"; then
        echo "Rollback could not restore the previous release directory." >&2
        rollback_failures=1
      fi
    else
      echo "Rollback could not find the previous release directory." >&2
      rollback_failures=1
    fi
  fi
  rollback_link="${asset_root}/.rollback-current-${old_sha}-$$"
  rm -f -- "${rollback_link}"
  if ! ln -s "${static_before}" "${rollback_link}" \
      || ! mv -Tf -- "${rollback_link}" "${asset_root}/current"; then
    echo "Rollback could not restore the previous static release." >&2
    rm -f -- "${rollback_link}"
    rollback_failures=1
  fi
  if [[ ${runtime_activation_started} -eq 1
      && -d "${current_directory}/aws/lightsail-sqlite" ]]; then
    cd "${current_directory}/aws/lightsail-sqlite"
    rollback_poll_before=""
    if [[ "${deployment_scope}" == "service" && -f "${database_host_path}" ]]; then
      rollback_poll_before="$(sqlite3 "${database_host_path}" \
        "SELECT value FROM live_monitor_state WHERE key='${collector_activity_key}';" 2>/dev/null || true)"
    fi
    if [[ "${deployment_scope}" == "service" ]]; then
      rollback_services=(web collector proxy)
      rollback_has_inbound=0
      if docker compose config --services | grep --fixed-strings --line-regexp --quiet inbound-email; then
        rollback_services=(web inbound-email collector proxy)
        rollback_has_inbound=1
      fi
      if ! docker compose up -d --no-build --force-recreate "${rollback_services[@]}"; then
        echo "Rollback could not restart every previous service." >&2
        rollback_failures=1
      fi
    elif [[ "${deployment_scope}" == "web" ]]; then
      # A web-only release must not roll the proxy or isolated writers.
      if ! docker compose up -d --no-build --no-deps --force-recreate web; then
        echo "Rollback could not restart the previous web service." >&2
        rollback_failures=1
      fi
    fi
    if [[ ${rollback_failures} -eq 0 ]]; then
      rollback_runtime_ready=0
      # The first BID-only poll can include bounded recovery for every query
      # zones. Give a restored compatible collector the same ten-minute gate
      # as a forward service activation.
      for _rollback_attempt in $(seq 1 300); do
        if ! curl --fail --silent --max-time 5 \
            http://127.0.0.1:10000/api/health >/dev/null; then
          sleep 2
          continue
        fi
        if [[ "${deployment_scope}" == "service" ]]; then
          if [[ ${rollback_has_inbound} -eq 1 ]] \
              && ! curl --fail --silent --max-time 5 \
                http://127.0.0.1:10001/health >/dev/null; then
            sleep 2
            continue
          fi
          rollback_poll="$(sqlite3 "${database_host_path}" \
            "SELECT value FROM live_monitor_state WHERE key='${collector_activity_key}';" 2>/dev/null || true)"
          if [[ -z "${rollback_poll}" || "${rollback_poll}" == "${rollback_poll_before}" ]]; then
            sleep 2
            continue
          fi
          rollback_scope="$(sqlite3 "${database_host_path}" \
            "SELECT value FROM live_monitor_state WHERE key='collector_scope';" 2>/dev/null || true)"
          if [[ "${rollback_scope}" != "${expected_collector_scope}" ]]; then
            sleep 2
            continue
          fi
        fi
        rollback_runtime_ready=1
        break
      done
      if [[ ${rollback_runtime_ready} -ne 1 ]]; then
        echo "Rollback restored files but the previous runtime did not become healthy." >&2
        rollback_failures=1
      fi
    fi
  fi
  if [[ ${rollback_failures} -eq 0 ]]; then
    echo "${deployment_scope} deployment failed; the previous release was restored." >&2
  else
    echo "${deployment_scope} deployment failed and rollback was incomplete; immediate operator attention is required." >&2
  fi
  exit 1
}
trap rollback ERR

mv -- "${current_directory}" "${previous_directory}"
directory_phase=1
mv -- "${staging_directory}" "${current_directory}"
directory_phase=2

if [[ "${deployment_scope}" == "assets" ]]; then
  "${static_publisher}" "${current_directory}/public" "${release_sha}"
fi

cd "${current_directory}/aws/lightsail-sqlite"
if [[ "${deployment_scope}" == "service" ]]; then
  # On the first isolated-ingress release the old proxy still routes inbound
  # mail to web. Bring the new writer up first, wait for it, then switch the
  # proxy before replacing web so no webhook can land on a 404 route.
  runtime_activation_started=1
  docker compose up -d --no-build --force-recreate inbound-email
  pre_proxy_inbound_ready=0
  for _attempt in $(seq 1 30); do
    if curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
        http://127.0.0.1:10001/health >/dev/null; then
      pre_proxy_inbound_ready=1
      break
    fi
    sleep 2
  done
  if [[ ${pre_proxy_inbound_ready} -ne 1 ]]; then
    echo "The isolated inbound-email service was not ready for proxy cutover." >&2
    false
  fi
  docker compose up -d --no-build --no-deps --force-recreate proxy
  docker compose up -d --no-build --no-deps --force-recreate web collector
elif [[ "${deployment_scope}" == "web" ]]; then
  # Caddy reads the atomically switched static release from its stable mount.
  # Only Express changed, so keep the proxy and both isolated writers running.
  runtime_activation_started=1
  docker compose up -d --no-build --no-deps --force-recreate web
fi

healthy=0
for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
      http://127.0.0.1:10000/api/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done
if [[ ${healthy} -ne 1 ]]; then
  echo "The local web health check did not recover in time." >&2
  false
fi
if [[ "${deployment_scope}" == "web" ]]; then
  # Publish the matching browser code only after its API is healthy. This keeps
  # a new interface from briefly calling the previous API implementation.
  "${static_publisher}" "${current_directory}/public" "${release_sha}"
fi

web_container="$(docker compose ps -q web)"
proxy_after="$(docker compose ps -q proxy)"
collector_after="$(docker compose ps -q collector)"
inbound_email_after="$(docker compose ps -q inbound-email)"
web_fingerprint_after="$(container_fingerprint "${web_container}")"
proxy_fingerprint_after="$(container_fingerprint "${proxy_after}")"
collector_fingerprint_after="$(container_fingerprint "${collector_after}")"
inbound_email_fingerprint_after="$(container_fingerprint "${inbound_email_after}")"
if [[ "${deployment_scope}" == "assets" ]]; then
  if [[ "${web_fingerprint_before}" == "missing"
      || "${web_fingerprint_after}" != "${web_fingerprint_before}"
      || "${proxy_fingerprint_before}" == "missing"
      || "${proxy_fingerprint_after}" != "${proxy_fingerprint_before}"
      || "${collector_fingerprint_before}" == "missing"
      || "${collector_fingerprint_after}" != "${collector_fingerprint_before}"
      || "${inbound_email_fingerprint_before}" == "missing"
      || "${inbound_email_fingerprint_after}" != "${inbound_email_fingerprint_before}" ]]; then
    echo "A container started or restarted during the restart-free assets deployment." >&2
    false
  fi
else
  running_image_version="$(docker inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
    "${web_container}")"
  if [[ "${running_image_version}" != "${release_sha}" ]]; then
    echo "The running web container is not the requested release." >&2
    false
  fi
fi
if [[ "${deployment_scope}" == "web" ]]; then
  if [[ "${proxy_fingerprint_before}" == "missing"
      || "${proxy_fingerprint_after}" != "${proxy_fingerprint_before}"
      || "${collector_fingerprint_before}" == "missing"
      || "${collector_fingerprint_after}" != "${collector_fingerprint_before}"
      || "${inbound_email_fingerprint_before}" == "missing"
      || "${inbound_email_fingerprint_after}" != "${inbound_email_fingerprint_before}" ]]; then
    echo "The proxy or an isolated writer started or restarted during a web deployment." >&2
    false
  fi
fi
if [[ "${deployment_scope}" == "service" ]]; then
  inbound_email_ready=0
  for _attempt in $(seq 1 30); do
    if curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
        http://127.0.0.1:10001/health >/dev/null; then
      inbound_email_ready=1
      break
    fi
    sleep 2
  done
  if [[ ${inbound_email_ready} -ne 1 ]]; then
    echo "The isolated inbound-email service did not become healthy." >&2
    false
  fi
  inbound_email_container="$(docker compose ps -q inbound-email)"
  inbound_email_image_version="$(docker inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
    "${inbound_email_container}")"
  if [[ "${inbound_email_image_version}" != "${release_sha}" ]]; then
    echo "The running inbound-email container is not the requested release." >&2
    false
  fi
  collector_image_version="$(docker inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
    "${collector_after}")"
  if [[ "${collector_image_version}" != "${release_sha}" ]]; then
    echo "The running collector is not the requested release." >&2
    false
  fi
  collector_started_at="$(docker inspect \
    --format '{{ .State.StartedAt }}' "${collector_after}")"
  collector_started_epoch="$(date --date "${collector_started_at}" +%s)"
  fresh_poll=""
  # A BID-only poll can include same-day recovery and spatial splitting for
  # every query zone. Two minutes caused a healthy activation to be rolled
  # back mid-cycle; ten minutes still fails closed while covering the bounded
  # worst case of the Portal client's retries and timeouts.
  for _attempt in $(seq 1 300); do
    current_poll="$(sqlite3 "${database_host_path}" \
      "SELECT value FROM live_monitor_state WHERE key='${collector_activity_key}';")"
    current_poll_epoch="$(date --date "${current_poll}" +%s 2>/dev/null || true)"
    if [[ -n "${current_poll}" && "${current_poll}" != "${baseline_poll}"
        && -n "${current_poll_epoch}"
        && "${current_poll_epoch}" -ge "${collector_started_epoch}" ]]; then
      if curl --fail --silent --connect-timeout 3 --max-time 5 \
          http://127.0.0.1:10000/api/health/collector >/dev/null; then
        fresh_poll="${current_poll}"
        break
      fi
    fi
    sleep 2
  done
  if [[ -z "${fresh_poll}" ]]; then
    echo "The updated collector did not record fresh Portal collection activity." >&2
    false
  fi
  recorded_collector_scope="$(sqlite3 "${database_host_path}" \
    "SELECT value FROM live_monitor_state WHERE key='collector_scope';")"
  if [[ "${recorded_collector_scope}" != "${expected_collector_scope}" ]]; then
    echo "The updated collector recorded '${recorded_collector_scope:-missing}' scope; expected '${expected_collector_scope}'." >&2
    false
  fi
  curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
    http://127.0.0.1:10000/api/health/collector >/dev/null
fi

if [[ "${deployment_scope}" == "service" ]]; then
  # Keep the prior UI visible until the new API, inbound receiver, collector,
  # and fresh Portal poll have all passed their independent health gates.
  "${static_publisher}" "${current_directory}/public" "${release_sha}"
fi

static_release="${asset_root}/releases/${release_sha}"
expected_js_sha="$(sha256sum "${static_release}/js/live-dashboard.js" | cut -d' ' -f1)"
expected_css_sha="$(sha256sum "${static_release}/css/live-ui.css" | cut -d' ' -f1)"
expected_vendor_sha="$(sha256sum "${static_release}/vendor/leaflet/leaflet.js" | cut -d' ' -f1)"
public_ready=0
for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
      "${public_health_url}" >/dev/null 2>&1; then
    public_shell="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
      "${public_shell_url}" 2>/dev/null || true)"
    public_manifest="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
      "${public_manifest_url}?release=${release_sha}" 2>/dev/null || true)"
    public_js_sha="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
      "${public_js_url}" 2>/dev/null | sha256sum | cut -d' ' -f1 || true)"
    public_css_sha="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
      "${public_css_url}" 2>/dev/null | sha256sum | cut -d' ' -f1 || true)"
    public_vendor_sha="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
      "${public_vendor_url}" 2>/dev/null | sha256sum | cut -d' ' -f1 || true)"
    if [[ "${public_shell}" == *"<title>NYC BID 311 Live</title>"*
        && "${public_shell}" == *"/_ui/${release_sha}/js/live-dashboard.js"*
        && "${public_shell}" == *"/_ui/${release_sha}/css/live-ui.css"*
        && "$(printf '%s' "${public_manifest}" | tr -d '[:space:]')" \
          == "{\"release_sha\":\"${release_sha}\"}"
        && "${public_js_sha}" == "${expected_js_sha}"
        && "${public_css_sha}" == "${expected_css_sha}"
        && "${public_vendor_sha}" == "${expected_vendor_sha}" ]]; then
      public_ready=1
      break
    fi
  fi
  sleep 2
done
if [[ ${public_ready} -ne 1 ]]; then
  echo "The public HTTPS health check and exact versioned assets did not become ready in time." >&2
  false
fi

trap - ERR
rm -f -- "${archive}"
case "${deployment_scope}" in
  assets)
    echo "Assets release ${release_sha} is live. No container restarted; the database was untouched."
    ;;
  web)
    echo "Web release ${release_sha} is healthy. Proxy, inbound email, collector, and database were untouched."
    ;;
  service)
    echo "Service release ${release_sha} is healthy. Web, inbound email, and collector are current; the database was preserved."
    ;;
esac
