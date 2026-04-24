from __future__ import annotations

import logging
from urllib.parse import quote

import httpx

from .config import AddonOptions, FiltersConfig
from .models import Station, StationSourceRef
from .utils import keyword_match, slugify_filename


LOGGER = logging.getLogger(__name__)
API_BASES = [
    "https://de1.api.radio-browser.info",
    "https://nl1.api.radio-browser.info",
    "https://fr1.api.radio-browser.info",
]


class RadioBrowserClient:
    def __init__(self, http: httpx.AsyncClient, options: AddonOptions) -> None:
        self.http = http
        self.options = options

    async def search(self, query: str, limit: int | None = None) -> list[Station]:
        limit = limit or self.options.max_generated_stations
        for base in API_BASES:
            try:
                response = await self.http.get(
                    f"{base}/json/stations/search",
                    params={
                        "name": query,
                        "hidebroken": "true" if self.options.filters.only_working_streams else "false",
                        "limit": limit,
                    },
                    timeout=self.options.request_timeout,
                )
                response.raise_for_status()
                return self._convert_many(response.json())
            except Exception as exc:
                LOGGER.warning("Radio Browser search failed for %s: %s", base, exc)
        return []

    async def discover(self, filters: FiltersConfig, limit: int | None = None) -> list[Station]:
        limit = limit or self.options.max_generated_stations
        page_size = max(limit * 2, 50)
        max_pages = 8
        base_params = {
            "hidebroken": "true" if filters.only_working_streams else "false",
            "limit": page_size,
            "reverse": "true",
            "order": "clickcount",
        }
        country = filters.include_countries[0] if filters.include_countries else None
        if country and len(country) == 2:
            base_params["countrycode"] = country.upper()
        elif country:
            base_params["country"] = country

        tag = filters.include_tags[0] if filters.include_tags else None
        if tag:
            base_params["tag"] = tag

        for base in API_BASES:
            discovered: list[Station] = []
            seen: set[str] = set()
            try:
                for page in range(max_pages):
                    params = dict(base_params)
                    params["offset"] = page * page_size
                    response = await self.http.get(
                        f"{base}/json/stations/search",
                        params=params,
                        timeout=self.options.request_timeout,
                    )
                    response.raise_for_status()
                    payload = response.json()
                    if not payload:
                        break
                    stations = self._convert_many(payload)
                    for station in stations:
                        key = station.station_id or station.stream_url_resolved or station.display_name.lower()
                        if key in seen:
                            continue
                        seen.add(key)
                        if self._matches_filters(station, filters):
                            discovered.append(station)
                            if len(discovered) >= limit:
                                return discovered
                    if len(payload) < page_size:
                        break
                return discovered
            except Exception as exc:
                LOGGER.warning("Radio Browser discover failed for %s: %s", base, exc)
        return []

    async def list_facets(
        self,
        kind: str,
        filter_text: str | None = None,
        limit: int = 80,
    ) -> list[dict[str, int | str]]:
        endpoint = {
            "tags": "tags",
            "countries": "countries",
            "languages": "languages",
            "states": "states",
        }.get(kind)
        if not endpoint:
            raise ValueError(f"Unsupported Radio Browser facet kind: {kind}")

        suffix = ""
        query = (filter_text or "").strip()
        if query:
            suffix = f"/{quote(query, safe='')}"

        params = {
            "order": "stationcount",
            "reverse": "true",
            "hidebroken": "true" if self.options.filters.only_working_streams else "false",
        }
        if limit > 0:
            params["limit"] = str(limit)

        for base in API_BASES:
            try:
                response = await self.http.get(
                    f"{base}/json/{endpoint}{suffix}",
                    params=params,
                    timeout=self.options.request_timeout,
                )
                response.raise_for_status()
                return self._normalize_facets(response.json(), limit)
            except Exception as exc:
                LOGGER.warning("Radio Browser facet fetch failed for %s/%s: %s", base, endpoint, exc)
        return []

    def _convert_many(self, payload: list[dict]) -> list[Station]:
        stations: list[Station] = []
        for item in payload:
            name = (item.get("name") or "").strip()
            if not name:
                continue
            languages = _split_csv(item.get("language"))
            tags = _split_csv(item.get("tags"))
            station = Station(
                station_id=item.get("stationuuid") or slugify_filename(name),
                canonical_name=name,
                display_name=name,
                file_basename=slugify_filename(name),
                source_of_truth="radiobrowser",
                country=item.get("country") or item.get("countrycode"),
                state=item.get("state"),
                languages=languages,
                genres=tags,
                homepage=item.get("homepage"),
                station_page_url=item.get("homepage"),
                stream_url_raw=item.get("url"),
                stream_url_resolved=item.get("url_resolved") or item.get("url"),
                codec=item.get("codec"),
                bitrate=_to_int(item.get("bitrate")),
                logo_url=item.get("favicon"),
                logo_source="radiobrowser" if item.get("favicon") else None,
                last_validation_result="radiobrowser-lastcheckok"
                if item.get("lastcheckok")
                else "radiobrowser-unchecked",
                source_refs=[
                    StationSourceRef(
                        source="radiobrowser",
                        source_url=item.get("homepage") or item.get("url"),
                        station_id=item.get("stationuuid"),
                    )
                ],
                last_sync_result="fetched",
            )
            stations.append(station)
        return stations

    def _matches_filters(self, station: Station, filters: FiltersConfig) -> bool:
        if filters.include_countries and (station.country or "").lower() not in {
            value.lower() for value in filters.include_countries
        }:
            return False
        if filters.exclude_countries and (station.country or "").lower() in {
            value.lower() for value in filters.exclude_countries
        }:
            return False
        if filters.include_states and (station.state or "").lower() not in {
            value.lower() for value in filters.include_states
        }:
            return False
        if filters.exclude_states and (station.state or "").lower() in {
            value.lower() for value in filters.exclude_states
        }:
            return False
        if filters.include_languages and not set(_normalize_list(station.languages)).intersection(
            _normalize_list(filters.include_languages)
        ):
            return False
        if filters.exclude_languages and set(_normalize_list(station.languages)).intersection(
            _normalize_list(filters.exclude_languages)
        ):
            return False
        if filters.include_tags and not set(_normalize_list(station.genres)).intersection(
            _normalize_list(filters.include_tags)
        ):
            return False
        if filters.exclude_tags and set(_normalize_list(station.genres)).intersection(
            _normalize_list(filters.exclude_tags)
        ):
            return False
        if filters.min_bitrate and (station.bitrate or 0) < filters.min_bitrate:
            return False
        if filters.allowed_codecs and (station.codec or "").lower() not in {
            value.lower() for value in filters.allowed_codecs
        }:
            return False
        title = " ".join([station.display_name, *station.genres, *station.languages])
        if not keyword_match(title, filters.include_keywords):
            return False
        if filters.exclude_keywords and keyword_match(title, filters.exclude_keywords):
            return False
        if filters.exclude_podcasts and any("podcast" in tag.lower() for tag in station.genres):
            return False
        if filters.exclude_talk and any(tag.lower() in {"talk", "news", "speech"} for tag in station.genres):
            return False
        return True

    def _normalize_facets(self, payload: list[dict], limit: int) -> list[dict[str, int | str]]:
        facets: list[dict[str, int | str]] = []
        seen: set[str] = set()
        for item in payload:
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            key = name.lower()
            if key in seen:
                continue
            seen.add(key)
            facets.append(
                {
                    "name": name,
                    "count": _to_int(item.get("stationcount")) or 0,
                }
            )
            if limit > 0 and len(facets) >= limit:
                break
        return facets


def _split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def _to_int(value: object) -> int | None:
    try:
        if value in (None, ""):
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _normalize_list(values: list[str]) -> set[str]:
    return {value.lower().strip() for value in values if value.strip()}
