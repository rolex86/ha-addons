from __future__ import annotations

import asyncio
from collections import Counter
from datetime import datetime, timezone
import hashlib
import logging
import random

import httpx

from .config import AddonOptions, PinnedStationInput
from .exporter import build_station_bundle
from .logo_pipeline import LogoPipeline
from .models import Station, StationSourceRef, SyncProgress, SyncReport, SyncSummary
from .moode_importer import push_catalog
from .source_radiobrowser import RadioBrowserClient
from .source_radiogarden import RadioGardenClient
from .source_radionet import RadioNetClient
from .storage import EXPORTS_DIR, LOGOS_DIR, load_last_report, save_report
from .stream_resolver import StreamResolver
from .utils import ensure_unique_file_basename, hostname_from_url, normalize_text, slugify_filename


LOGGER = logging.getLogger(__name__)


class SyncService:
    def __init__(self, options: AddonOptions) -> None:
        self.options = options
        self._lock = asyncio.Lock()
        self._last_report = load_last_report()
        self._scheduler_task: asyncio.Task | None = None
        self._background_sync_task: asyncio.Task | None = None
        self._progress = SyncProgress()

    @property
    def last_report(self) -> SyncReport | None:
        return self._last_report

    @property
    def progress(self) -> SyncProgress:
        return self._progress.model_copy(deep=True)

    def is_sync_running(self) -> bool:
        return self._progress.running or self._lock.locked() or (
            self._background_sync_task is not None and not self._background_sync_task.done()
        )

    async def start_background_sync(self, mode: str = "manual") -> bool:
        if self.is_sync_running():
            return False
        self._background_sync_task = asyncio.create_task(self.run_sync(mode=mode))
        self._background_sync_task.add_done_callback(self._clear_background_sync_task)
        return True

    async def start_scheduler(self) -> None:
        if self.options.update_interval_hours <= 0:
            return
        if self._scheduler_task:
            return
        self._scheduler_task = asyncio.create_task(self._scheduler_loop())

    async def stop_scheduler(self) -> None:
        if self._scheduler_task:
            self._scheduler_task.cancel()
            try:
                await self._scheduler_task
            except asyncio.CancelledError:
                pass
            self._scheduler_task = None

    async def maybe_run_startup_sync(self) -> None:
        if not self.options.sync_on_start:
            return
        if self.options.random_start_delay_seconds > 0:
            await asyncio.sleep(random.randint(0, self.options.random_start_delay_seconds))
        await self.run_sync(mode="startup")

    async def _scheduler_loop(self) -> None:
        interval = max(1, self.options.update_interval_hours) * 3600
        while True:
            await asyncio.sleep(interval)
            await self.run_sync(mode="scheduled")

    async def run_sync(self, mode: str = "manual") -> SyncReport:
        async with self._lock:
            self._begin_progress(mode)
            summary = SyncSummary(mode=mode, dry_run=self.options.dry_run)
            stations: list[Station] = []
            try:
                async with httpx.AsyncClient(
                    headers={"User-Agent": "ha-moode-radios-addon/0.2.0"},
                    follow_redirects=True,
                ) as http:
                    self._update_progress("collect", "Collecting station candidates")
                    stations = await self._collect_stations(http, summary)
                    self._append_event(f"Collected {len(stations)} station candidates")

                    logo_pipeline = LogoPipeline(
                        http,
                        LOGOS_DIR,
                        self.options.logos,
                        self.options.request_timeout,
                    )
                    self._update_progress(
                        "logos",
                        "Preparing logos",
                        0,
                        len(stations),
                    )
                    for index, station in enumerate(stations, start=1):
                        self._update_progress(
                            "logos",
                            "Preparing logos",
                            index - 1,
                            len(stations),
                            detail=station.display_name,
                        )
                        await logo_pipeline.ensure_logo(station)
                        self._update_progress(
                            "logos",
                            "Preparing logos",
                            index,
                            len(stations),
                            detail=station.display_name,
                        )

                    self._update_progress("export", "Building export bundle")
                    export_path = EXPORTS_DIR / "stations.zip"
                    zip_path, manifest_path = build_station_bundle(stations, export_path, LOGOS_DIR)
                    summary.station_count = len(stations)
                    summary.generated_zip_path = str(zip_path)
                    summary.generated_manifest_path = str(manifest_path)
                    summary.source_counts = dict(Counter(station.source_of_truth for station in stations))
                    self._append_event(f"Built ZIP bundle with {len(stations)} stations")

                    if self.options.moode.enabled and not self.options.dry_run:
                        self._update_progress("moode", "Pushing catalog to moOde")
                        imported = await push_catalog(stations, self.options.moode)
                        summary.imported_to_moode = imported
                        if not imported:
                            summary.warnings.append("moOde import did not finish successfully.")
                            self._append_warning("moOde import did not finish successfully")
                        else:
                            self._append_event("moOde import finished successfully")
                    elif self.options.moode.enabled and self.options.dry_run:
                        summary.warnings.append("Dry-run enabled, moOde push was skipped.")
                        self._append_warning("Dry-run enabled, moOde push skipped")
            except Exception as exc:  # pragma: no cover
                LOGGER.exception("Sync failed")
                summary.errors.append(str(exc))
                self._append_error(str(exc))
            finally:
                summary.finished_at = datetime.now(timezone.utc)

            report = SyncReport(summary=summary, stations=stations)
            save_report(report)
            self._last_report = report
            self._finish_progress(summary)
            return report

    async def _collect_stations(self, http: httpx.AsyncClient, summary: SyncSummary) -> list[Station]:
        configured = list(self.options.pinned_stations)

        radiobrowser = RadioBrowserClient(http, self.options)
        radiogarden = RadioGardenClient(http, self.options)
        radionet = RadioNetClient(http, self.options)
        resolver = StreamResolver(http, self.options.request_timeout)

        stations: list[Station] = []
        pinned_resolved = 0
        pinned_failed = 0

        self._update_progress("pinned", "Resolving pinned stations", 0, len(configured))
        for index, item in enumerate(configured, start=1):
            self._update_progress(
                "pinned",
                "Resolving pinned stations",
                index - 1,
                len(configured),
                detail=item.name,
            )
            station = await self._resolve_pinned_station(item, radiobrowser, radiogarden, radionet)
            if station:
                station.pinned = True
                stations.append(station)
                pinned_resolved += 1
                self._append_event(
                    f"Pinned resolved {pinned_resolved}/{len(configured)}: {item.name}"
                )
            else:
                summary.warnings.append(f"Pinned station could not be resolved: {item.name}")
                pinned_failed += 1
                self._append_warning(
                    f"Pinned failed {pinned_failed}/{len(configured)}: {item.name}"
                )
            self._update_progress(
                "pinned",
                "Resolving pinned stations",
                index,
                len(configured),
                detail=item.name,
            )

        self._update_progress("discover", "Discovering generated stations")
        generated = await radiobrowser.discover(self.options.filters, self.options.max_generated_stations)
        stations.extend(generated)
        self._append_event(f"Discovered {len(generated)} generated stations")

        self._update_progress("dedupe", "Deduplicating stations", len(stations), len(stations))
        stations = self._dedupe(stations)
        self._assign_unique_basenames(stations)
        self._append_event(f"Deduplicated to {len(stations)} stations")

        self._update_progress("validate", "Resolving and validating streams", 0, len(stations))
        validated_ok = 0
        validated_failed = 0
        for index, station in enumerate(stations, start=1):
            self._update_progress(
                "validate",
                "Resolving and validating streams",
                index - 1,
                len(stations),
                detail=station.display_name,
            )
            if station.stream_url_raw:
                resolved_url, validation = await resolver.resolve(station.stream_url_raw)
                station.stream_url_resolved = resolved_url
                station.last_validation_result = validation
            else:
                station.last_validation_result = "missing_stream"
            if station.last_validation_result in {"failed", "missing_stream"}:
                validated_failed += 1
            else:
                validated_ok += 1
            self._update_progress(
                "validate",
                "Resolving and validating streams",
                index,
                len(stations),
                detail=station.display_name,
            )
            if index == len(stations) or index % 10 == 0:
                self._append_event(
                    f"Streams validated {index}/{len(stations)} "
                    f"(ok {validated_ok}, failed {validated_failed})"
                )

        return [station for station in stations if station.stream_url_resolved or station.stream_url_raw]

    def _begin_progress(self, mode: str) -> None:
        self._progress = SyncProgress(
            running=True,
            mode=mode,
            phase="starting",
            label="Starting sync",
            started_at=datetime.now(timezone.utc),
        )
        self._append_event(f"Sync started ({mode})")

    def _finish_progress(self, summary: SyncSummary) -> None:
        self._progress.running = False
        self._progress.phase = "done" if not summary.errors else "error"
        self._progress.label = "Sync complete" if not summary.errors else "Sync failed"
        self._progress.detail = (
            f"{summary.station_count} stations"
            if not summary.errors
            else (summary.errors[-1] if summary.errors else "Unknown error")
        )
        self._progress.finished_at = summary.finished_at
        if self._progress.total > 0:
            self._progress.done = self._progress.total
        self._progress.warnings = list(summary.warnings)
        self._progress.errors = list(summary.errors)
        self._append_event(self._progress.label)

    def _update_progress(
        self,
        phase: str,
        label: str,
        done: int | None = None,
        total: int | None = None,
        detail: str | None = None,
    ) -> None:
        self._progress.phase = phase
        self._progress.label = label
        if done is not None:
            self._progress.done = done
        if total is not None:
            self._progress.total = total
        if detail is not None:
            self._progress.detail = detail

    def _append_event(self, message: str) -> None:
        timestamp = datetime.now().strftime("%H:%M:%S")
        self._progress.recent_events.append(f"[{timestamp}] {message}")
        self._progress.recent_events = self._progress.recent_events[-40:]

    def _append_warning(self, message: str) -> None:
        self._append_event(f"WARN {message}")

    def _append_error(self, message: str) -> None:
        self._append_event(f"ERROR {message}")

    def _clear_background_sync_task(self, task: asyncio.Task) -> None:
        if self._background_sync_task is task:
            self._background_sync_task = None

    async def _resolve_pinned_station(
        self,
        item: PinnedStationInput,
        radiobrowser: RadioBrowserClient,
        radiogarden: RadioGardenClient,
        radionet: RadioNetClient,
    ) -> Station | None:
        if item.stream_url:
            return self._station_from_manual_stream(item)

        source_url = item.source_url or ""
        source_hint = (item.source_hint or self._guess_source(source_url)).strip()

        if source_hint == "radiogarden" and source_url:
            station = await radiogarden.resolve_from_url(source_url, item.name)
            if station:
                return self._merge_pinned_metadata(station, item)

        if source_hint == "radionet" and source_url:
            station = await radionet.resolve_from_url(source_url, item.name)
            if station:
                return self._merge_pinned_metadata(station, item)

        results = await radiobrowser.search(item.name, limit=10)
        if results:
            chosen = self._pick_best_match(item, results)
            return self._merge_pinned_metadata(chosen, item)

        if source_url and source_hint == "radiogarden":
            return self._station_from_manual_stream(
                item.model_copy(
                    update={
                        "stream_url": f"https://radio.garden/api/ara/content/listen/{source_url.rstrip('/').split('/')[-1]}/channel.mp3"
                    }
                ),
            )

        return None

    def _station_from_manual_stream(self, item: PinnedStationInput) -> Station:
        canonical_name = self._apply_prefix(item.name.strip())
        station_id = hashlib.sha1(f"{canonical_name}|{item.stream_url}".encode("utf-8")).hexdigest()[:16]
        source_hint = (item.source_hint or self._guess_source(item.source_url or item.stream_url)).strip()
        return Station(
            station_id=station_id,
            canonical_name=canonical_name,
            display_name=canonical_name,
            file_basename=slugify_filename(canonical_name),
            aliases=[item.name] if item.name != canonical_name else [],
            source_of_truth=source_hint or "manual",
            country=item.country,
            languages=[item.language] if item.language else [],
            genres=item.tags,
            station_page_url=item.source_url,
            stream_url_raw=item.stream_url,
            stream_url_resolved=item.stream_url,
            source_refs=[
                StationSourceRef(
                    source=source_hint or "manual",
                    source_url=item.source_url or item.stream_url,
                )
            ],
            pinned=True,
            last_sync_result="collected",
        )

    def _merge_pinned_metadata(self, station: Station, item: PinnedStationInput) -> Station:
        station.canonical_name = self._apply_prefix(item.name or station.canonical_name)
        station.display_name = station.canonical_name
        station.file_basename = slugify_filename(station.display_name)
        if item.country:
            station.country = item.country
        if item.language:
            languages = set(station.languages)
            languages.add(item.language)
            station.languages = sorted(languages)
        if item.tags:
            station.genres = sorted(set(station.genres + item.tags))
        if item.source_url and not station.station_page_url:
            station.station_page_url = item.source_url
        if item.stream_url:
            station.stream_url_raw = item.stream_url
            station.stream_url_resolved = item.stream_url
        return station

    def _pick_best_match(self, item: PinnedStationInput, candidates: list[Station]) -> Station:
        desired = normalize_text(item.name)
        scored = []
        for station in candidates:
            score = 0
            if normalize_text(station.display_name) == desired:
                score += 100
            if item.country and (station.country or "").lower() == item.country.lower():
                score += 20
            if item.language and item.language.lower() in {lang.lower() for lang in station.languages}:
                score += 10
            if item.source_url and hostname_from_url(item.source_url) and hostname_from_url(item.source_url) == hostname_from_url(station.homepage):
                score += 10
            scored.append((score, station))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return scored[0][1]

    def _dedupe(self, stations: list[Station]) -> list[Station]:
        seen: dict[str, Station] = {}
        for station in stations:
            key = self._dedupe_key(station)
            if key not in seen:
                seen[key] = station
                continue
            winner = self._merge_duplicate(seen[key], station)
            seen[key] = winner
        return sorted(seen.values(), key=lambda station: (not station.pinned, station.display_name.lower()))

    def _merge_duplicate(self, existing: Station, incoming: Station) -> Station:
        existing.aliases = sorted(set(existing.aliases + incoming.aliases + [incoming.display_name]))
        existing.genres = sorted(set(existing.genres + incoming.genres))
        existing.languages = sorted(set(existing.languages + incoming.languages))
        existing.source_refs.extend(incoming.source_refs)
        if not existing.logo_url and incoming.logo_url:
            existing.logo_url = incoming.logo_url
            existing.logo_source = incoming.logo_source
        if not existing.homepage and incoming.homepage:
            existing.homepage = incoming.homepage
        if not existing.station_page_url and incoming.station_page_url:
            existing.station_page_url = incoming.station_page_url
        if not existing.stream_url_resolved and incoming.stream_url_resolved:
            existing.stream_url_resolved = incoming.stream_url_resolved
        if incoming.pinned:
            existing.pinned = True
        return existing

    def _assign_unique_basenames(self, stations: list[Station]) -> None:
        used: set[str] = set()
        for station in stations:
            preferred = station.file_basename or slugify_filename(station.display_name)
            unique = ensure_unique_file_basename(
                preferred,
                station.station_id,
                used,
            )
            if unique != preferred:
                self._append_warning(
                    f"Adjusted file basename for {station.display_name}: {preferred} -> {unique}"
                )
            station.file_basename = unique

    def _dedupe_key(self, station: Station) -> str:
        if self.options.dedup_policy == "name_only":
            return station.canonical_name.lower()
        if self.options.dedup_policy == "stream_only":
            return (station.stream_url_resolved or station.stream_url_raw or station.canonical_name).lower()
        if self.options.dedup_policy == "domain":
            return hostname_from_url(station.stream_url_resolved or station.stream_url_raw) or station.canonical_name.lower()
        stream = station.stream_url_resolved or station.stream_url_raw or ""
        return f"{station.canonical_name.lower()}::{stream.lower()}"

    def _apply_prefix(self, name: str) -> str:
        prefix = self.options.station_name_prefix.strip()
        return f"{prefix}{name}" if prefix else name

    def _guess_source(self, source_url: str | None) -> str:
        if not source_url:
            return "manual"
        value = source_url.lower()
        if "radio.garden" in value:
            return "radiogarden"
        if "radio.net" in value:
            return "radionet"
        if "radio-browser" in value or "api.radio-browser.info" in value:
            return "radiobrowser"
        return "manual"
