# NAS Stremio Bridge Docs

## Prehled

Add-on bezi jako lokalni HTTP server pro Stremio. Pri beznem prochazeni katalogu pracuje jen s lokalni SQLite databazi a cache v `/data`.

Interni listen port add-onu je pevny `7010`. Verejne URL se ridi hodnotou `server.public_base_url`.

## Perzistence

Runtime pouziva:

```text
/data/index.db
/data/posters/
/data/backdrops/
/data/metadata/
/data/logs/
/data/db_backups/
```

## Endpointy

### Verejne

- `GET /`
- `GET /admin/ui`
- `GET /admin/ui/unmatched`
- `GET /admin/ui/audit`
- `GET /admin/ui/match-audit`
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
- `GET /health`

### Admin

- `GET /admin/status`
- `GET /admin/config`
- `POST /admin/scan`
- `GET /admin/unmatched`
- `GET /admin/items/search?q=...`
- `POST /admin/match/:fileId`
- `POST /admin/match/:fileId/apply-imdb`
- `POST /admin/refresh-metadata/:itemId`
- `POST /admin/ignore-test`
- `GET /admin/audit`
- `POST /admin/audit/run`
- `GET /admin/audit/export.tsv`
- `GET /admin/audit/export.csv`
- `GET /admin/audit/top.txt`
- `POST /admin/rebuild`

Pokud je `security.expose_admin_api: true`, admin endpointy vyzaduji:

```http
Authorization: Bearer <admin_token>
```

## Scan rezimy

- `manual`: nic nespousti automaticky
- `interval`: plan podle `interval_value + interval_unit`
- `cron`: plan podle `scan.cron`

`run_on_startup` je defaultne vypnuty.

## Parovani metadata

Poradi:

1. `.nfo`
2. explicitni IMDb ID v nazvu nebo ceste
3. TMDb lookup podle nazvu a roku
4. rucni match
5. lokalni interni polozka

Dulezite:

- pokud cesta obsahuje `tt1234567` a ulozene IMDb ID nesedi, scanner vynuti refresh metadata i kdyz je `only_fetch_for_new_items: true`
- explicitni IMDb z cesty blokuje rucni remap na jine IMDb ID
- known bad blacklist se pouziva jak v auditu, tak pri samotnem TMDb matchovani
- TMDb metadata uklada i alternativni nazvy, aby audit mel mene false positives

Nizka jistota nastavi `needs_review = 1`.

## Audit

Audit umi reasony:

- `IMDB_CONFLICT`
- `KNOWN_BAD_MATCH`
- `MISSING_DB_META`
- `YEAR_CONFLICT`
- `TITLE_LOW_SIM`

Defaultne audit filtruje jen `files.is_available = 1`. Pres API lze zapnout i unavailable zaznamy:

```text
include_unavailable=true
```

Dalsi filtry:

- `reason=IMDB_CONFLICT`
- `min_severity=90`
- `limit=200`

Priklady:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://homeassistant.local:7010/admin/audit?reason=IMDB_CONFLICT&min_severity=90"
```

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://homeassistant.local:7010/admin/audit/export.tsv?include_unavailable=false&limit=1000"
```

## Rucni oprava matchu

Zakladni rucni premapovani:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  http://homeassistant.local:7010/admin/match/file_1234567890abcdef \
  -d '{"imdb_id":"tt0816692","tmdb_id":157336,"type":"movie","title":"Interstellar","year":2014}'
```

One-click IMDb apply + metadata fetch:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  http://homeassistant.local:7010/admin/match/file_1234567890abcdef/apply-imdb \
  -d '{"imdb_id":"tt0816692"}'
```

## Ignore patterns

Aktivni ignore patterns se berou z `media.ignore_patterns`.

Test konkretni cesty:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  http://homeassistant.local:7010/admin/ignore-test \
  -d '{"path":"/media/nas/Filmy/sample/movie-sample.mkv"}'
```

## Clean rebuild DB

Endpoint `POST /admin/rebuild` udela:

1. backup `index.db`, `index.db-wal`, `index.db-shm` do `/data/db_backups/<timestamp>/`
2. zavre DB
3. smaze DB soubory
4. znovu inicializuje databazi
5. spusti `light` scan

Priklad:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  http://homeassistant.local:7010/admin/rebuild \
  -d '{"scan_type":"light","force_metadata_refresh":false}'
```

## Stream cards

Stream endpoint vraci vice informativni `name/title`:

- nazev titulu
- rok u filmu
- `SxxEyy` u serialu
- kvalitu, pokud jde vycist z nazvu souboru
- source tag jako `BluRay`, `WEB-DL`, `WEBRip`
- priponu a velikost
- volitelne filename a folder podle `streaming.show_filename_in_title` a `streaming.show_folder_in_title`

Pokud existuje vice souboru pro stejny titul nebo stejnou epizodu, streamy se radi takto:

1. `is_available = 1`
2. novejsi `last_seen_at`
3. novejsi `mtime`
4. vyssi kvalita
5. vetsi soubor

## Lokalni test

Po startu add-onu pridej do Stremia:

```text
http://homeassistant.local:7010/manifest.json
```

Pro rychly prehled v Home Assistantu otevri:

```text
http://homeassistant.local:7010/
```
