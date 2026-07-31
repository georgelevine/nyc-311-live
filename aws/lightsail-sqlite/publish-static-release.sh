#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this publisher with sudo." >&2
  exit 1
fi

if [[ $# -ne 2 ]]; then
  echo "Usage: publish-static-release.sh PUBLIC_DIRECTORY GIT_SHA" >&2
  exit 1
fi

source_directory="$1"
release_sha="$2"
asset_root="/var/lib/nyc-311-live-assets"
asset_releases="${asset_root}/releases"
asset_lock="/var/lib/nyc-311-live-lock/static-release.lock"

if [[ ! "${release_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The static release must be identified by a full lowercase Git SHA." >&2
  exit 1
fi
if [[ ! -d "${source_directory}" || -L "${source_directory}"
    || ! -f "${source_directory}/live.html" ]]; then
  echo "PUBLIC_DIRECTORY must be a regular directory containing live.html." >&2
  exit 1
fi
if [[ -n "$(find "${source_directory}" -type l -print -quit)" ]]; then
  echo "Static releases cannot contain symbolic links." >&2
  exit 1
fi
if [[ -L "${asset_root}" || ( -e "${asset_root}" && ! -d "${asset_root}" )
    || -L "${asset_releases}"
    || ( -e "${asset_releases}" && ! -d "${asset_releases}" ) ]]; then
  echo "The static release root must be a regular directory, not a symbolic link." >&2
  exit 1
fi

install -d -m 0755 -o root -g root "${asset_root}" "${asset_releases}"
if [[ "$(stat -c '%u:%g' "${asset_root}")" != "0:0"
    || "$(stat -c '%u:%g' "${asset_releases}")" != "0:0"
    || -n "$(find "${asset_root}" "${asset_releases}" -maxdepth 0 -perm /022 -print -quit)" ]]; then
  echo "The static release directories must be root-owned and not group- or world-writable." >&2
  exit 1
fi

install -d -m 0750 -o root -g 10001 /var/lib/nyc-311-live-lock
if [[ -L "${asset_lock}" || ( -e "${asset_lock}" && ! -f "${asset_lock}" ) ]]; then
  echo "The static release lock path is unsafe." >&2
  exit 1
fi
if [[ ! -e "${asset_lock}" ]]; then
  install -m 0600 -o root -g root /dev/null "${asset_lock}"
elif [[ "$(stat -c '%u:%g' "${asset_lock}")" != "0:0"
    || "$(stat -c '%a' "${asset_lock}")" != "600"
    || "$(stat -c '%h' "${asset_lock}")" != "1" ]]; then
  echo "The static release lock must be root-owned, mode 0600, with one link." >&2
  exit 1
fi
exec 9<>"${asset_lock}"
if ! flock --exclusive --nonblock 9; then
  echo "Another static release is being published." >&2
  exit 1
fi

destination="${asset_releases}/${release_sha}"
temporary=""
switch_directory=""
cleanup() {
  if [[ -n "${temporary}" && -d "${temporary}" ]]; then
    rm -rf -- "${temporary}"
  fi
  if [[ -n "${switch_directory}" && -d "${switch_directory}" ]]; then
    rm -rf -- "${switch_directory}"
  fi
}
trap cleanup EXIT

verify_release() {
  local directory="$1"
  if [[ ! -d "${directory}" || -L "${directory}"
      || ! -f "${directory}/release.json"
      || ! -f "${directory}/SHA256SUMS"
      || "$(tr -d '[:space:]' < "${directory}/release.json")" \
        != "{\"release_sha\":\"${release_sha}\"}"
      || -n "$(find "${directory}" -type l -print -quit)"
      || -n "$(find "${directory}" ! -user root -print -quit)"
      || -n "$(find "${directory}" -perm /022 -print -quit)" ]]; then
    return 1
  fi
  (cd "${directory}" && sha256sum --check --status SHA256SUMS)
}

if [[ -e "${destination}" || -L "${destination}" ]]; then
  if ! verify_release "${destination}"; then
    echo "The existing static release ${release_sha} is invalid." >&2
    exit 1
  fi
else
  temporary="$(mktemp -d "${asset_root}/.stage-${release_sha}.XXXXXX")"
  cp -a "${source_directory}/." "${temporary}/"
  if [[ -n "$(find "${temporary}" -type l -print -quit)" ]]; then
    echo "Static releases cannot contain symbolic links." >&2
    exit 1
  fi

  # The mutable shell points only at this release's immutable asset paths.
  # Browsers therefore cannot combine old HTML with new JavaScript or CSS.
  sed -i -E \
    "s#(href|src)=\"/(css|js|vendor)/#\\1=\"/_ui/${release_sha}/\\2/#g" \
    "${temporary}/live.html"
  required_asset_paths=(
    "/_ui/${release_sha}/js/live-dashboard.js"
    "/_ui/${release_sha}/css/live-ui.css"
    "/_ui/${release_sha}/vendor/leaflet/leaflet.js"
  )
  for required_asset_path in "${required_asset_paths[@]}"; do
    if [[ "$(grep -F -c "${required_asset_path}" "${temporary}/live.html")" != "1" ]]; then
      echo "The dashboard shell did not receive immutable path ${required_asset_path}." >&2
      exit 1
    fi
  done
  printf '{"release_sha":"%s"}\n' "${release_sha}" > "${temporary}/release.json"
  (
    cd "${temporary}"
    find . -type f ! -name SHA256SUMS -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 sha256sum > SHA256SUMS
  )
  chown -R root:root "${temporary}"
  find "${temporary}" -type d -exec chmod 0755 {} +
  find "${temporary}" -type f -exec chmod 0644 {} +
  if ! verify_release "${temporary}"; then
    echo "The staged static release ${release_sha} failed verification." >&2
    exit 1
  fi
  mv -- "${temporary}" "${destination}"
  temporary=""
fi

switch_directory="$(mktemp -d "${asset_root}/.switch-${release_sha}.XXXXXX")"
ln -s "releases/${release_sha}" "${switch_directory}/current"
mv -Tf -- "${switch_directory}/current" "${asset_root}/current"
rmdir -- "${switch_directory}"
switch_directory=""

if [[ "$(readlink "${asset_root}/current")" != "releases/${release_sha}"
    || ! -f "${asset_root}/current/live.html" ]] \
    || ! verify_release "${destination}"; then
  echo "The static release pointer did not switch to ${release_sha}." >&2
  exit 1
fi

echo "Published static release ${release_sha}."
