#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required. Install Node.js 18+ or 20+ first." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required." >&2
  exit 1
fi

npm ci --prefix backend
npm ci --prefix frontend
npm run build
npm prune --prefix backend --omit=dev

mkdir -p data

echo "Build complete."
echo "Run: WATCHER_PORT=33099 npm start"
echo "Or install deploy/server-watcher.service with systemd."
