#!/usr/bin/with-contenv bashio
set -e

mkdir -p /data/cache
chmod 700 /data/cache

bashio::log.info "AI Subtitle Translator data directory prepared"
