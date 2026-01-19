#!/usr/bin/with-contenv bashio
CONFIG_PATH=/data/options.json

export TRAKT_CLIENT_ID=$(jq -r '.trakt_client_id // ""' "$CONFIG_PATH")
export TRAKT_CLIENT_SECRET=$(jq -r '.trakt_client_secret // ""' "$CONFIG_PATH")
export HA_TOKEN=$(jq -r '.ha_token // ""' "$CONFIG_PATH")
export WATCHED_THRESHOLD=$(jq -r '.watched_threshold // 0.85' "$CONFIG_PATH")
export MIN_DURATION_SECONDS=$(jq -r '.min_duration_seconds // 600' "$CONFIG_PATH")
export POSITION_STEP_SECONDS=$(jq -r '.position_step_seconds // 30' "$CONFIG_PATH")
export ENTITIES_JSON=$(jq -c '.entities // []' "$CONFIG_PATH")

if [ -z "$TRAKT_CLIENT_ID" ] || [ -z "$TRAKT_CLIENT_SECRET" ]; then
  bashio::log.warning "Trakt Client ID/Secret nejsou nastavené. Nastav je v konfiguraci add-onu."
fi

if [ -z "$HA_TOKEN" ]; then
  bashio::log.error "HA token (ha_token) neni nastaven. Add-on konci (fail-fast)."
  exit 1
fi

bashio::log.info "Starting Trakt Bridge (Stremio) on :8787"
exec uvicorn app:app --host 0.0.0.0 --port 8787
