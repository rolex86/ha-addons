# AI Subtitle Translator

Home Assistant add-on providing the private translation API used by the optional AI subtitle feature in JustPlayer Plus.

The add-on keeps the Gemini API key on the Home Assistant host, accepts SRT or WebVTT subtitle text from the player, translates cue text into Czech, preserves original timing, and stores completed translations in a persistent cache.

## Features

- Gemini 3.1 Flash-Lite by