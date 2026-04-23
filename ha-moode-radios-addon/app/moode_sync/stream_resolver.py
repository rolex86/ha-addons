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
            async with self.http.stream(
                "GET",
                url,
                timeout=self.timeout,
                follow_redirects=True,
                headers={"Icy-MetaData": "1"},
            ) as response:
                response.raise_for_status()

                final_url = str(response.url)
                content_type = (response.headers.get("content-type") or "").lower()

                if ".pls" in final_url or "audio/x-scpls" in content_type or final_url.endswith(".pls"):
                    text = await _read_text_prefix(response)
                    nested = _extract_playlist_url(text)
                    return (nested or final_url), "pls"

                if ".m3u" in final_url or "mpegurl" in content_type or final_url.endswith(".m3u8"):
                    text = await _read_text_prefix(response)
                    nested = _extract_m3u_url(text)
                    return (nested or final_url), "m3u"

                return final_url, content_type or "stream"
        except Exception as exc:
            LOGGER.warning("Stream resolve failed for %s: %s", url, exc)
            return url, "failed"


async def _read_text_prefix(response: httpx.Response, limit: int = 65536) -> str:
    chunks: list[str] = []
    size = 0
    async for chunk in response.aiter_text():
        if not chunk:
            continue
        remaining = limit - size
        if remaining <= 0:
            break
        piece = chunk[:remaining]
        chunks.append(piece)
        size += len(piece)
        if size >= limit:
            break
    return "".join(chunks)


def _extract_playlist_url(text: str) -> str | None:
    match = re.search(r"^File\d+=(.+)$", text, re.MULTILINE)
    return match.group(1).strip() if match else None


def _extract_m3u_url(text: str) -> str | None:
    for line in text.splitlines():
        candidate = line.strip()
        if candidate and not candidate.startswith("#") and candidate.startswith("http"):
            return candidate
    return None
