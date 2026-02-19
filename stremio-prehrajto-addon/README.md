# Stremio Prehraj.to Addon (Node.js / Home Assistant Add-on)

## Home Assistant Add-on

Tento adresar je pripraveny jako Home Assistant add-on (`config.yaml`, `build.yaml`, `Dockerfile`, `rootfs`).

Po instalaci nastav options v HA:
- `base_url` (URL add-onu viditelna pro Stremio klienta)
- `tmdb_api_key`
- `config_secret` (pro sifrovani `cfg` tokenu)

Perzistentni data:
- runtime cache + premium cookies: `/data/stremio-prehrajto/cache.json`

## Setup

1. `cp .env.example .env`
2. Doplnit `TMDB_API_KEY` a `CONFIG_SECRET`
3. `npm install`
4. `npm run check`
5. `npm run start`

## Install in Stremio

Otevři:
`http://localhost:7654/manifest.json`

nebo sdílej:
`https://tv.stremio.com/#/addons?addon=http%3A%2F%2Flocalhost%3A7654%2Fmanifest.json`

## Config

`http://localhost:7654/configure`

Konfigurace se předává v manifest URL přes token `cfg`:

- email, password (pro premium download)
- limit (search limit)
- premium=true/false

Configure stránka pošle data na backend a vygeneruje URL s tokenem `cfg`, takže heslo není v URL v čistém textu.
Legacy query parametry (`email`, `password`, `limit`, `premium`) zůstávají podporované jako fallback.
