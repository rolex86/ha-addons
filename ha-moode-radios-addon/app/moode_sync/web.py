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
    return f"""
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>moOde Radios Sync</title>
    <style>
      :root {{
        --bg: #f4efe7;
        --card: #fffaf3;
        --ink: #1e1d19;
        --muted: #655f55;
        --accent: #006d77;
        --line: #e7dcca;
      }}
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(217, 119, 6, 0.18), transparent 28%),
          linear-gradient(180deg, #f8f3ea, var(--bg));
      }}
      main {{ max-width: 1100px; margin: 0 auto; padding: 32px 20px 56px; }}
      .hero {{
        padding: 28px;
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--card);
        box-shadow: 0 18px 40px rgba(30, 29, 25, 0.08);
      }}
      h1 {{ margin: 0 0 10px; font-size: clamp(2.2rem, 4vw, 4rem); }}
      p {{ color: var(--muted); line-height: 1.55; }}
      .actions {{ display: flex; flex-wrap: wrap; gap: 12px; margin-top: 18px; }}
      button, a {{
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        text-decoration: none;
        font: inherit;
      }}
      button {{
        background: var(--accent);
        color: white;
        cursor: pointer;
      }}
      a {{
        background: #efe5d4;
        color: var(--ink);
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
        background: rgba(255,255,255,0.7);
        padding: 18px;
      }}
      textarea, pre {{
        width: 100%;
        min-height: 280px;
        white-space: pre-wrap;
        word-break: break-word;
        background: #1e1d19;
        color: #f7efe1;
        padding: 18px;
        border-radius: 18px;
        border: none;
        margin-top: 20px;
        font-family: "SFMono-Regular", Consolas, monospace;
      }}
      .section-title {{ margin-top: 26px; margin-bottom: 8px; font-size: 1.2rem; }}
      .section-note {{ margin-top: 8px; color: var(--muted); font-size: 0.95rem; }}
      .secondary {{ background: #efe5d4; color: #1e1d19; }}
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
          <button onclick="runSync()">Run Sync Now</button>
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
        <div class="section-title">Result</div>
        <pre id="result">Ready.</pre>
      </section>
    </main>
    <script>
      async function runSync() {{
        const result = document.getElementById("result");
        result.textContent = "Running sync...";
        const response = await fetch("api/sync-now", {{ method: "POST" }});
        const data = await response.json();
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
        result.textContent = JSON.stringify(data, null, 2);
      }}
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


@app.get("/api/pinned-stations")
async def get_pinned_stations():
    return _shared_pinned_stations()


@app.put("/api/pinned-stations")
async def put_pinned_stations(payload: list[dict]):
    validated = PINNED_ADAPTER.validate_python(payload)
    serializable = [item.model_dump(mode="json") for item in validated]
    _save_shared_pinned_stations(serializable)
    return {"saved": len(serializable)}


@app.post("/api/sync-now")
async def sync_now():
    report = await SERVICE.run_sync(mode="manual")
    return report.model_dump(mode="json")


@app.get("/downloads/stations.zip")
async def download_latest_zip():
    target = EXPORTS_DIR / "stations.zip"
    if not target.exists():
        raise HTTPException(status_code=404, detail="Bundle not generated yet.")
    return FileResponse(target, media_type="application/zip", filename="stations.zip")


def run() -> None:
    uvicorn.run(app, host="0.0.0.0", port=runtime_port(OPTIONS))
