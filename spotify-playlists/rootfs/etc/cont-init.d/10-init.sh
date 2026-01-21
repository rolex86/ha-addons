#!/usr/bin/with-contenv bash
set -euo pipefail

DATA_DIR="/data"
mkdir -p "${DATA_DIR}"

# Ensure files exist
[ -f "${DATA_DIR}/config.json" ] || echo '{"recipes":[]}' > "${DATA_DIR}/config.json"
[ -f "${DATA_DIR}/tokens.json" ] || echo '{}' > "${DATA_DIR}/tokens.json"

echo "[init] data dir ready: ${DATA_DIR}"
