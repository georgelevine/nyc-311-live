#!/usr/bin/env bash
set -euo pipefail

repository_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_host="${LIGHTSAIL_HOST:-34.201.212.109}"
deploy_user="${LIGHTSAIL_USER:-ubuntu}"
deploy_key="${LIGHTSAIL_KEY:-${HOME}/Downloads/LightsailDefaultKey-us-east-1.pem}"

cd "${repository_directory}"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit the web change before deploying it." >&2
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

npm test

working_directory="$(mktemp -d "${TMPDIR:-/tmp}/nyc311-ui-deploy.XXXXXX")"
trap 'rm -rf -- "${working_directory}"' EXIT
archive="${working_directory}/${release_sha}.tar.gz"
git archive --format=tar.gz --output "${archive}" "${release_sha}"
archive_sha256="$(shasum -a 256 "${archive}" | cut -d' ' -f1)"
remote_upload="/tmp/nyc311-ui-${release_sha}.tar.gz"
release_helper="${repository_directory}/aws/lightsail-sqlite/deploy-ui-release.sh"
remote_helper="/tmp/nyc311-deploy-ui-release-${release_sha}"
helper_sha256="$(shasum -a 256 "${release_helper}" | cut -d' ' -f1)"

ssh_options=(
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -i "${deploy_key}"
)

scp "${ssh_options[@]}" "${archive}" \
  "${deploy_user}@${deploy_host}:${remote_upload}"
scp "${ssh_options[@]}" "${release_helper}" \
  "${deploy_user}@${deploy_host}:${remote_helper}"
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
     '${release_sha}' '${archive_sha256}'"

echo "Deployed web release ${release_sha} to https://311.georgelevine.com"
