from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator


OPTIONS_PATH = Path("/data/options.json")
DATA_ROOT = Path("/data/moode-radios")


class FiltersConfig(BaseModel):
    include_countries: list[str] = Field(default_factory=list)
    exclude_countries: list[str] = Field(default_factory=list)
    include_states: list[str] = Field(default_factory=list)
    exclude_states: list[str] = Field(default_factory=list)
    include_languages: list[str] = Field(default_factory=list)
    exclude_languages: list[str] = Field(default_factory=list)
    include_tags: list[str] = Field(default_factory=list)
    exclude_tags: list[str] = Field(default_factory=list)
    include_keywords: list[str] = Field(default_factory=list)
    exclude_keywords: list[str] = Field(default_factory=list)
    min_bitrate: int = 0
    allowed_codecs: list[str] = Field(default_factory=list)
    only_working_streams: bool = True
    exclude_podcasts: bool = True
    exclude_talk: bool = False


class PinnedStationInput(BaseModel):
    name: str
    source_url: str | None = None
    stream_url: str | None = None
    source_hint: str | None = None
    country: str | None = None
    language: str | None = None
    tags: list[str] = Field(default_factory=list)

    @field_validator("tags", mode="before")
    @classmethod
    def _normalize_tags(cls, value: Any) -> list[str]:
        if value in (None, "", []):
            return []
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        return [str(value).strip()] if str(value).strip() else []


class MoodeConfig(BaseModel):
    enabled: bool = False
    host: str = ""
    port: int = 22
    username: str = "pi"
    password: str = ""
    remote_import_path: str = "/tmp/ha-moode-radios"
    import_scope: str = "other"
    import_policy: str = "merge"


class LogoConfig(BaseModel):
    enabled: bool = True
    default_logo_text: str = "RADIO"


class AddonOptions(BaseModel):
    port: int = 7860
    base_url: str = "http://homeassistant.local:7860"
    update_interval_hours: int = 24
    sync_on_start: bool = True
    random_start_delay_seconds: int = 15
    source_priority: list[str] = Field(
        default_factory=lambda: ["radiogarden", "radiobrowser", "radionet"]
    )
    filters: FiltersConfig = Field(default_factory=FiltersConfig)
    pinned_stations: list[PinnedStationInput] = Field(default_factory=list)
    max_generated_stations: int = 100
    request_timeout: int = 15
    dedup_policy: str = "name_and_stream"
    station_name_prefix: str = ""
    stale_station_grace_runs: int = 3
    moode: MoodeConfig = Field(default_factory=MoodeConfig)
    logos: LogoConfig = Field(default_factory=LogoConfig)
    log_level: str = "info"
    dry_run: bool = True


def load_options_payload() -> dict[str, Any]:
    if not OPTIONS_PATH.exists():
        return {}
    return json.loads(OPTIONS_PATH.read_text(encoding="utf-8"))


def load_options() -> AddonOptions:
    payload = load_options_payload()
    options = AddonOptions.model_validate(payload)
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    return options


def save_pinned_stations_to_options(pinned_stations: list[dict[str, Any]]) -> None:
    payload = load_options_payload()
    serialized: list[dict[str, Any]] = []
    for station in pinned_stations:
        item = dict(station)
        tags = item.get("tags") or []
        if isinstance(tags, list):
            item["tags"] = ", ".join(tag for tag in tags if tag)
        if not item.get("tags"):
            item.pop("tags", None)
        serialized.append(item)
    payload["pinned_stations"] = serialized
    OPTIONS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def runtime_port(options: AddonOptions) -> int:
    raw_port = os.getenv("PORT")
    if raw_port:
        try:
            return int(raw_port)
        except ValueError:
            return options.port
    return options.port
