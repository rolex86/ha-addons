#!/usr/bin/with-contenv bash
set -euo pipefail

DATA_DIR="/data/moode-radios"

mkdir -p \
  "${DATA_DIR}" \
  "${DATA_DIR}/cache" \
  "${DATA_DIR}/cache/logos" \
  "${DATA_DIR}/exports" \
  "${DATA_DIR}/reports"

if [ ! -f "${DATA_DIR}/pinned_stations.json" ]; then
  echo "[]" > "${DATA_DIR}/pinned_stations.json"
fi

echo "[init] moOde radios data dir ready: ${DATA_DIR}"
