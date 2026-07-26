# Changelog

## 0.2.0

- Migrated authentication from the retired `cas.cez.cz` CAS client to the
  current `mepas.cez.cz` OIDC endpoint and client ID advertised by the ČEZ
  distribution portal.
- Rebuilt nested CAS/OAuth URLs with `urllib.parse.urlencode`.
- Added sanitized response dumps for all CAS, token and PND stages, including
  response classification and complete sanitized bodies.
- Added explicit CAS blocked, changed-page, authentication and missing-token
  errors.
- Added a stable last-failure diagnostic and preservation/restoration of the
  last good PND export.
- Added bounded backoff for HTTP 429/5xx responses and no immediate retry for
  HTTP 403.
- Replaced `requests` and the stale Chrome 120 header with one `curl_cffi`
  session using its Chrome 146 impersonation profile for all six stages.
- Corrected the add-on repository URL.
- Switched the image to `python:3.12-slim-bookworm`, whose glibc environment can
  install the pinned `curl_cffi` wheels. A temporary C/libffi toolchain covers
  the source-built `cffi` dependency on `armv7`.
- Removed `armhf`; upstream has no compatible binary wheel for that target.
  `amd64`, `aarch64`, `armv7` and `i386` remain declared.
