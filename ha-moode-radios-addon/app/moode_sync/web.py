from __future__ import annotations

import asyncio
import contextlib
import json
import time
from contextlib import asynccontextmanager

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import TypeAdapter

from .config import (
    FiltersConfig,
    PinnedStationInput,
    load_options,
    runtime_port,
    save_filters_to_options,
    save_pinned_stations_to_options,
)
from .logging_utils import configure_logging
from .source_radiobrowser import RadioBrowserClient
from .storage import (
    EXPORTS_DIR,
    clear_legacy_pinned_station_overrides,
    ensure_storage,
    load_legacy_pinned_station_overrides,
)
from .sync_service import SyncService


OPTIONS = load_options()
configure_logging(OPTIONS.log_level)
ensure_storage()
PINNED_ADAPTER = TypeAdapter(list[PinnedStationInput])
FILTERS_ADAPTER = TypeAdapter(FiltersConfig)
FILTER_FACET_LIMITS = {
    "tags": 120,
    "countries": 80,
    "languages": 80,
    "states": 100,
}
FILTER_FACET_CACHE_TTL = 1800.0
FILTER_FACET_CACHE: dict[tuple[str, str], tuple[float, list[dict[str, int | str]]]] = {}
CODEC_CANDIDATES = ["aac", "aac+", "flac", "mp3", "ogg", "opus"]


def _dedupe_pinned_stations(items: list[dict]) -> list[dict]:
    seen: set[str] = set()
    deduped: list[dict] = []
    for item in items:
        key = json.dumps(item, sort_keys=True, ensure_ascii=True)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _migrate_legacy_pinned_stations() -> None:
    legacy = load_legacy_pinned_station_overrides()
    if not legacy:
        return
    merged = _dedupe_pinned_stations(
        [item.model_dump(mode="json") for item in OPTIONS.pinned_stations] + legacy
    )
    OPTIONS.pinned_stations = [PinnedStationInput.model_validate(item) for item in merged]
    save_pinned_stations_to_options(merged)
    clear_legacy_pinned_station_overrides()


_migrate_legacy_pinned_stations()
SERVICE = SyncService(OPTIONS)


@asynccontextmanager
async def lifespan(_: FastAPI):
    startup_task = asyncio.create_task(SERVICE.maybe_run_startup_sync())
    await SERVICE.start_scheduler()
    try:
        yield
    finally:
        startup_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await startup_task
        await SERVICE.stop_scheduler()


app = FastAPI(title="moOde Radios Sync", lifespan=lifespan)


def _shared_pinned_stations() -> list[dict]:
    return [item.model_dump(mode="json") for item in OPTIONS.pinned_stations]


def _save_shared_pinned_stations(payload: list[dict]) -> None:
    validated = [PinnedStationInput.model_validate(item) for item in payload]
    serializable = [item.model_dump(mode="json") for item in validated]
    OPTIONS.pinned_stations = validated
    save_pinned_stations_to_options(serializable)


def _current_filters() -> dict:
    return OPTIONS.filters.model_dump(mode="json")


def _save_filters(payload: dict) -> dict:
    validated = FILTERS_ADAPTER.validate_python(payload)
    OPTIONS.filters = validated
    return save_filters_to_options(validated.model_dump(mode="json")).model_dump(mode="json")


async def _load_filter_facet(kind: str, query: str | None = None) -> list[dict[str, int | str]]:
    if kind not in FILTER_FACET_LIMITS:
        raise HTTPException(status_code=400, detail=f"Unsupported filter facet: {kind}")
    normalized_query = (query or "").strip().lower()
    cache_key = (kind, normalized_query)
    cached = FILTER_FACET_CACHE.get(cache_key)
    now = time.monotonic()
    if cached and (now - cached[0]) < FILTER_FACET_CACHE_TTL:
        return cached[1]

    async with httpx.AsyncClient(
        headers={"User-Agent": "ha-moode-radios-addon/0.3.0"},
        follow_redirects=True,
    ) as http:
        client = RadioBrowserClient(http, OPTIONS)
        items = await client.list_facets(
            kind,
            filter_text=normalized_query or None,
            limit=FILTER_FACET_LIMITS[kind],
        )

    FILTER_FACET_CACHE[cache_key] = (now, items)
    if len(FILTER_FACET_CACHE) > 48:
        oldest = sorted(FILTER_FACET_CACHE.items(), key=lambda item: item[1][0])[:12]
        for key, _ in oldest:
            FILTER_FACET_CACHE.pop(key, None)
    return items


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    report = SERVICE.last_report
    station_count = report.summary.station_count if report else 0
    last_run_iso = report.summary.finished_at.isoformat() if report and report.summary.finished_at else ""
    pinned_json = json.dumps(_shared_pinned_stations(), indent=2)
    pinned_count = len(_shared_pinned_stations())
    filters_json = json.dumps(_current_filters(), indent=2)
    progress_json = json.dumps(SERVICE.progress.model_dump(mode="json"), indent=2)
    codec_candidates_json = json.dumps(CODEC_CANDIDATES)
    return f"""
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>moOde Radios Sync</title>
    <style>
      :root {{
        --bg: #0a1018;
        --bg-soft: #121a26;
        --card: rgba(18, 26, 38, 0.86);
        --card-strong: rgba(12, 18, 28, 0.94);
        --ink: #eaf2ff;
        --muted: #8fa4c2;
        --accent: #4db6ff;
        --accent-strong: #1d8fe1;
        --line: rgba(118, 146, 181, 0.24);
        --glow: rgba(77, 182, 255, 0.16);
      }}
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        font-family: "Trebuchet MS", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(77, 182, 255, 0.18), transparent 24%),
          radial-gradient(circle at top right, rgba(94, 234, 212, 0.12), transparent 20%),
          linear-gradient(180deg, #07101b, var(--bg));
      }}
      main {{ max-width: 1100px; margin: 0 auto; padding: 32px 20px 56px; }}
      .hero {{
        padding: 28px;
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--card);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.34);
        backdrop-filter: blur(14px);
      }}
      h1 {{ margin: 0 0 10px; font-size: clamp(2.2rem, 4vw, 4rem); }}
      p {{ color: var(--muted); line-height: 1.55; }}
      .actions {{ display: flex; flex-wrap: wrap; gap: 12px; margin-top: 18px; }}
      button, a {{
        border: 1px solid transparent;
        border-radius: 999px;
        padding: 12px 18px;
        text-decoration: none;
        font: inherit;
        transition: transform 140ms ease, background 140ms ease, border-color 140ms ease;
      }}
      button {{
        background: var(--accent);
        color: #07101b;
        cursor: pointer;
        font-weight: 700;
      }}
      a {{
        background: rgba(143, 164, 194, 0.12);
        border-color: var(--line);
        color: var(--ink);
      }}
      button:hover, a:hover {{
        transform: translateY(-1px);
      }}
      button:hover {{
        background: #79cbff;
      }}
      button:disabled {{
        cursor: wait;
        opacity: 0.72;
        transform: none;
      }}
      .grid {{
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
        margin-top: 20px;
      }}
      .card {{
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--card-strong);
        padding: 18px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
      }}
      textarea, pre {{
        width: 100%;
        min-height: 280px;
        white-space: pre-wrap;
        word-break: break-word;
        background: #09111b;
        color: #dbe8fb;
        padding: 18px;
        border-radius: 18px;
        border: 1px solid var(--line);
        margin-top: 20px;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02), 0 0 0 6px transparent;
        font-family: "SFMono-Regular", Consolas, monospace;
      }}
      textarea:focus {{
        outline: none;
        border-color: var(--accent-strong);
        box-shadow: 0 0 0 6px var(--glow);
      }}
      .section-title {{ margin-top: 26px; margin-bottom: 8px; font-size: 1.2rem; }}
      .section-note {{ margin-top: 8px; color: var(--muted); font-size: 0.95rem; }}
      .progress-wrap {{
        margin-top: 20px;
        padding: 18px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: var(--card-strong);
      }}
      .progress-head {{
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }}
      .badge {{
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(143, 164, 194, 0.08);
        color: var(--muted);
        font-size: 0.92rem;
      }}
      .badge strong {{
        color: var(--ink);
      }}
      .badge.state-running {{
        background: rgba(77, 182, 255, 0.14);
        border-color: rgba(77, 182, 255, 0.34);
      }}
      .badge.state-done {{
        background: rgba(124, 242, 213, 0.14);
        border-color: rgba(124, 242, 213, 0.34);
      }}
      .badge.state-error {{
        background: rgba(255, 107, 107, 0.14);
        border-color: rgba(255, 107, 107, 0.34);
      }}
      .badge.state-idle {{
        background: rgba(143, 164, 194, 0.08);
      }}
      .progress-bar {{
        margin-top: 14px;
        width: 100%;
        height: 14px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(143, 164, 194, 0.12);
        border: 1px solid var(--line);
      }}
      .progress-fill {{
        height: 100%;
        width: 0%;
        border-radius: 999px;
        background: linear-gradient(90deg, #4db6ff, #7cf2d5);
        transition: width 180ms ease;
      }}
      .progress-meta {{
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
        margin-top: 14px;
      }}
      .progress-item {{
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(143, 164, 194, 0.06);
      }}
      .progress-item-label {{
        color: var(--muted);
        font-size: 0.88rem;
        margin-bottom: 6px;
      }}
      .mini-stats {{
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
        margin-top: 14px;
      }}
      .mini-stat {{
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 12px 14px;
        background: rgba(143, 164, 194, 0.05);
      }}
      .mini-stat-label {{
        color: var(--muted);
        font-size: 0.84rem;
        margin-bottom: 6px;
      }}
      .log-line-info {{
        color: #dbe8fb;
      }}
      .log-line-warn {{
        color: #ffd166;
      }}
      .log-line-error {{
        color: #ff8d8d;
      }}
      .filter-shell {{
        margin-top: 22px;
        padding: 18px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(13, 19, 29, 0.95), rgba(10, 16, 24, 0.98));
      }}
      .filter-toolbar {{
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
      }}
      .filter-layout {{
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 16px;
        margin-top: 16px;
      }}
      .facet-card, .settings-card {{
        border: 1px solid var(--line);
        border-radius: 18px;
        background: rgba(143, 164, 194, 0.05);
        padding: 16px;
      }}
      .facet-head {{
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
      }}
      .facet-head h3, .settings-card h3 {{
        margin: 0;
        font-size: 1.02rem;
      }}
      .facet-count {{
        color: var(--muted);
        font-size: 0.84rem;
      }}
      .text-input, .number-input {{
        width: 100%;
        margin-top: 12px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: #09111b;
        color: var(--ink);
        padding: 12px 14px;
        font: inherit;
      }}
      .text-input:focus, .number-input:focus {{
        outline: none;
        border-color: var(--accent-strong);
        box-shadow: 0 0 0 4px var(--glow);
      }}
      .facet-actions {{
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 12px;
      }}
      .facet-actions button.small-btn, .codec-pills button, .selected-chip button {{
        padding: 9px 14px;
      }}
      .small-btn {{
        background: rgba(77, 182, 255, 0.12);
        color: var(--ink);
        border-color: rgba(77, 182, 255, 0.22);
      }}
      .small-btn.alt {{
        background: rgba(143, 164, 194, 0.08);
      }}
      .pill-grid, .selected-grid, .codec-pills {{
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 14px;
      }}
      .filter-pill, .codec-pill, .selected-chip {{
        border-radius: 999px;
        border: 1px solid rgba(118, 146, 181, 0.28);
        background: rgba(143, 164, 194, 0.07);
        color: var(--ink);
        padding: 10px 14px;
        font: inherit;
      }}
      .filter-pill {{
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }}
      .filter-pill:hover, .codec-pill:hover {{
        transform: translateY(-1px);
      }}
      .filter-pill[data-state="include"], .selected-chip.include {{
        background: rgba(124, 242, 213, 0.16);
        border-color: rgba(124, 242, 213, 0.42);
      }}
      .filter-pill[data-state="exclude"], .selected-chip.exclude {{
        background: rgba(255, 107, 107, 0.16);
        border-color: rgba(255, 107, 107, 0.38);
      }}
      .filter-pill .count {{
        color: var(--muted);
        font-size: 0.82rem;
      }}
      .selected-chip {{
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding-right: 10px;
      }}
      .selected-chip button {{
        background: transparent;
        border: 0;
        color: inherit;
        cursor: pointer;
        padding: 0;
      }}
      .facet-hint, .settings-note {{
        margin-top: 10px;
        color: var(--muted);
        font-size: 0.9rem;
      }}
      .settings-grid {{
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 14px;
        margin-top: 14px;
      }}
      .toggle-grid {{
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
        margin-top: 14px;
      }}
      .toggle {{
        display: flex;
        gap: 10px;
        align-items: center;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(143, 164, 194, 0.05);
      }}
      .toggle input {{
        width: 18px;
        height: 18px;
      }}
      .summary-line {{
        margin-top: 12px;
        color: var(--muted);
        font-size: 0.92rem;
      }}
      @media (max-width: 720px) {{
        .filter-toolbar {{
          align-items: stretch;
        }}
        .filter-toolbar > * {{
          width: 100%;
        }}
      }}
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <h1>moOde Radios Sync</h1>
        <p>
          Configure pinned stations as JSON, run sync manually, preview the last report,
          and download the generated radio bundle for moOde.
        </p>
        <div class="actions">
          <button onclick="saveFilters()">Save filters</button>
          <button onclick="savePinned()">Save pinned stations</button>
          <button id="runSyncButton" onclick="runSync()">Run Sync Now</button>
          <a href="downloads/stations.zip">Download Latest ZIP</a>
          <a href="api/report">Open JSON Report</a>
        </div>
        <div class="grid">
          <div class="card"><div>Stations in last run</div><div style="font-size:1.5rem;margin-top:8px">{station_count}</div></div>
          <div class="card"><div>Last completed sync</div><div id="lastCompletedSync" style="font-size:1rem;margin-top:8px">Never</div></div>
          <div class="card"><div>Dry run</div><div style="font-size:1.5rem;margin-top:8px">{str(OPTIONS.dry_run).lower()}</div></div>
          <div class="card"><div>Pinned stations</div><div style="font-size:1.5rem;margin-top:8px">{pinned_count}</div></div>
        </div>
        <div class="section-title">Discovery Filters</div>
        <div class="section-note">
          Same filter config as the Home Assistant add-on settings. Click a pill to cycle
          <strong>include</strong> → <strong>exclude</strong> → <strong>ignore</strong>.
        </div>
        <div class="filter-shell">
          <div class="filter-toolbar">
            <div class="badge">Active filters: <strong id="filterActiveCount">0</strong></div>
            <div class="badge">Loaded facets: <strong id="filterFacetStatus">waiting</strong></div>
          </div>
          <div class="filter-layout">
            <div class="facet-card">
              <div class="facet-head">
                <h3>Tags / Genres</h3>
                <div class="facet-count" id="facetCount-tags">0 visible</div>
              </div>
              <input id="facetSearch-tags" class="text-input" placeholder="Search tags like jazz, chillout, talk..." />
              <div class="facet-actions">
                <input id="facetCustom-tags" class="text-input" placeholder="Add custom tag" />
                <button class="small-btn" type="button" onclick="addFacetValue('tags')">Add</button>
                <button class="small-btn alt" type="button" onclick="clearFacet('tags')">Clear</button>
              </div>
              <div class="selected-grid" id="facetSelected-tags"></div>
              <div class="pill-grid" id="facetBox-tags"></div>
              <div class="facet-hint">Top Radio Browser tags plus anything already selected.</div>
            </div>
            <div class="facet-card">
              <div class="facet-head">
                <h3>Countries</h3>
                <div class="facet-count" id="facetCount-countries">0 visible</div>
              </div>
              <input id="facetSearch-countries" class="text-input" placeholder="Search countries or codes..." />
              <div class="facet-actions">
                <input id="facetCustom-countries" class="text-input" placeholder="Add custom country" />
                <button class="small-btn" type="button" onclick="addFacetValue('countries')">Add</button>
                <button class="small-btn alt" type="button" onclick="clearFacet('countries')">Clear</button>
              </div>
              <div class="selected-grid" id="facetSelected-countries"></div>
              <div class="pill-grid" id="facetBox-countries"></div>
            </div>
            <div class="facet-card">
              <div class="facet-head">
                <h3>Languages</h3>
                <div class="facet-count" id="facetCount-languages">0 visible</div>
              </div>
              <input id="facetSearch-languages" class="text-input" placeholder="Search languages..." />
              <div class="facet-actions">
                <input id="facetCustom-languages" class="text-input" placeholder="Add custom language" />
                <button class="small-btn" type="button" onclick="addFacetValue('languages')">Add</button>
                <button class="small-btn alt" type="button" onclick="clearFacet('languages')">Clear</button>
              </div>
              <div class="selected-grid" id="facetSelected-languages"></div>
              <div class="pill-grid" id="facetBox-languages"></div>
            </div>
            <div class="facet-card">
              <div class="facet-head">
                <h3>States / Regions</h3>
                <div class="facet-count" id="facetCount-states">0 visible</div>
              </div>
              <input id="facetSearch-states" class="text-input" placeholder="Search states or regions..." />
              <div class="facet-actions">
                <input id="facetCustom-states" class="text-input" placeholder="Add custom state" />
                <button class="small-btn" type="button" onclick="addFacetValue('states')">Add</button>
                <button class="small-btn alt" type="button" onclick="clearFacet('states')">Clear</button>
              </div>
              <div class="selected-grid" id="facetSelected-states"></div>
              <div class="pill-grid" id="facetBox-states"></div>
            </div>
            <div class="settings-card">
              <h3>Codec, Bitrate, Keywords</h3>
              <div class="settings-note">Codecs are include-only. Keywords use comma separated terms.</div>
              <div class="settings-grid">
                <label>
                  <div class="progress-item-label">Min bitrate</div>
                  <input id="filterMinBitrate" type="number" class="number-input" min="0" step="1" />
                </label>
                <label>
                  <div class="progress-item-label">Include keywords</div>
                  <input id="filterIncludeKeywords" class="text-input" placeholder="jazz, live, berlin" />
                </label>
                <label>
                  <div class="progress-item-label">Exclude keywords</div>
                  <input id="filterExcludeKeywords" class="text-input" placeholder="podcast, replay" />
                </label>
              </div>
              <div class="progress-item-label" style="margin-top:14px">Allowed codecs</div>
              <div class="codec-pills" id="codecPills"></div>
              <div class="toggle-grid">
                <label class="toggle">
                  <input id="filterOnlyWorking" type="checkbox" />
                  <span>Only working streams</span>
                </label>
                <label class="toggle">
                  <input id="filterExcludePodcasts" type="checkbox" />
                  <span>Exclude podcasts</span>
                </label>
                <label class="toggle">
                  <input id="filterExcludeTalk" type="checkbox" />
                  <span>Exclude talk / news</span>
                </label>
              </div>
              <div class="summary-line" id="filterSummaryLine">No active filters yet.</div>
            </div>
          </div>
        </div>
        <div class="section-title">Pinned Stations</div>
        <div class="section-note">
          This is the same shared pinned station list used by both the Home Assistant add-on Configuration tab
          and this web UI. Saving here updates the add-on options file directly.
        </div>
        <textarea id="pinned">{pinned_json}</textarea>
        <div class="section-title">Sync Progress</div>
        <div class="progress-wrap">
          <div class="progress-head">
            <div class="badge">State: <strong id="syncState">idle</strong></div>
            <div class="badge">Phase: <strong id="syncPhase">idle</strong></div>
            <div class="badge">Progress: <strong id="syncCount">0 / 0</strong></div>
          </div>
          <div class="progress-bar">
            <div id="syncBar" class="progress-fill"></div>
          </div>
          <div class="progress-meta">
            <div class="progress-item">
              <div class="progress-item-label">Current step</div>
              <div id="syncLabel">Idle</div>
            </div>
            <div class="progress-item">
              <div class="progress-item-label">Current target</div>
              <div id="syncDetail">Waiting for next run</div>
            </div>
          </div>
          <div class="mini-stats">
            <div class="mini-stat">
              <div class="mini-stat-label">Pinned summary</div>
              <div id="syncPinnedSummary">No pinned work yet</div>
            </div>
            <div class="mini-stat">
              <div class="mini-stat-label">Validation summary</div>
              <div id="syncValidationSummary">No validation yet</div>
            </div>
            <div class="mini-stat">
              <div class="mini-stat-label">Warnings / Errors</div>
              <div id="syncIssueSummary">0 warnings, 0 errors</div>
            </div>
          </div>
        </div>
        <div class="section-title">Result</div>
        <pre id="result">Ready.</pre>
        <div class="section-title">Live Log</div>
        <pre id="progressLog">Loading status...</pre>
      </section>
    </main>
    <script>
      let syncStatusTimer = null;
      const DEFAULT_FILTERS = {filters_json};
      const CODEC_OPTIONS = {codec_candidates_json};
      const LAST_RUN_ISO = {json.dumps(last_run_iso)};
      const FACETS = {{
        tags: {{ includeKey: "include_tags", excludeKey: "exclude_tags" }},
        countries: {{ includeKey: "include_countries", excludeKey: "exclude_countries" }},
        languages: {{ includeKey: "include_languages", excludeKey: "exclude_languages" }},
        states: {{ includeKey: "include_states", excludeKey: "exclude_states" }}
      }};
      const facetCache = new Map();
      const facetTimers = {{}};
      const loadedFacets = new Set();
      const filterState = JSON.parse(JSON.stringify(DEFAULT_FILTERS));

      function escapeHtml(value) {{
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
      }}

      function renderLastCompletedSync() {{
        const el = document.getElementById("lastCompletedSync");
        if (!el) return;
        if (!LAST_RUN_ISO) {{
          el.textContent = "Never";
          return;
        }}
        const parsed = new Date(LAST_RUN_ISO);
        if (Number.isNaN(parsed.getTime())) {{
          el.textContent = LAST_RUN_ISO;
          return;
        }}
        el.textContent = parsed.toLocaleString(undefined, {{
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }});
        el.title = LAST_RUN_ISO;
      }}

      function normalizeList(value) {{
        const raw = Array.isArray(value)
          ? value
          : String(value || "").split(",");
        const seen = new Set();
        const out = [];
        for (const item of raw) {{
          const text = String(item || "").trim();
          if (!text) continue;
          const key = text.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(text);
        }}
        return out;
      }}

      function csvFromInput(id) {{
        return normalizeList(document.getElementById(id)?.value || "");
      }}

      function setInputCsv(id, values) {{
        const el = document.getElementById(id);
        if (el) el.value = normalizeList(values).join(", ");
      }}

      function facetLists(kind) {{
        const cfg = FACETS[kind];
        return {{
          include: normalizeList(filterState[cfg.includeKey] || []),
          exclude: normalizeList(filterState[cfg.excludeKey] || []),
        }};
      }}

      function setFacetLists(kind, include, exclude) {{
        const cfg = FACETS[kind];
        filterState[cfg.includeKey] = normalizeList(include);
        filterState[cfg.excludeKey] = normalizeList(exclude);
      }}

      function countActiveFilters() {{
        let total = 0;
        for (const key of Object.keys(FACETS)) {{
          const lists = facetLists(key);
          total += lists.include.length + lists.exclude.length;
        }}
        total += normalizeList(filterState.include_keywords || []).length;
        total += normalizeList(filterState.exclude_keywords || []).length;
        total += normalizeList(filterState.allowed_codecs || []).length;
        if (Number(filterState.min_bitrate || 0) > 0) total += 1;
        if (filterState.only_working_streams === false) total += 1;
        if (filterState.exclude_podcasts === false) total += 1;
        if (filterState.exclude_talk === true) total += 1;
        return total;
      }}

      function refreshFilterSummary() {{
        const active = countActiveFilters();
        document.getElementById("filterActiveCount").textContent = String(active);
        const summary = [];
        for (const kind of Object.keys(FACETS)) {{
          const lists = facetLists(kind);
          if (lists.include.length || lists.exclude.length) {{
            summary.push(`${{kind}}: +${{lists.include.length}} / -${{lists.exclude.length}}`);
          }}
        }}
        if (Number(filterState.min_bitrate || 0) > 0) {{
          summary.push(`bitrate >= ${{filterState.min_bitrate}}`);
        }}
        if (normalizeList(filterState.allowed_codecs || []).length) {{
          summary.push(`codecs: ${{normalizeList(filterState.allowed_codecs || []).join(", ")}}`);
        }}
        if (normalizeList(filterState.include_keywords || []).length) {{
          summary.push(`keywords+: ${{normalizeList(filterState.include_keywords || []).join(", ")}}`);
        }}
        if (normalizeList(filterState.exclude_keywords || []).length) {{
          summary.push(`keywords-: ${{normalizeList(filterState.exclude_keywords || []).join(", ")}}`);
        }}
        if (filterState.only_working_streams === false) {{
          summary.push("including broken streams");
        }}
        if (filterState.exclude_podcasts === false) {{
          summary.push("podcasts allowed");
        }}
        if (filterState.exclude_talk === true) {{
          summary.push("talk/news excluded");
        }}
        document.getElementById("filterSummaryLine").textContent = summary.length
          ? summary.join(" • ")
          : "No active filters yet.";
      }}

      function updateFacetStatus() {{
        document.getElementById("filterFacetStatus").textContent = `${{loadedFacets.size}} / ${{Object.keys(FACETS).length}} ready`;
      }}

      function currentFacetCacheKey(kind) {{
        const search = document.getElementById(`facetSearch-${{kind}}`);
        const query = String(search?.value || "").trim().toLowerCase();
        return `${{kind}}::${{query}}`;
      }}

      function mergeFacetItems(kind, items) {{
        const merged = [];
        const seen = new Set();
        const lists = facetLists(kind);
        for (const value of [...lists.include, ...lists.exclude]) {{
          const key = value.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push({{ name: value, count: null }});
        }}
        for (const item of items || []) {{
          const name = String(item?.name || "").trim();
          if (!name) continue;
          const key = name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(item);
        }}
        return merged;
      }}

      function renderSelectedFacet(kind) {{
        const box = document.getElementById(`facetSelected-${{kind}}`);
        if (!box) return;
        const lists = facetLists(kind);
        const selected = [
          ...lists.include.map((value) => [value, "include"]),
          ...lists.exclude.map((value) => [value, "exclude"]),
        ];
        if (!selected.length) {{
          box.innerHTML = "";
          return;
        }}
        box.innerHTML = "";
        for (const [value, mode] of selected) {{
          const chip = document.createElement("span");
          chip.className = `selected-chip ${{mode}}`;
          const label = document.createElement("span");
          label.textContent = value;
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "x";
          remove.addEventListener("click", () => removeFacetValue(kind, mode, value));
          chip.appendChild(label);
          chip.appendChild(remove);
          box.appendChild(chip);
        }}
      }}

      function renderFacet(kind, items) {{
        const box = document.getElementById(`facetBox-${{kind}}`);
        const count = document.getElementById(`facetCount-${{kind}}`);
        if (!box || !count) return;
        const merged = mergeFacetItems(kind, items);
        const lists = facetLists(kind);
        const includeSet = new Set(lists.include.map((item) => item.toLowerCase()));
        const excludeSet = new Set(lists.exclude.map((item) => item.toLowerCase()));
        if (!merged.length) {{
          box.innerHTML = `<div class="facet-hint">No matches yet.</div>`;
          count.textContent = "0 visible";
          renderSelectedFacet(kind);
          refreshFilterSummary();
          return;
        }}
        box.innerHTML = "";
        for (const item of merged) {{
          const name = String(item.name || "").trim();
          if (!name) continue;
          const key = name.toLowerCase();
          const state = includeSet.has(key) ? "include" : (excludeSet.has(key) ? "exclude" : "none");
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "filter-pill";
          btn.dataset.state = state;
          btn.innerHTML = `
            <span>${{escapeHtml(name)}}</span>
            ${{item.count !== null && item.count !== undefined ? `<span class="count">${{escapeHtml(item.count)}}</span>` : ""}}
          `;
          btn.addEventListener("click", () => cycleFacet(kind, name));
          box.appendChild(btn);
        }}
        count.textContent = `${{merged.length}} visible`;
        renderSelectedFacet(kind);
        refreshFilterSummary();
      }}

      async function loadFacet(kind) {{
        const box = document.getElementById(`facetBox-${{kind}}`);
        const search = document.getElementById(`facetSearch-${{kind}}`);
        const query = String(search?.value || "").trim();
        const cacheKey = `${{kind}}::${{query.toLowerCase()}}`;
        if (facetCache.has(cacheKey)) {{
          renderFacet(kind, facetCache.get(cacheKey));
          loadedFacets.add(kind);
          updateFacetStatus();
          return;
        }}
        if (box) box.innerHTML = `<div class="facet-hint">Loading...</div>`;
        try {{
          const response = await fetch(`api/filter-candidates?kind=${{encodeURIComponent(kind)}}&q=${{encodeURIComponent(query)}}`);
          const data = await response.json();
          facetCache.set(cacheKey, Array.isArray(data?.items) ? data.items : []);
          loadedFacets.add(kind);
          updateFacetStatus();
          renderFacet(kind, facetCache.get(cacheKey));
        }} catch (error) {{
          if (box) {{
            box.innerHTML = `<div class="facet-hint">Failed to load facet data: ${{escapeHtml(error)}}</div>`;
          }}
        }}
      }}

      function scheduleFacetLoad(kind) {{
        window.clearTimeout(facetTimers[kind]);
        facetTimers[kind] = window.setTimeout(() => loadFacet(kind), 220);
      }}

      function cycleFacet(kind, value) {{
        const lists = facetLists(kind);
        const include = new Set(lists.include);
        const exclude = new Set(lists.exclude);
        if (include.has(value)) {{
          include.delete(value);
          exclude.add(value);
        }} else if (exclude.has(value)) {{
          exclude.delete(value);
        }} else {{
          include.add(value);
        }}
        setFacetLists(kind, Array.from(include), Array.from(exclude));
        renderFacet(kind, facetCache.get(currentFacetCacheKey(kind)) || []);
      }}

      function removeFacetValue(kind, mode, value) {{
        const lists = facetLists(kind);
        const include = lists.include.filter((item) => item.toLowerCase() !== value.toLowerCase());
        const exclude = lists.exclude.filter((item) => item.toLowerCase() !== value.toLowerCase());
        setFacetLists(kind, include, exclude);
        renderFacet(kind, facetCache.get(currentFacetCacheKey(kind)) || []);
      }}

      function addFacetValue(kind) {{
        const input = document.getElementById(`facetCustom-${{kind}}`);
        const value = String(input?.value || "").trim();
        if (!value) return;
        const lists = facetLists(kind);
        setFacetLists(
          kind,
          [...lists.include, value],
          lists.exclude.filter((item) => item.toLowerCase() !== value.toLowerCase()),
        );
        if (input) input.value = "";
        renderFacet(kind, facetCache.get(currentFacetCacheKey(kind)) || []);
      }}

      function clearFacet(kind) {{
        setFacetLists(kind, [], []);
        renderFacet(kind, facetCache.get(currentFacetCacheKey(kind)) || []);
      }}

      function renderCodecPills() {{
        const box = document.getElementById("codecPills");
        if (!box) return;
        const active = new Set(normalizeList(filterState.allowed_codecs || []).map((item) => item.toLowerCase()));
        box.innerHTML = CODEC_OPTIONS.map((codec) => {{
          const on = active.has(codec.toLowerCase());
          return `
            <button
              type="button"
              class="codec-pill"
              data-active="${{on ? "1" : "0"}}"
              style="${{on ? "background: rgba(77, 182, 255, 0.16); border-color: rgba(77, 182, 255, 0.38);" : ""}}"
              onclick="toggleCodec('${{codec}}')"
            >${{escapeHtml(codec)}}</button>
          `;
        }}).join("");
      }}

      function toggleCodec(codec) {{
        const current = normalizeList(filterState.allowed_codecs || []);
        const exists = current.some((item) => item.toLowerCase() === codec.toLowerCase());
        filterState.allowed_codecs = exists
          ? current.filter((item) => item.toLowerCase() !== codec.toLowerCase())
          : [...current, codec];
        renderCodecPills();
        refreshFilterSummary();
      }}

      function syncFilterInputsFromState() {{
        document.getElementById("filterMinBitrate").value = Number(filterState.min_bitrate || 0);
        setInputCsv("filterIncludeKeywords", filterState.include_keywords || []);
        setInputCsv("filterExcludeKeywords", filterState.exclude_keywords || []);
        document.getElementById("filterOnlyWorking").checked = !!filterState.only_working_streams;
        document.getElementById("filterExcludePodcasts").checked = !!filterState.exclude_podcasts;
        document.getElementById("filterExcludeTalk").checked = !!filterState.exclude_talk;
        renderCodecPills();
        refreshFilterSummary();
      }}

      function readFilterInputsIntoState() {{
        filterState.min_bitrate = Number(document.getElementById("filterMinBitrate")?.value || 0);
        filterState.include_keywords = csvFromInput("filterIncludeKeywords");
        filterState.exclude_keywords = csvFromInput("filterExcludeKeywords");
        filterState.only_working_streams = !!document.getElementById("filterOnlyWorking")?.checked;
        filterState.exclude_podcasts = !!document.getElementById("filterExcludePodcasts")?.checked;
        filterState.exclude_talk = !!document.getElementById("filterExcludeTalk")?.checked;
        filterState.allowed_codecs = normalizeList(filterState.allowed_codecs || []);
      }}

      async function saveFilters() {{
        readFilterInputsIntoState();
        const result = document.getElementById("result");
        result.textContent = "Saving filters...";
        const response = await fetch("api/filters", {{
          method: "PUT",
          headers: {{ "Content-Type": "application/json" }},
          body: JSON.stringify(filterState)
        }});
        const data = await response.json();
        if (data.filters) {{
          Object.assign(filterState, data.filters);
          syncFilterInputsFromState();
          for (const kind of Object.keys(FACETS)) {{
            renderFacet(kind, facetCache.get(currentFacetCacheKey(kind)) || []);
          }}
        }}
        result.textContent = JSON.stringify(data, null, 2);
      }}

      function initFiltersUi() {{
        syncFilterInputsFromState();
        for (const id of ["filterMinBitrate", "filterIncludeKeywords", "filterExcludeKeywords"]) {{
          const el = document.getElementById(id);
          if (el) {{
            el.addEventListener("input", () => {{
              readFilterInputsIntoState();
              refreshFilterSummary();
            }});
          }}
        }}
        for (const id of ["filterOnlyWorking", "filterExcludePodcasts", "filterExcludeTalk"]) {{
          const el = document.getElementById(id);
          if (el) {{
            el.addEventListener("change", () => {{
              readFilterInputsIntoState();
              refreshFilterSummary();
            }});
          }}
        }}
        for (const kind of Object.keys(FACETS)) {{
          const search = document.getElementById(`facetSearch-${{kind}}`);
          if (search) {{
            search.addEventListener("input", () => scheduleFacetLoad(kind));
          }}
          loadFacet(kind);
        }}
      }}

      function renderSyncStatus(payload) {{
        const progress = payload?.progress || payload || {{}};
        const running = !!progress.running;
        const done = Number(progress.done || 0);
        const total = Number(progress.total || 0);
        const state = running ? "running" : (progress.phase === "error" ? "error" : (progress.phase === "done" ? "done" : "idle"));
        const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : (running ? 18 : 0);
        document.getElementById("syncState").textContent = state;
        document.getElementById("syncState").parentElement.className = `badge state-${{state}}`;
        document.getElementById("syncPhase").textContent = progress.phase || "idle";
        document.getElementById("syncCount").textContent = `${{done}} / ${{total}}`;
        document.getElementById("syncLabel").textContent = progress.label || "Idle";
        document.getElementById("syncDetail").textContent = progress.detail || "Waiting for next run";
        document.getElementById("syncBar").style.width = `${{pct}}%`;
        const runButton = document.getElementById("runSyncButton");
        runButton.disabled = running;
        runButton.textContent = running ? "Sync Running..." : "Run Sync Now";

        const events = Array.isArray(progress.recent_events) ? progress.recent_events : [];
        const pinnedSummary = [...events].reverse().find((line) => line.includes("Pinned "));
        const validationSummary = [...events].reverse().find((line) => line.includes("Streams validated"));
        document.getElementById("syncPinnedSummary").textContent = pinnedSummary ? pinnedSummary.replace(/^\\[[^\\]]+\\]\\s*/, "") : "No pinned work yet";
        document.getElementById("syncValidationSummary").textContent = validationSummary ? validationSummary.replace(/^\\[[^\\]]+\\]\\s*/, "") : "No validation yet";
        document.getElementById("syncIssueSummary").textContent = `${{(progress.warnings || []).length}} warnings, ${{(progress.errors || []).length}} errors`;

        const lines = [];
        if (events.length) {{
          lines.push(...events.map((line) => {{
            const klass = line.includes("ERROR ") ? "log-line-error" : (line.includes("WARN ") ? "log-line-warn" : "log-line-info");
            return `<span class="${{klass}}">${{escapeHtml(line)}}</span>`;
          }}));
        }}
        if (Array.isArray(progress.warnings) && progress.warnings.length) {{
          lines.push("");
          lines.push(`<span class="log-line-warn">${{escapeHtml("Warnings:")}}</span>`);
          lines.push(...progress.warnings.map((item) => `<span class="log-line-warn">${{escapeHtml(`- ${{item}}`)}}</span>`));
        }}
        if (Array.isArray(progress.errors) && progress.errors.length) {{
          lines.push("");
          lines.push(`<span class="log-line-error">${{escapeHtml("Errors:")}}</span>`);
          lines.push(...progress.errors.map((item) => `<span class="log-line-error">${{escapeHtml(`- ${{item}}`)}}</span>`));
        }}
        document.getElementById("progressLog").innerHTML = lines.length ? lines.join("\\n") : "No sync activity yet.";
        if (!running && payload?.last_report) {{
          document.getElementById("result").textContent = JSON.stringify(payload.last_report, null, 2);
        }}
      }}

      async function refreshSyncStatus() {{
        try {{
          const response = await fetch("api/sync-status");
          const data = await response.json();
          renderSyncStatus(data);
          if (data?.progress?.running) {{
            syncStatusTimer = window.setTimeout(refreshSyncStatus, 900);
          }} else {{
            syncStatusTimer = null;
          }}
        }} catch (error) {{
          document.getElementById("progressLog").textContent = `Failed to load sync status: ${{error}}`;
          syncStatusTimer = null;
        }}
      }}

      function ensureSyncPolling() {{
        if (syncStatusTimer !== null) return;
        refreshSyncStatus();
      }}

      async function runSync() {{
        const result = document.getElementById("result");
        result.textContent = "Starting sync...";
        const response = await fetch("api/sync-now", {{ method: "POST" }});
        const data = await response.json();
        renderSyncStatus(data);
        ensureSyncPolling();
        result.textContent = JSON.stringify(data, null, 2);
      }}

      async function savePinned() {{
        const result = document.getElementById("result");
        result.textContent = "Saving pinned stations...";
        const raw = document.getElementById("pinned").value;
        const parsed = JSON.parse(raw);
        const response = await fetch("api/pinned-stations", {{
          method: "PUT",
          headers: {{ "Content-Type": "application/json" }},
          body: JSON.stringify(parsed)
        }});
        const data = await response.json();
        if (data.pinned_stations) {{
          document.getElementById("pinned").value = JSON.stringify(data.pinned_stations, null, 2);
        }}
        result.textContent = JSON.stringify(data, null, 2);
      }}

      renderLastCompletedSync();
      initFiltersUi();
      renderSyncStatus({{"progress": {progress_json}}});
      ensureSyncPolling();
    </script>
  </body>
</html>
"""


@app.get("/api/options")
async def get_options():
    return OPTIONS.model_dump(mode="json")


@app.get("/api/filters")
async def get_filters():
    return _current_filters()


@app.put("/api/filters")
async def put_filters(payload: dict):
    saved = _save_filters(payload)
    return {"saved": True, "filters": saved}


@app.get("/api/filter-candidates")
async def get_filter_candidates(kind: str, q: str = ""):
    items = await _load_filter_facet(kind, q)
    return {"kind": kind, "query": q, "items": items}


@app.get("/api/report")
async def get_report():
    report = SERVICE.last_report
    if not report:
        raise HTTPException(status_code=404, detail="No sync report available yet.")
    return report.model_dump(mode="json")


@app.get("/api/stations")
async def get_stations():
    report = SERVICE.last_report
    return [] if not report else [station.model_dump(mode="json") for station in report.stations]


@app.get("/api/sync-status")
async def get_sync_status():
    return {
        "progress": SERVICE.progress.model_dump(mode="json"),
        "last_report": None if not SERVICE.last_report else SERVICE.last_report.summary.model_dump(mode="json"),
    }


@app.get("/api/pinned-stations")
async def get_pinned_stations():
    return _shared_pinned_stations()


@app.put("/api/pinned-stations")
async def put_pinned_stations(payload: list[dict]):
    validated = PINNED_ADAPTER.validate_python(payload)
    serializable = [item.model_dump(mode="json") for item in validated]
    _save_shared_pinned_stations(serializable)
    return {"saved": len(serializable), "pinned_stations": serializable}


@app.post("/api/sync-now")
async def sync_now():
    started = await SERVICE.start_background_sync(mode="manual")
    return {
        "started": started,
        "progress": SERVICE.progress.model_dump(mode="json"),
        "last_report": None if not SERVICE.last_report else SERVICE.last_report.summary.model_dump(mode="json"),
    }


@app.get("/downloads/stations.zip")
async def download_latest_zip():
    target = EXPORTS_DIR / "stations.zip"
    if not target.exists():
        raise HTTPException(status_code=404, detail="Bundle not generated yet.")
    return FileResponse(target, media_type="application/zip", filename="stations.zip")


def run() -> None:
    uvicorn.run(app, host="0.0.0.0", port=runtime_port(OPTIONS))
