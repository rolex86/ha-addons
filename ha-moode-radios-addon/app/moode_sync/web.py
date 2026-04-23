from __future__ import annotations

import asyncio
import contextlib
import json
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import TypeAdapter

from .config import PinnedStationInput, load_options, runtime_port, save_pinned_stations_to_options
from .logging_utils import configure_logging
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


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    report = SERVICE.last_report
    station_count = report.summary.station_count if report else 0
    last_run = report.summary.finished_at.isoformat() if report and report.summary.finished_at else "never"
    pinned_json = json.dumps(_shared_pinned_stations(), indent=2)
    pinned_count = len(_shared_pinned_stations())
    progress_json = json.dumps(SERVICE.progress.model_dump(mode="json"), indent=2)
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
          <button onclick="savePinned()">Save pinned stations</button>
          <button id="runSyncButton" onclick="runSync()">Run Sync Now</button>
          <a href="downloads/stations.zip">Download Latest ZIP</a>
          <a href="api/report">Open JSON Report</a>
        </div>
        <div class="grid">
          <div class="card"><div>Stations in last run</div><div style="font-size:1.5rem;margin-top:8px">{station_count}</div></div>
          <div class="card"><div>Last completed sync</div><div style="font-size:1rem;margin-top:8px">{last_run}</div></div>
          <div class="card"><div>Dry run</div><div style="font-size:1.5rem;margin-top:8px">{str(OPTIONS.dry_run).lower()}</div></div>
          <div class="card"><div>Pinned stations</div><div style="font-size:1.5rem;margin-top:8px">{pinned_count}</div></div>
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

      function escapeHtml(value) {{
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
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

      renderSyncStatus({{"progress": {progress_json}}});
      ensureSyncPolling();
    </script>
  </body>
</html>
"""


@app.get("/api/options")
async def get_options():
    return OPTIONS.model_dump(mode="json")


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
