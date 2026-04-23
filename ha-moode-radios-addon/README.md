# moOde Radios Sync

Home Assistant add-on for building curated internet radio catalogs and syncing them into moOde Audio.

## What works now

- Home Assistant add-on packaging with web UI on port `7860`
- One shared pinned stations list editable from the add-on options or the web UI
- Source resolution from Radio Browser, Radio Garden URLs/search, radio.net page fallback and direct stream URLs
- Stream resolution for redirects, `.pls` and `.m3u`
- Metadata enrichment from Radio Browser
- Logo download plus generated fallback logo
- ZIP export with `stations.json`, `.pls` files and generated logos
- Optional SSH push to moOde with direct remote import into `.pls` files, logos and `cfg_radio`

## First real test

1. Add the addon to Home Assistant and start it once.
2. Open the web UI and paste pinned stations JSON, for example:

```json
[
  {
    "name": "BBC World Service",
    "source_hint": "radiobrowser"
  },
  {
    "name": "KEXP",
    "source_hint": "radiobrowser"
  },
  {
    "name": "SomaFM Groove Salad",
    "stream_url": "https://ice2.somafm.com/groovesalad-128-mp3"
  }
]
```

For first tests, prefer `radiobrowser` lookups or direct `stream_url` entries. Radio Garden channel URLs can go stale and may start returning `404`.

3. Keep `dry_run: true` for the first sync and verify the generated report and ZIP.
4. When the catalog looks good, fill in `moode.host`, `moode.username`, `moode.password`, set `moode.enabled: true`, then switch `dry_run: false`.
5. Run sync again and verify the stations appear in moOde.

## Notes

- `merge` mode upserts by station name; `replace` removes only stations previously managed by this addon.
- The add-on does not depend on moOde's undocumented ZIP importer. It uses SSH and updates the likely moOde radio paths directly to improve compatibility across versions.
