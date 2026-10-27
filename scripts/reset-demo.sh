#!/usr/bin/env bash
# Delete ALL local demo data (database, Redis, uploaded creatives) and start
# again from a fresh seed. Only affects the blissnova-demo Docker project.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" != "--yes" ]; then
  read -r -p "This deletes all local demo data and re-seeds it. Continue? [y/N] " a
  case "$a" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 0 ;; esac
fi
if [ -f .env.demo ]; then docker compose --env-file .env.demo down -v --remove-orphans; fi
exec "$(dirname "$0")/start-demo.sh"
