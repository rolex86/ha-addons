#!/usr/bin/with-contenv bashio
set -e

mkdir -p /data/cache /data/jobs
chmod 700 /data/cache /data/jobs

bashio::log.info "AI Subtitle Translator data directories prepared"
