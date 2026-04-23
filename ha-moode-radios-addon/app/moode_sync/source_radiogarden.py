from __future__ import annotations

import logging
import re

import httpx

from .config import AddonOptions
from .models import Station, StationSourceRef
from .utils import slugify_filename


LOGGER = logging.getLogger(__name__)


class RadioGardenClient:
    def __init__(self, http: httpx.AsyncClient, options: AddonOptions) -> None:
        self.http = http
        self.options = options

    async def resolve_from_url(self, source_url: str, fallback_name: str | None = None) -> Station | None:
        channel_id = _extract_channel_id(source_url)
        if not channel_id:
            return None
        detail = await self._fetch_channel(channel_id)
        if not detail:
            name = fallback_name or channel_id
            return Station(
                station_id=channel_id,
                canonical_name=name,
                display_name=name,
                file_basename=slugify_filename(name),
                source_of_truth="radiogarden",
                station_page_url=source_url,
                stream_url_raw=f"https://radio.garden/api/ara/content/listen/{channel_id}/channel.mp3",
                stream_url_resolved=f"https://radio.garden/api/ara/content/listen/{channel_id}/channel.mp3",
                source_refs=[StationSourceRef(source="radiogarden", source_url=source_url, station_id=channel_id)],
                last_sync_result="fetched",
            )

        title = (
            detail.get("data", {})
            .get("title")
            or detail.get("data", {})
            .get("name")
            or fallback_name
            or channel_id
        )
        website = detail.get("data", {}).get("website")
        return Station(
            station_id=channel_id,
            canonical_name=title,
            display_name=title,
            file_basename=slugify_filename(title),
            source_of_truth="radiogarden",
            country=detail.get("data", {}).get("country"),
            station_page_url=source_url,
            homepage=website,
            stream_url_raw=f"https://radio.garden/api/ara/content/listen/{channel_id}/channel.mp3",
            stream_url_resolved=f"https://radio.garden/api/ara/content/listen/{channel_id}/channel.mp3",
            source_refs=[StationSourceRef(source="radiogarden", source_url=source_url, station_id=channel_id)],
            last_sync_result="fetched",
        )

    async def search(self, query: str, limit: int = 10) -> list[Station]:
        try:
            response = await self.http.get(
                "https://radio.garden/api/search",
                params={"q": query},
                timeout=self.options.request_timeout,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            LOGGER.warning("Radio Garden search failed: %s", exc)
            return []

        hits = payload.get("hits", {}).get("hits", [])[:limit]
        stations: list[Station] = []
        for hit in hits:
            source = hit.get("_source", {})
            if source.get("type") != "channel":
                continue
            channel_id = source.get("id")
            name = source.get("title") or source.get("name") or query
            if not channel_id:
                continue
            stations.append(
                Station(
                    station_id=channel_id,
                    canonical_name=name,
                    display_name=name,
                    file_basename=slugify_filename(name),
                    source_of_truth="radiogarden",
                    country=source.get("country"),
                    stream_url_raw=f"https://radio.garden/api/ara/content/listen/{channel_id}/channel.mp3",
                    stream_url_resolved=f"https://radio.garden/api/ara/content/listen/{channel_id}/channel.mp3",
                    source_refs=[
                        StationSourceRef(
                            source="radiogarden",
                            source_url=f"https://radio.garden/visit/unknown/{channel_id}",
                            station_id=channel_id,
                        )
                    ],
                    last_sync_result="fetched",
                )
            )
        return stations

    async def _fetch_channel(self, channel_id: str) -> dict | None:
        try:
            response = await self.http.get(
                f"https://radio.garden/api/ara/content/channel/{channel_id}",
                timeout=self.options.request_timeout,
            )
            response.raise_for_status()
            return response.json()
        except Exception as exc:
            LOGGER.warning("Radio Garden channel lookup failed: %s", exc)
            return None


def _extract_channel_id(source_url: str) -> str | None:
    match = re.search(r"/([A-Za-z0-9_-]{6,})/?$", source_url)
    return match.group(1) if match else None
