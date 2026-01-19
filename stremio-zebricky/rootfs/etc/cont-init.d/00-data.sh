#!/usr/bin/with-contenv bashio
set -e

bashio::log.info "Preparing /data persistence..."

# Ensure env for all scripts
export DATA_DIR="/data"

# Create persistent dirs
mkdir -p /data/config /data/lists /data/runtime

# Redirect /app/<dir> -> /data/<dir>
for d in "config" "lists" "runtime"; do
  # migrate first-run content from image -> /data if /data empty
  if [ -d "/app/$d" ] && [ ! -L "/app/$d" ]; then
    if [ "$(ls -A "/app/$d" 2>/dev/null || true)" != "" ] && \
       [ "$(ls -A "/data/$d" 2>/dev/null || true)" = "" ]; then
      bashio::log.info "Migrating /app/$d -> /data/$d"
      cp -a "/app/$d/." "/data/$d/" || true
    fi
  fi

  # ensure /app/$d is a symlink
  if [ -L "/app/$d" ]; then
    :
  else
    rm -rf "/app/$d"
    ln -s "/data/$d" "/app/$d"
  fi
done

# Token for Config UI from add-on options
TOKEN="$(bashio::config 'config_ui_token' 2>/dev/null || true)"
if [ -n "$TOKEN" ]; then
  export CONFIG_UI_TOKEN="$TOKEN"
  bashio::log.info "CONFIG_UI_TOKEN is set from add-on options."
fi
