#!/usr/bin/with-contenv bash
set -euo pipefail

mkdir -p /data/posters /data/backdrops /data/metadata /data/logs
touch /data/logs/scan.log

echo "[init] NAS Stremio Bridge data directories prepared"
