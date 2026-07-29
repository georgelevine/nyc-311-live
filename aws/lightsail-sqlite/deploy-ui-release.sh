#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this deployment helper with sudo." >&2
  exit 1
fi

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: deploy-ui-release.sh GIT_SHA ARCHIVE_SHA256 [web|service]" >&2
  exit 1
fi

release_sha="$1"
archive_sha256="$2"
deployment_scope="${3:-web}"
if [[ ! "${release_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The release must be identified by a full lowercase Git SHA." >&2
  exit 1
fi
if [[ ! "${archive_sha256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "The archive checksum must be a lowercase SHA-256 digest." >&2
  exit 1
fi
if [[ "${deployment_scope}" != "web" && "${deployment_scope}" != "service" ]]; then
  echo "Deployment scope must be web or service." >&2
  exit 1
fi

current_directory="/opt/nyc-311-live"
release_root="/var/lib/nyc-311-live-releases"
archive="${release_root}/inbox/${release_sha}.tar.gz"
staging_directory="/opt/nyc-311-live-stage-${release_sha}"
lock_file="/var/lib/nyc-311-live-lock/install.lock"
public_health_url="https://311.georgelevine.com/api/health"

exec 9>"${lock_file}"
if ! flock --exclusive --nonblock 9; then
  echo "Another install or deployment is already running." >&2
  exit 1
fi

if [[ ! -d "${current_directory}" || ! -f "${current_directory}/aws/lightsail-sqlite/.env" ]]; then
  echo "The current Lightsail release or its protected environment file is missing." >&2
  exit 1
fi
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

# This fast path is deliberately limited to browser assets, their tests,
# server.js dashboard endpoints, and read-only metrics modules. It cannot
# silently deploy collector, database, dependency, or general infrastructure
# changes.
if [[ "${deployment_scope}" == "web" ]]; then
  if non_ui_changes="$(diff --recursive --brief \
    --exclude=public --exclude=test --exclude=.env --exclude=RELEASE_COMMIT \
    --exclude=server.js \
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

current_env="${current_directory}/aws/lightsail-sqlite/.env"
staging_env="${staging_directory}/aws/lightsail-sqlite/.env"
install -m 0600 -o root -g root "${current_env}" "${staging_env}"
if grep -q '^IMAGE_TAG=' "${staging_env}"; then
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${release_sha}/" "${staging_env}"
else
  printf '\nIMAGE_TAG=%s\n' "${release_sha}" >> "${staging_env}"
fi
chmod 0600 "${staging_env}"

old_sha="$(tr -d '[:space:]' < "${current_directory}/RELEASE_COMMIT")"
if [[ ! "${old_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The current release provenance marker is invalid." >&2
  exit 1
fi
previous_directory="/opt/nyc-311-live-pre-${old_sha}-$(date -u +%Y%m%dT%H%M%SZ)"
failed_directory="/opt/nyc-311-live-failed-${release_sha}-$(date -u +%Y%m%dT%H%M%SZ)"

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

collector_before="$(cd "${current_directory}/aws/lightsail-sqlite" && docker compose ps -q collector)"
baseline_poll="$(sqlite3 /var/lib/nyc-311-live/portal-archive.sqlite \
  "SELECT value FROM live_monitor_state WHERE key='last_successful_poll_at';")"
mv -- "${current_directory}" "${previous_directory}"
mv -- "${staging_directory}" "${current_directory}"

rollback() {
  set +e
  if [[ -d "${current_directory}" ]]; then
    mv -- "${current_directory}" "${failed_directory}"
  fi
  if [[ -d "${previous_directory}" ]]; then
    mv -- "${previous_directory}" "${current_directory}"
    cd "${current_directory}/aws/lightsail-sqlite"
    if [[ "${deployment_scope}" == "service" ]]; then
      docker compose up -d --no-build web collector
    else
      docker compose up -d --no-build web
    fi
  fi
  echo "${deployment_scope} deployment failed and the previous release was restored." >&2
}
trap rollback ERR

cd "${current_directory}/aws/lightsail-sqlite"
if [[ "${deployment_scope}" == "service" ]]; then
  docker compose up -d --no-build web collector
else
  docker compose up -d --no-build web
fi

healthy=0
for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error \
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
curl --fail --silent --show-error "${public_health_url}" >/dev/null

web_container="$(docker compose ps -q web)"
running_image_version="$(docker inspect \
  --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
  "${web_container}")"
if [[ "${running_image_version}" != "${release_sha}" ]]; then
  echo "The running web container is not the requested release." >&2
  false
fi
collector_after="$(docker compose ps -q collector)"
if [[ "${deployment_scope}" == "web"
    && -n "${collector_before}" && "${collector_after}" != "${collector_before}" ]]; then
  echo "The collector changed during a UI-only deployment." >&2
  false
fi
if [[ "${deployment_scope}" == "service" ]]; then
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
  for _attempt in $(seq 1 60); do
    current_poll="$(sqlite3 /var/lib/nyc-311-live/portal-archive.sqlite \
      "SELECT value FROM live_monitor_state WHERE key='last_successful_poll_at';")"
    current_poll_epoch="$(date --date "${current_poll}" +%s 2>/dev/null || true)"
    if [[ -n "${current_poll}" && "${current_poll}" != "${baseline_poll}"
        && -n "${current_poll_epoch}"
        && "${current_poll_epoch}" -ge "${collector_started_epoch}" ]]; then
      fresh_poll="${current_poll}"
      break
    fi
    sleep 2
  done
  if [[ -z "${fresh_poll}" ]]; then
    echo "The updated collector did not complete a fresh Portal poll." >&2
    false
  fi
  curl --fail --silent --show-error \
    http://127.0.0.1:10000/api/health/collector >/dev/null
fi

trap - ERR
rm -f -- "${archive}"
if [[ "${deployment_scope}" == "service" ]]; then
  echo "Service release ${release_sha} is healthy. Web and collector are current; the database was preserved."
else
  echo "Web release ${release_sha} is healthy. Collector and database were untouched."
fi
