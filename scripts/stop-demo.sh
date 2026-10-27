#!/usr/bin/env bash
# Stop the local demo. Data is kept; scripts/start-demo.sh brings it back.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.demo ] || { echo "No .env.demo found; nothing to stop."; exit 0; }
docker compose --env-file .env.demo stop
echo "Demo stopped. Data is kept in Docker volumes."
