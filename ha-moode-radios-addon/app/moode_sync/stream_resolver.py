from __future__ import annotations

import logging
import re

import httpx


LOGGER = logging.getLogger(__name__)


class StreamResolver:
    def __init__(self, http: httpx.AsyncClient, timeout: int) -> None:
        self.http = http
        self.timeout = timeout

    async def resolve(self, url: str) -> tuple[str, str]:
        try:
            response = await self.http.get(
                url,
                timeout=self.timeout,
                follow_redirects=True,
                headers={"Icy-MetaData": "1"},
            )
            response.raise_for_status()
        except Exception as exc:
            LOGGER.warning("Stream resolve failed for %s: %s", url, exc)
            return url, "failed"

        final_url = str(response.url)
        content_type = (response.headers.get("content-type") or "").lower()
        if ".pls" in final_url or "audio/x-scpls" in content_type or final_url.endswith(".pls"):
            nested = _extract_playlist_url(response.text)
            return (nested or final_url), "pls"
        if ".m3u" in final_url or "mpegurl" in content_type or final_url.endswith(".m3u8"):
            nested = _extract_m3u_url(response.text)
            return (nested or final_url), "m3u"
        return final_url, content_type or "stream"


def _extract_playlist_url(text: str) -> str | None:
    match = re.search(r"^File\d+=(.+)$", text, re.MULTILINE)
    return match.group(1).strip() if match else None


def _extract_m3u_url(text: str) -> str | None:
    for line in text.splitlines():
        candidate = line.strip()
        if candidate and not candidate.startswith("#") and candidate.startswith("http"):
            return candidate
    return None
