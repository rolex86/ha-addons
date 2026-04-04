# Stremio Hellspy Add-on

Tento adresar ted podporuje dva oddelene zpusoby nasazeni:

- Home Assistant add-on: puvodni varianta beze zmen
- standalone Docker/Portainer: nova varianta pro RPiOS nebo jiny Docker host

Obe varianty sdili stejnou PHP aplikaci z `app/`. HA wrapper zustava v `Dockerfile`, `config.yaml` a `rootfs/`.

## Dulezite omezeni

Hellspy API vyzaduje ceskou IP adresu. Bez ni addon nemusi vracet vysledky ani ve standalone Dockeru.

## Home Assistant Add-on

Puvodni HA varianta zustava beze zmen:

- `config.yaml`
- `Dockerfile`
- `rootfs/`

Konfigurace v HA se dal predava do env promennych pres start skript v `rootfs/etc/services.d/php-fpm/run`.

## Standalone Docker

Standalone varianta je pripravena v techto souborech:

- `Dockerfile.standalone`
- `compose.yaml`
- `.env.example`

Postup:

1. `cp .env.example .env`
2. Volitelne upravte `ADDON_URL` a `ADDON_CONTACT` pro vlastni metadata
3. `docker compose up -d --build`

Manifest bude dostupny na:

- `http://RASPBERRYPI_IP:8080/manifest.json`

Debug endpoint:

- `http://RASPBERRYPI_IP:8080/stream`

Data a cache se ukladaji do `./data`, ktere je namapovane do `/data` v kontejneru.

## Portainer

V Portaineru lze `compose.yaml` nasadit jako Stack.

Pred spustenim upravte hlavne:

- `HOST_PORT`
- pripadne limity a delay promene podle vaseho provozu

Pro RPiOS neni potreba Home Assistant, jen bezny Docker nebo Portainer.

## Runtime konfigurace

Stejne ladici promene funguji v HA i ve standalone Dockeru:

- `REQUEST_DELAY_HELLSPY`
- `REQUEST_DELAY_WIKIDATA`
- `REQUEST_DELAY_OTHER`
- `MAX_RETRIES`
- `RETRY_DELAY_BASE`
- `MAX_RETRY_BACKOFF`
- `REQUEST_TIMEOUT`
- `SEARCH_TIME_BUDGET_MS`
- `MAX_SEARCH_QUERIES`
- `STREAM_RESOLVE_CONCURRENCY`
- `STREAM_REQUEST_CACHE_TTL`
- `STREAM_REQUEST_INFLIGHT_WAIT_MS`
- `STREAM_REQUEST_INFLIGHT_POLL_MS`
- `LOG_LEVEL`
- `LOG_HTTP_RESPONSE_BODY`

## Lokalni app README

Podrobnejsi app-level poznamky a puvodni lokalni PHP setup zustavaji v `app/README.md`.
