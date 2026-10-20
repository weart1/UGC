#!/usr/bin/env bash
# Archives projects and settings to ./backups (keeps the last 7).
# Daily via cron:  0 4 * * * /opt/ugc/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
tar --exclude='data/.models' -czf "backups/ugc-$(date +%F).tar.gz" data .env ugc.config.json
ls -1t backups/ugc-*.tar.gz | tail -n +8 | xargs -r rm --
echo "Бэкап: backups/ugc-$(date +%F).tar.gz"
