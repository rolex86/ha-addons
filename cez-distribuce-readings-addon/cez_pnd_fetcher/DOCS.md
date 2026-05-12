# ČEZ PND Fetcher

Companion Home Assistant app for `ha-cez-distribuce-readings`.

This app runs the ČEZ PND login/fetch flow outside Home Assistant Core and writes
the last successful chart payload into:

`/config/cez_distribuce_readings/pnd_export_<device_set_id>.json`

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

## Notes

- The integration should still have PND enabled and configured with the same
  `device_set_id`.
- If the export file exists, the integration will prefer it over direct PND
  fetching.
- This app is scaffolded inside the integration repository only for convenience.
  It is intended to be easy to move into its own repository later.
