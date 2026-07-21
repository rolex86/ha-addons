# AI Subtitle Translator

Home Assistant add-on providing the private translation API used by the optional AI subtitle feature in JustPlayer Plus.

The add-on keeps the Gemini API key on the Home Assistant host, accepts SRT or WebVTT subtitle text from the player, translates cue text into Czech, preserves original timing, and stores completed translations in a persistent cache.

## Features

- Gemini 3.1 Flash-Lite by default
- SRT and WebVTT input
- Czech SRT output
- stable cue IDs and timing preservation
- background jobs with progress polling
- persistent cache under `/data/cache`
- optional Bearer-token authentication
- cancellation endpoint for abandoned jobs
- 2 MiB subtitle input limit

## API

- `GET /health`
- `POST /v1/translations`
- `GET /v1/translations/{jobId}`
- `DELETE /v1/translations/{jobId}`

The JustPlayer Plus client should use:

```text
http://HOME_ASSISTANT_IP:8787
```

When `api_token` is configured, the player must send:

```text
Authorization: Bearer YOUR_TOKEN
```

Do not expose the add-on directly to the internet. Plain HTTP is intended only for a trusted home network.
