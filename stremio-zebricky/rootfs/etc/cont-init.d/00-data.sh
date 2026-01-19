#!/usr/bin/with-contenv bashio
set -e

bashio::log.info "Preparing /data persistence..."

# Create persistent dirs (podle tvé struktury)
mkdir -p /data/config
mkdir -p /data/lists
mkdir -p /data/runtime

# Přesměrování /app/<dir> -> /data/<dir>
for d in "config" "lists" "runtime"; do
  # pokud existuje reálná složka v /app, a /data je prázdné, zkopíruj ji (první start)
  if [ -d "/app/$d" ] && [ ! -L "/app/$d" ]; then
    if [ "$(ls -A "/app/$d" 2>/dev/null || true)" != "" ] && [ "$(ls -A "/data/$d" 2>/dev/null || true)" = "" ]; then
      bashio::log.info "Migrating /app/$d -> /data/$d"
      cp -a "/app/$d/." "/data/$d/" || true
    fi
    rm -rf "/app/$d"
  fi

  # vždycky vytvoř symlink
  if [ ! -L "/app/$d" ]; then
    ln -s "/data/$d" "/app/$d"
  fi
done

# Token pro Config UI z options
TOKEN="$(bashio::config 'config_ui_token' 2>/dev/null || true)"
if [ -n "$TOKEN" ]; then
  export CONFIG_UI_TOKEN="$TOKEN"
  bashio::log.info "CONFIG_UI_TOKEN is set from add-on options."
fi
