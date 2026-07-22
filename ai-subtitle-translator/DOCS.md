# AI Subtitle Translator

This add-on is the server component for AI subtitle translation in JustPlayer Plus.

## Required configuration

### Gemini API key

Enter a Gemini API key in `gemini_api_key`. The key stays inside the add-on and is never sent to JustPlayer Plus.

### Gemini model

The default model is:

```text
gemini-3.1-flash-lite
```

The model can be changed without reinstalling the add-on. Changing the model creates different cache keys, so an older translation is not incorrectly reused.

## Recommended security

Set a long random value in `api_token`. The same token must later be entered in JustPlayer Plus. When the value is empty, translation requests are accepted without authentication.

The `/health` endpoint remains available without a token so Home Assistant can monitor the add-on.

Do not forward port `8787` to the internet. Use it only on a trusted LAN, or place it behind an authenticated HTTPS reverse proxy.

## JustPlayer Plus setup

Set the translation-service address to:

```text
http://HOME_ASSISTANT_IP:8787
```

Then enable AI subtitle translation in JustPlayer Plus. Translation starts only after the user presses the AI subtitle button.

## Advanced options

- `batch_max_cues`: maximum number of subtitle cues sent to Gemini in one request. Default: `300`.
- `batch_max_characters`: maximum approximate text size of one translation batch. Default: `30000`.
- `timeout_seconds`: maximum duration of one complete subtitle translation.
- `log_level`: `debug`, `info`, `warn`, or `error`.

Larger batches reduce Gemini requests per minute. When Gemini returns HTTP `429`, the add-on respects `Retry-After` when provided; otherwise it waits 65 seconds before retrying the same batch.

## Storage

Completed translations are stored in:

```text
/data/cache
```

The cache survives add-on updates and restarts. Active jobs are kept only in memory and are lost when the add-on restarts.

## API behavior

- A new translation returns HTTP `202` and a job ID.
- A cache hit returns HTTP `200` with the completed SRT.
- Progress is read from `GET /v1/translations/{jobId}`.
- An abandoned job can be cancelled with `DELETE /v1/translations/{jobId}`.
- SRT and WebVTT inputs are limited to 2 MiB.
