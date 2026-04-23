from __future__ import annotations

import logging
import re

import httpx

from .config import AddonOptions
from .models import Station, StationSourceRef
from .utils import slugify_filename


LOGGER = logging.getLogger(__name__)


class RadioNetClient:
    def __init__(self, http: httpx.AsyncClient, options: AddonOptions) -> None:
        self.http = http
        self.options = options

    async def resolve_from_url(self, source_url: str, fallback_name: str | None = None) -> Station | None:
        try:
            response = await self.http.get(source_url, timeout=self.options.request_timeout)
            response.raise_for_status()
        except Exception as exc:
            LOGGER.warning("radio.net fetch failed: %s", exc)
            return None

        html = response.text
        title = _extract_meta(html, "og:title") or fallback_name or "radio.net station"
        logo = _extract_meta(html, "og:image")
        stream_url = _extract_stream_url(html)
        if not stream_url:
            return None

        return Station(
            station_id=slugify_filename(source_url),
            canonical_name=title,
            display_name=title,
            file_basename=slugify_filename(title),
            source_of_truth="radionet",
            station_page_url=source_url,
            homepage=source_url,
            stream_url_raw=stream_url,
            stream_url_resolved=stream_url,
            logo_url=logo,
            logo_source="radionet" if logo else None,
            source_refs=[StationSourceRef(source="radionet", source_url=source_url)],
            last_sync_result="fetched",
        )


def _extract_meta(html: str, prop: str) -> str | None:
    match = re.search(
        rf'<meta[^>]+property=["\']{re.escape(prop)}["\'][^>]+content=["\']([^"\']+)["\']',
        html,
        re.IGNORECASE,
    )
    if not match:
        match = re.search(
            rf'<meta[^>]+name=["\']{re.escape(prop)}["\'][^>]+content=["\']([^"\']+)["\']',
            html,
            re.IGNORECASE,
        )
    return match.group(1).strip() if match else None


def _extract_stream_url(html: str) -> str | None:
    patterns = [
        r"https?://[^\"'\\ ]+\.(?:mp3|aac|aacp|m3u8?|pls)(?:\?[^\"' ]+)?",
        r'"streamUrl"\s*:\s*"([^"]+)"',
    ]
    for pattern in patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if not match:
            continue
        if match.lastindex:
            return match.group(1).replace("\\/", "/")
        return match.group(0)
    return None
