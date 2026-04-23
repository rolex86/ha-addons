from __future__ import annotations

import json
from pathlib import Path

from .config import DATA_ROOT
from .models import SyncReport


EXPORTS_DIR = DATA_ROOT / "exports"
REPORTS_DIR = DATA_ROOT / "reports"
CACHE_DIR = DATA_ROOT / "cache"
LOGOS_DIR = CACHE_DIR / "logos"
PINNED_STATIONS_PATH = DATA_ROOT / "pinned_stations.json"
LAST_REPORT_PATH = REPORTS_DIR / "last_report.json"


def ensure_storage() -> None:
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    LOGOS_DIR.mkdir(parents=True, exist_ok=True)


def save_report(report: SyncReport) -> None:
    ensure_storage()
    LAST_REPORT_PATH.write_text(
        report.model_dump_json(indent=2),
        encoding="utf-8",
    )


def load_last_report() -> SyncReport | None:
    if not LAST_REPORT_PATH.exists():
        return None
    return SyncReport.model_validate_json(LAST_REPORT_PATH.read_text(encoding="utf-8"))


def load_legacy_pinned_station_overrides() -> list[dict]:
    if not PINNED_STATIONS_PATH.exists():
        return []
    return json.loads(PINNED_STATIONS_PATH.read_text(encoding="utf-8"))


def clear_legacy_pinned_station_overrides() -> None:
    if PINNED_STATIONS_PATH.exists():
        PINNED_STATIONS_PATH.unlink()
