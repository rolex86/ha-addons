# NAS Stremio Bridge

Home Assistant add-on, který vystaví lokální NAS knihovnu jako vlastní Stremio add-on server.

## Co umí v MVP

- katalogy `NAS Filmy` a `NAS Seriály`,
- lokální SQLite index a cache v `/data`,
- scan pouze na vyžádání nebo podle plánu,
- metadata z `.nfo` nebo TMDb,
- stream URL přes `/file/:fileId` s podporou `Range`,
- admin API pro status, scan a ruční match,
- search endpointy nad SQLite indexem pro NAS katalog.
- jednoduché lokální web UI na `/` a `/admin/ui`.

## Důležité chování

- NAS se nečte při katalogu ani meta requestech,
- NAS se nečte ani při `/stream/...`, jen se vrací lokální stream URL,
- NAS se prochází jen při scanu,
- video soubor se fyzicky otevírá až v `/file/:fileId`,
- výchozí nastavení chrání disky: `manual` scan, `run_on_startup: false`, `scan_on_catalog_open: false`.

## Instalace

1. Přidej tento repozitář jako custom add-on repository v Home Assistantu.
2. Otevři add-on `NAS Stremio Bridge`.
3. Nastav `server.public_base_url` a cesty v `media.paths`.
4. Pokud chceš TMDb metadata, doplň `metadata.tmdb_api_key`.
5. Pokud chceš používat admin API, zapni `security.expose_admin_api` a nastav `security.admin_token`.
6. Spusť add-on a pak ruční scan přes admin endpoint.

Port add-onu je pevně `7010`. Do `server.public_base_url` nastav URL, pod kterou bude add-on skutečně dostupný navenek, případně za reverse proxy.

## První scan

Admin API je defaultně vypnuté. Pro první ruční scan nastav:

```yaml
security:
  expose_admin_api: true
  admin_token: "zvol-silny-token"
```

Pak můžeš zavolat:

```bash
curl -X POST \
  -H "Authorization: Bearer zvol-silny-token" \
  -H "Content-Type: application/json" \
  http://homeassistant.local:7010/admin/scan \
  -d '{"scan_type":"light","force_metadata_refresh":false}'
```

## Hlavní URL

- Přehled/UI: `/`
- Manifest: `/manifest.json`
- Katalog filmů: `/catalog/movie/nas_movies.json`
- Katalog seriálů: `/catalog/series/nas_series.json`
- Status: `/admin/status`

Podrobnější popis konfigurace, endpointů a chování je v [DOCS.md](./DOCS.md).
