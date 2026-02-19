# Stremio Prehraj.to Addon (Node.js / Home Assistant Add-on)

Addon je ted zamereny primarne jako `stream source` pro existujici Cinemeta/StreamCinema obsah.
Nevystavuje vlastni katalog, ve Stremiu se zobrazuje jako dalsi zdroj streamu.
Resolver vraci az 15 streamu serazenych podle detekovane velikosti (nejvetsi prvni) a zkousi vice variant nazvu (CZ/original/rok).

## Home Assistant Add-on

Tento adresar je pripraveny jako Home Assistant add-on (`config.yaml`, `build.yaml`, `Dockerfile`, `rootfs`).

Po instalaci nastav options v HA:
- `base_url` (URL add-onu viditelna pro Stremio klienta)
- `tmdb_api_key` (volitelne, pro presnejsi mapovani IMDb -> TMDB)
- `log_level` (`debug`, `info`, `warn`, `error`)
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

Troubleshooting `Failed to fetch`:
- `BASE_URL` musi byt URL dostupna ze zarizeni, kde bezi Stremio (ne jen z HA hosta).
- Pro Stremio Web (`https://web.strem.io` / `https://tv.stremio.com`) je obvykle potreba HTTPS URL (HTTP byva blokovane mixed-content politikou).
- Over endpoint rucne: `http://HA_IP:7654/manifest.json` musi vratit validni JSON.

## Config

`http://localhost:7654/configure`

Konfigurace se předává v manifest URL přes token `cfg`:

- email, password (pro premium download)
- limit (search limit)
- premium=true/false

Configure stránka pošle data na backend a vygeneruje URL s tokenem `cfg`, takže heslo není v URL v čistém textu.
Legacy query parametry (`email`, `password`, `limit`, `premium`) zůstávají podporované jako fallback.

## Debug logy

Addon zapisuje detailni runtime logy do standardniho logu addonu (HA UI -> Add-on -> Log).
Pro detailni diagnostiku nastav `log_level: "debug"`.
