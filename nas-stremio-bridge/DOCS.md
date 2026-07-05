# NAS Stremio Bridge Docs

## Přehled

Add-on běží jako lokální HTTP server pro Stremio. Při běžném procházení katalogu pracuje jen s lokální SQLite databází a cache v `/data`.

Interní listen port add-onu je pevný `7010`. Veřejné URL se řídí hodnotou `server.public_base_url`.

## Perzistence

Runtime používá:

```text
/data/index.db
/data/posters/
/data/backdrops/
/data/metadata/
/data/logs/
```

## Endpointy

### Veřejné

- `GET /`
- `GET /admin/ui`
- `GET /admin/ui/unmatched`
- `GET /manifest.json`
- `GET /catalog/movie/:catalogId.json`
- `GET /catalog/series/:catalogId.json`
- `GET /catalog/movie/:catalogId/search=:query.json`
- `GET /catalog/series/:catalogId/search=:query.json`
- `GET /meta/movie/:id.json`
- `GET /meta/series/:id.json`
- `GET /stream/movie/:id.json`
- `GET /stream/series/:id.json`
- `GET /file/:fileId`

### Admin

- `GET /admin/status`
- `POST /admin/scan`
- `GET /admin/unmatched`
- `POST /admin/match/:fileId`
- `POST /admin/refresh-metadata/:itemId`

Pokud je `security.expose_admin_api: true`, admin endpointy vyžadují:

```http
Authorization: Bearer <admin_token>
```

## Scan režimy

- `manual`: nic nespouští automaticky
- `interval`: plán podle `interval_value + interval_unit`
- `cron`: plán podle `scan.cron`

`run_on_startup` je defaultně vypnutý.

## Párování metadata

Pořadí:

1. `.nfo`
2. IMDb ID v názvu
3. TMDb lookup podle názvu/roku
4. Ruční match
5. Lokální interní položka

Nízká jistota nastaví `needs_review = 1`.

## Poznámky k sériím

- katalog seriálů agreguje epizody do show-level záznamu,
- stream endpoint používá epizodové ID jako `tt0903747:2:3`, pokud je známé IMDb ID seriálu,
- bez externího ID se používají interní `nas_` identifikátory.

## Lokální test

Po startu add-onu přidej do Stremia:

```text
http://homeassistant.local:7010/manifest.json
```

Pro rychlý přehled v Home Assistantu otevři:

```text
http://homeassistant.local:7010/
```

Pro první naplnění knihovny spusť:

```http
POST /admin/scan
```

Příklady s tokenem:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://homeassistant.local:7010/admin/status
```

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  http://homeassistant.local:7010/admin/scan \
  -d '{"scan_type":"light","force_metadata_refresh":false}'
```

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://homeassistant.local:7010/catalog/movie/nas_movies/search=interstellar.json"
```

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  http://homeassistant.local:7010/admin/match/file_1234567890abcdef \
  -d '{"imdb_id":"tt0816692","tmdb_id":157336,"type":"movie","title":"Interstellar","year":2014}'
```
