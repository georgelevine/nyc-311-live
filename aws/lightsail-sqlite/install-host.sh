#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

deployment_directory="/opt/nyc-311-live/aws/lightsail-sqlite"
if [[ ! -f "${deployment_directory}/compose.yml" ]]; then
  echo "Install the repository at /opt/nyc-311-live before running this script." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl docker.io git sqlite3 unattended-upgrades util-linux

if ! docker compose version >/dev/null 2>&1; then
  if apt-get install -y docker-compose-v2; then
    true
  else
    apt-get install -y docker-compose-plugin
  fi
fi

systemctl enable --now docker
chown -R root:root /opt/nyc-311-live
chmod -R go-w /opt/nyc-311-live
install -d -m 0750 -o 10001 -g 10001 /var/lib/nyc-311-live
install -d -m 0700 -o root -g root /var/lib/nyc-311-live-imports
install -d -m 0750 -o 10001 -g 10001 /var/backups/nyc-311-live
install -d -m 0750 -o root -g 10001 /var/lib/nyc-311-live-lock
collector_lock="/var/lib/nyc-311-live-lock/collector.lock"
if [[ -L "${collector_lock}" || ( -e "${collector_lock}" && ! -f "${collector_lock}" ) ]]; then
  echo "Collector lock path is not a regular file." >&2
  exit 1
fi
if [[ ! -e "${collector_lock}" ]]; then
  install -m 0660 -o root -g 10001 /dev/null "${collector_lock}"
else
  if [[ "$(stat -c '%h' "${collector_lock}")" != "1" ]]; then
    echo "Collector lock path must not have additional hard links." >&2
    exit 1
  fi
  chown root:10001 "${collector_lock}"
  chmod 0660 "${collector_lock}"
fi
install_lock="/var/lib/nyc-311-live-lock/install.lock"
if [[ -L "${install_lock}" || ( -e "${install_lock}" && ! -f "${install_lock}" ) ]]; then
  echo "Installer lock path is not a regular file." >&2
  exit 1
fi
if [[ ! -e "${install_lock}" ]]; then
  install -m 0600 -o root -g root /dev/null "${install_lock}"
else
  if [[ "$(stat -c '%h' "${install_lock}")" != "1" ]]; then
    echo "Installer lock path must not have additional hard links." >&2
    exit 1
  fi
  chown root:root "${install_lock}"
  chmod 0600 "${install_lock}"
fi

if ! swapon --show=NAME --noheadings | grep -Fxq /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 1G /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
if ! grep -Fq '/swapfile none swap sw 0 0' /etc/fstab; then
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -m 0644 "${deployment_directory}/systemd/nyc311-backup.service" /etc/systemd/system/
install -m 0644 "${deployment_directory}/systemd/nyc311-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nyc311-backup.timer

echo "Host preparation complete. Configure ${deployment_directory}/.env before installing data."
