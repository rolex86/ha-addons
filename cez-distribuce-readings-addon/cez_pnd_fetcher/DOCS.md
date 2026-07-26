# ČEZ PND Fetcher

Companion Home Assistant app for `ha-cez-distribuce-readings`.

This app runs the ČEZ PND login/fetch flow outside Home Assistant Core and writes
the last successful chart payload into:

`/config/cez_distribuce_readings/pnd_export_<device_set_id>.json`

It also keeps a synchronized last-good backup at:

`/config/cez_distribuce_readings/pnd_export_<device_set_id>.last_good.json`

Inside the add-on container, the Home Assistant config folder is mounted at
`/homeassistant`, so the add-on writes to
`/homeassistant/cez_distribuce_readings/pnd_export_<device_set_id>.json`.
Home Assistant Core sees that same file under `/config/...`.

The integration then reads this export file and creates the normal PND sensors
without having to call the fragile PND endpoint from the Core runtime.

## Why this exists

The ČEZ PND endpoint behaves differently depending on the runtime/container from
which the request is sent. In testing, the same probe flow worked in a separate
Home Assistant app/container, but returned HTTP 500 from the Home Assistant Core
integration process.

This companion app keeps the fetcher isolated while the integration remains
responsible for entities, archives, cache handling and diagnostics.

## Options

- `username`: ČEZ login
- `password`: ČEZ password
- `device_set_id`: required PND idDeviceSet
- `id_assembly`: optional, default `-1001`
- `update_interval_min`: polling interval in minutes, recommended `60`
- `debug_dump`: when enabled, stores request/response dumps under
  `/config/cez_distribuce_readings_debug`

## Login and diagnostics

Version 0.2.0 uses the current `mepas.cez.cz` CAS/OIDC endpoints advertised by
the ČEZ distribution portal. Authentication URLs are encoded as nested query
parameters instead of being assembled manually.

When `debug_dump` is enabled, every response in the login and PND flow is
captured. An HTTP or page-validation error is always captured even when the
option is disabled. A run directory contains:

- `01_cas_login`
- `02_cas_submit`
- `03_cas_authorize`
- `04_cez_token`
- `05_pnd_warmup`
- `06_pnd_data`

Each step has a JSON metadata file with status, sanitized URLs, redirects,
request/response headers, classification and a body preview. The complete
response body is stored alongside it with `.sanitized` in its filename.
Credentials, cookies, CAS tickets, OAuth codes and request tokens are redacted.

The latest failed cycle is also recorded at:

`/config/cez_distribuce_readings_debug/pnd_fetch_<device_set_id>.last_failure.json`

This file records the failed stage and whether a main or last-good export is
still available. A failed login never replaces either export. If the main
export is missing but its last-good backup exists, the add-on restores the main
file from that backup.

## Notes

- The integration should still have PND enabled and configured with the same
  `device_set_id`.
- If the export file exists, the integration will prefer it over direct PND
  fetching.
- If ČEZ returns a valid JSON response without usable measurements, the add-on
  stores that response only in the debug folder and keeps the main export
  unchanged.
- HTTP 403 is not retried. HTTP 429 and 5xx responses receive at most two
  retries with exponential backoff; the next full cycle still waits for
  `update_interval_min`.
- The add-on uses one `curl_cffi` session with its Chrome 146 impersonation
  profile for the complete flow. This keeps the TLS/HTTP fingerprint,
  browser-generated headers, cookies and redirects consistent. A direct
  comparison showed that impersonation alone does not fix the retired CAS
  endpoint; the endpoint/client migration is the essential part of this fix.
- `armhf` is no longer declared. `curl_cffi` 0.15.0 provides binary Linux
  wheels for `amd64`, `aarch64`, `armv7` and `i386`, but not for the ARMv5/6
  platform represented by Home Assistant's `armhf` target. The Debian-based
  image includes a temporary build toolchain so the `cffi` dependency can be
  built on `armv7`, where upstream does not publish a binary `cffi` wheel.
- This app is scaffolded inside the integration repository only for convenience.
  It is intended to be easy to move into its own repository later.
