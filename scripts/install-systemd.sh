#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_SRC="$ROOT_DIR/deploy/server-watcher.service"
SERVICE_DST="/etc/systemd/system/server-watcher.service"

if [[ ! -f "$SERVICE_SRC" ]]; then
  echo "Missing $SERVICE_SRC" >&2
  exit 1
fi

sudo cp "$SERVICE_SRC" "$SERVICE_DST"
sudo systemctl daemon-reload
sudo systemctl enable --now server-watcher.service
sudo systemctl status server-watcher.service --no-pager
