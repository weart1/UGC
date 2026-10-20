#!/usr/bin/env bash
# Pulls the latest code and restarts. Data and .env stay as they are;
# running generations are picked up again after the restart.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose --profile https up -d --build
docker image prune -f >/dev/null
echo "Обновлено: $(git log -1 --format='%h %s')"
