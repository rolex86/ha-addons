#!/usr/bin/with-contenv bash
set -e

DATA_BASE="/data/stremio-hellspy"
mkdir -p "${DATA_BASE}"
mkdir -p "${DATA_BASE}/cache_hellspy_php"
touch "${DATA_BASE}/addon.log"

# Ensure permissions
chown -R nginx:nginx "${DATA_BASE}" || true
chmod -R 755 "${DATA_BASE}/cache_hellspy_php"
chmod 644 "${DATA_BASE}/addon.log"
