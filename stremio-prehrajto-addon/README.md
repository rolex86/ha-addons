# Stremio Prehraj.to Addon

Addon je zamereny primarne jako `stream source` pro existujici Cinemeta/StreamCinema obsah.
Nevystavuje vlastni katalog, ve Stremiu se zobrazuje jako dalsi zdroj streamu.
Resolver vraci streamy serazene podle detekovane velikosti a zkousi vice variant nazvu.

Tento adresar ted podporuje dva zpusoby nasazeni:

- Home Assistant add-on: puvodni varianta beze zmen
- standalone Docker/Portainer: nova varianta pro RPiOS nebo libovolny Docker host

HA wrapper a standalone image sdili stejnou Node.js aplikaci. Docker podpora neprerabi HA start skripty ani `config.yaml`.

## Home Assistant Add-on

Puvodni HA varianta zustava v techto souborech:

- `config.yaml`
- `Dockerfile`
- `rootfs/`

Po instalaci nastavte v HA hlavne:

- `base_url`
- `tmdb_api_key`
- `log_level`
- `config_secret`
- `default_streams_limit`

Perzistentni data:

- runtime cache + premium cookies: `/data/stremio-prehrajto/cache.json`
- cache se kvuli vykonu persistuje asynchronne pri ukonceni addonu

## Standalone Docker

Standalone varianta je pripravena pro Docker i Portainer:

- `Dockerfile.standalone`
- `compose.yaml`
- `.env.example`

Postup:

1. `cp .env.example .env`
2. Nechte `BASE_URL` prazdne pro automaticke doplneni adresy z aktualniho requestu, nebo ho vyplnte rucne pevnou URL
3. Doplnte `TMDB_API_KEY` a zmente `CONFIG_SECRET`
4. `docker compose up -d --build`

Manifest pak bude na:

- `http://RASPBERRYPI_IP:7654/manifest.json`

Konfiguracni stranka:

- `http://RASPBERRYPI_IP:7654/configure`

Data se ukladaji do `./data`, ktere je namapovane do `/data` v kontejneru.

## Portainer

V Portaineru lze pouzit `compose.yaml` primo jako Stack.

Pred spustenim upravte hlavne:

- `TMDB_API_KEY`
- `CONFIG_SECRET`
- pripadne `HOST_PORT`

Pro RPiOS neni potreba Home Assistant, staci bezny Docker Engine.

## Lokalni Node.js Setup

1. `cp .env.example .env`
2. Doplnit `TMDB_API_KEY` a `CONFIG_SECRET`
3. `npm install`
4. `npm run check`
5. `npm run start`

## Install in Stremio

Otevri:

- `http://localhost:7654/manifest.json`

Nebo sdilej:

- `https://tv.stremio.com/#/addons?addon=http%3A%2F%2Flocalhost%3A7654%2Fmanifest.json`

Troubleshooting `Failed to fetch`:

- `BASE_URL` musi byt URL dostupna ze zarizeni, kde bezi Stremio, ne jen z hosta
- kdyz nechate `BASE_URL` prazdne, `/configure` pouzije adresu, pres kterou byl addon otevren
- pro Stremio Web je obvykle potreba HTTPS URL, jinak narazite na mixed-content blokaci
- rucne overte `http://HOST:PORT/manifest.json`, musi vratit validni JSON

## Config

`/configure` stranka generuje manifest URL s tokenem `cfg`.

Prenasi:

- `email`, `password` pro premium download
- `limit`
- `streamLimit`
- `premium`

Heslo tak neni v URL v cistem textu.
Legacy query parametry (`email`, `password`, `limit`, `stream_limit`, `premium`) zustavaji podporovane jako fallback.

## Debug logy

- HA: standardni log add-onu v Home Assistantu
- standalone Docker: `docker compose logs -f`
- detailni diagnostika: nastavte `LOG_LEVEL=debug`
