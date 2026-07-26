#!/usr/bin/env bash
set -euo pipefail

repository_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_host="${LIGHTSAIL_HOST:-34.201.212.109}"
deploy_user="${LIGHTSAIL_USER:-ubuntu}"
deploy_key="${LIGHTSAIL_KEY:-${HOME}/Downloads/LightsailDefaultKey-us-east-1.pem}"
public_health_url="${PUBLIC_HEALTH_URL:-https://311.georgelevine.com/api/health}"
deployment_scope="${DEPLOY_SCOPE:-web}"
deploy_started_epoch="$(date +%s)"
deploy_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ "${deployment_scope}" != "web" && "${deployment_scope}" != "service" ]]; then
  echo "DEPLOY_SCOPE must be web or service." >&2
  exit 1
fi

cd "${repository_directory}"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit the ${deployment_scope} change before deploying it." >&2
  exit 1
fi
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "The production web app deploys only from the main branch." >&2
  exit 1
fi
release_sha="$(git rev-parse HEAD)"
if [[ ! "${release_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Could not resolve the full release commit." >&2
  exit 1
fi
remote_main_sha="$(git rev-parse origin/main)"
if [[ "${release_sha}" != "${remote_main_sha}" ]]; then
  echo "Push ${release_sha} to origin/main before deploying it." >&2
  exit 1
fi
if [[ ! -f "${deploy_key}" ]]; then
  echo "Lightsail SSH key not found at ${deploy_key}." >&2
  exit 1
fi
if [[ "$(stat -f '%Lp' "${deploy_key}")" != "600" ]]; then
  echo "Set the Lightsail SSH key to mode 600 before deploying." >&2
  exit 1
fi

phase_started_epoch="$(date +%s)"
npm test
tests_seconds=$(($(date +%s) - phase_started_epoch))

working_directory="$(mktemp -d "${TMPDIR:-/tmp}/nyc311-ui-deploy.XXXXXX")"
trap 'rm -rf -- "${working_directory}"' EXIT
archive="${working_directory}/${release_sha}.tar.gz"
phase_started_epoch="$(date +%s)"
git archive --format=tar.gz --output "${archive}" "${release_sha}"
archive_sha256="$(shasum -a 256 "${archive}" | cut -d' ' -f1)"
archive_seconds=$(($(date +%s) - phase_started_epoch))
remote_upload="/tmp/nyc311-ui-${release_sha}.tar.gz"
release_helper="${repository_directory}/aws/lightsail-sqlite/deploy-ui-release.sh"
remote_helper="/tmp/nyc311-deploy-ui-release-${release_sha}"
helper_sha256="$(shasum -a 256 "${release_helper}" | cut -d' ' -f1)"

ssh_options=(
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -i "${deploy_key}"
)

phase_started_epoch="$(date +%s)"
scp "${ssh_options[@]}" "${archive}" \
  "${deploy_user}@${deploy_host}:${remote_upload}"
scp "${ssh_options[@]}" "${release_helper}" \
  "${deploy_user}@${deploy_host}:${remote_helper}"
upload_seconds=$(($(date +%s) - phase_started_epoch))
phase_started_epoch="$(date +%s)"
ssh "${ssh_options[@]}" "${deploy_user}@${deploy_host}" \
  "printf '%s  %s\n' '${helper_sha256}' '${remote_helper}' | sha256sum --check --status && \
   sudo install -m 0755 -o root -g root '${remote_helper}' \
     /usr/local/sbin/nyc311-deploy-ui-release && \
   rm -f '${remote_helper}' && \
   sudo install -d -m 0700 -o root -g root /var/lib/nyc-311-live-releases/inbox && \
   sudo install -m 0600 -o root -g root '${remote_upload}' \
     '/var/lib/nyc-311-live-releases/inbox/${release_sha}.tar.gz' && \
   rm -f '${remote_upload}' && \
   sudo /usr/local/sbin/nyc311-deploy-ui-release \
     '${release_sha}' '${archive_sha256}' '${deployment_scope}'"
remote_activate_seconds=$(($(date +%s) - phase_started_epoch))

phase_started_epoch="$(date +%s)"
curl --fail --silent --show-error "${public_health_url}" >/dev/null
visible_seconds=$(($(date +%s) - phase_started_epoch))
finished_epoch="$(date +%s)"
deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
total_seconds=$((finished_epoch - deploy_started_epoch))
package_upload_seconds=$((archive_seconds + upload_seconds))
short_sha="$(git rev-parse --short=7 "${release_sha}")"
release_info="${working_directory}/release-info.json"
{
  printf '{\n'
  printf '  "release_sha": "%s",\n' "${release_sha}"
  printf '  "short_sha": "%s",\n' "${short_sha}"
  printf '  "branch": "main",\n'
  printf '  "deployed_at": "%s",\n' "${deployed_at}"
  printf '  "started_at": "%s",\n' "${deploy_started_at}"
  printf '  "site_url": "https://311.georgelevine.com",\n'
  printf '  "phase_seconds": {\n'
  printf '    "tests": %s,\n' "${tests_seconds}"
  printf '    "archive": %s,\n' "${archive_seconds}"
  printf '    "upload": %s,\n' "${upload_seconds}"
  printf '    "package_upload": %s,\n' "${package_upload_seconds}"
  printf '    "remote_activate": %s,\n' "${remote_activate_seconds}"
  printf '    "public_health_check": %s,\n' "${visible_seconds}"
  printf '    "total": %s\n' "${total_seconds}"
  printf '  }\n'
  printf '}\n'
} > "${release_info}"
remote_release_info="/tmp/nyc311-release-info-${release_sha}.json"
scp "${ssh_options[@]}" "${release_info}" \
  "${deploy_user}@${deploy_host}:${remote_release_info}"
ssh "${ssh_options[@]}" "${deploy_user}@${deploy_host}" \
  "sudo install -m 0644 -o root -g root '${remote_release_info}' \
     /var/lib/nyc-311-live/release-info.json && \
   rm -f '${remote_release_info}'"

echo "Deployed ${deployment_scope} release ${release_sha} to https://311.georgelevine.com"
echo "Deployment timing: total ${total_seconds}s (tests ${tests_seconds}s, package+upload ${package_upload_seconds}s, server switch ${remote_activate_seconds}s, live check ${visible_seconds}s)"
