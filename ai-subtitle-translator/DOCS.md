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

Then enable AI subtitle translation in JustPlayer Plus. Translation starts only after the user presses the AI subtitle button. Playback continues while translation runs in the background.

## Advanced options

- `batch_max_cues`: maximum number of subtitle cues initially sent to Gemini in one request. Default: `300`.
- `batch_max_characters`: maximum approximate text size of an initial translation batch. Default: `30000`.
- `timeout_seconds`: maximum time without a successfully completed batch before a job is paused as failed. Default: `900`.
- `gemini_request_timeout_seconds`: maximum duration of one Gemini request before that batch is retried or split. Default: `45`.
- `gemini_min_request_interval_ms`: minimum delay between Gemini requests. Default: `4100`, which keeps normal traffic below approximately 15 requests per minute.
- `log_level`: `debug`, `info`, `warn`, or `error`.

When Gemini returns an incomplete or invalid structured response, only the affected batch is divided into smaller batches. Completed cues are preserved. HTTP `429` respects `Retry-After` when provided; otherwise the add-on waits 65 seconds before retrying.

## Storage and recovery

Completed translations are stored in:

```text
/data/cache
```

In-progress jobs and completed batches are stored in:

```text
/data/jobs
```

Both directories survive add-on updates and restarts. After a restart, unfinished jobs continue from the last successfully stored batch instead of starting from the beginning.

## API behavior

- A new translation returns HTTP `202` and a job ID.
- A repeated request for the same unfinished subtitle returns the existing job.
- A cache hit returns HTTP `200` with the completed SRT.
- Progress is read from `GET /v1/translations/{jobId}`.
- An explicitly cancelled job can be cancelled with `DELETE /v1/translations/{jobId}`.
- Disconnecting or closing JustPlayer Plus does not cancel the server-side job.
- SRT and WebVTT inputs are limited to 2 MiB.
