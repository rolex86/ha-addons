# NAS Stremio Bridge

Home Assistant add-on, ktery vystavi lokalni NAS knihovnu jako vlastni Stremio add-on server.

## Co umi

- katalogy `NAS Filmy` a `NAS Serialy`
- lokalni SQLite index a cache v `/data`
- scan rucne nebo podle planu
- metadata z `.nfo`, explicitniho IMDb ID v ceste nebo z TMDb
- stream URL pres `/file/:fileId` s podporou `Range`
- preferenci dostupnych souboru a vice stream variant pro stejny titul
- admin API pro status, scan, audit, rucni match a clean rebuild
- jednoduche lokalni web UI na `/` a `/admin/ui`

## Dulezite chovani

- NAS se necte pri katalogu ani meta requestech
- NAS se necte ani pri `/stream/...`, jen se vraci lokalni stream URL
- NAS se prochazi jen pri scanu
- video soubor se fyzicky otevre az v `/file/:fileId`
- vychozi nastaveni chrani disky: `manual` scan, `run_on_startup: false`, `scan_on_catalog_open: false`

## Instalace

1. Pridej tento repozitar jako custom add-on repository v Home Assistantu.
2. Otevri add-on `NAS Stremio Bridge`.
3. Nastav `server.public_base_url` a cesty v `media.paths`.
4. Pokud chces TMDb metadata, dopln `metadata.tmdb_api_key`.
5. Pokud chces pouzivat admin API, zapni `security.expose_admin_api` a nastav `security.admin_token`.
6. Spust add-on a pak udelej prvni scan.

Port add-onu je pevne `7010`. Do `server.public_base_url` nastav URL, pod kterou bude add-on skutecne dostupny navenek, pripadne za reverse proxy.

## Prvni scan

Admin API je defaultne vypnute. Pro prvni rucni scan nastav:

```yaml
security:
  expose_admin_api: true
  admin_token: "zvol-silny-token"
```

Pak muzes zavolat:

```bash
curl -X POST \
  -H "Authorization: Bearer zvol-silny-token" \
  -H "Content-Type: application/json" \
  http://homeassistant.local:7010/admin/scan \
  -d '{"scan_type":"light","force_metadata_refresh":false}'
```

## Hlavni URL

- Prehled/UI: `/`
- Manifest: `/manifest.json`
- Katalog filmu: `/catalog/movie/nas_movies.json`
- Katalog serialu: `/catalog/series/nas_series.json`
- Status: `/admin/status`
- Audit: `/admin/audit`

## Admin novinky

- `POST /admin/match/:fileId/apply-imdb`: jednim krokem aplikuje IMDb ID a dotahne metadata
- `GET/POST /admin/audit...`: audit, filtry a exporty
- `GET /admin/items/search`: hledani polozek pro rucni remap
- `POST /admin/ignore-test`: test ignore patterns
- `POST /admin/rebuild`: backup DB + clean rebuild + novy scan

Podrobnejsi popis konfigurace, endpointu a chovani je v [DOCS.md](./DOCS.md).
