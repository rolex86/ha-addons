#!/usr/bin/with-contenv bash
set -euo pipefail

DATA_DIR="/data/moode-radios"

mkdir -p \
  "${DATA_DIR}" \
  "${DATA_DIR}/cache" \
  "${DATA_DIR}/cache/logos" \
  "${DATA_DIR}/exports" \
  "${DATA_DIR}/reports"

echo "[init] moOde radios data dir ready: ${DATA_DIR}"
