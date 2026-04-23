from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class StationSourceRef(BaseModel):
    source: str
    source_url: str | None = None
    station_id: str | None = None


class Station(BaseModel):
    station_id: str
    canonical_name: str
    display_name: str
    file_basename: str
    aliases: list[str] = Field(default_factory=list)
    source_refs: list[StationSourceRef] = Field(default_factory=list)
    source_of_truth: str = "manual"
    country: str | None = None
    state: str | None = None
    languages: list[str] = Field(default_factory=list)
    genres: list[str] = Field(default_factory=list)
    homepage: str | None = None
    station_page_url: str | None = None
    stream_url_raw: str | None = None
    stream_url_resolved: str | None = None
    codec: str | None = None
    bitrate: int | None = None
    status: Literal["active", "candidate", "inactive", "stale"] = "active"
    match_confidence: float = 1.0
    pinned: bool = False
    logo_path: str | None = None
    logo_url: str | None = None
    logo_source: str | None = None
    last_validation_result: str = "not_checked"
    last_seen: datetime = Field(default_factory=utc_now)
    last_sync_result: str = "pending"


class SyncSummary(BaseModel):
    started_at: datetime = Field(default_factory=utc_now)
    finished_at: datetime | None = None
    mode: str = "manual"
    station_count: int = 0
    generated_zip_path: str | None = None
    generated_manifest_path: str | None = None
    imported_to_moode: bool = False
    dry_run: bool = True
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    source_counts: dict[str, int] = Field(default_factory=dict)


class SyncReport(BaseModel):
    summary: SyncSummary
    stations: list[Station] = Field(default_factory=list)
