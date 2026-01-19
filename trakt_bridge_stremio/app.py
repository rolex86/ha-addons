import asyncio
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import httpx
import websockets
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse

app = FastAPI()

DATA_DIR = Path("/data")
TOKENS_FILE = DATA_DIR / "trakt_tokens.json"
SENT_FILE = DATA_DIR / "sent_keys.json"
DEVICE_FLOW_FILE = DATA_DIR / "device_flow.json"

TRAKT_CLIENT_ID = os.getenv("TRAKT_CLIENT_ID", "")
TRAKT_CLIENT_SECRET = os.getenv("TRAKT_CLIENT_SECRET", "")
HA_TOKEN = os.getenv("HA_TOKEN", "")

WATCHED_THRESHOLD = float(os.getenv("WATCHED_THRESHOLD", "0.85"))
MIN_DURATION_SECONDS = int(os.getenv("MIN_DURATION_SECONDS", "600"))
ENTITIES = set(json.loads(os.getenv("ENTITIES_JSON", "[]")))

TRAKT_API = "https://api.trakt.tv"
TRAKT_OAUTH = "https://api.trakt.tv/oauth"

HA_WS_URL = "ws://homeassistant:8123/api/websocket"

IMDB_RE = re.compile(r"(tt\d{7,8})")
EP_RE = re.compile(r"S(\d{1,2})E(\d{1,2})", re.IGNORECASE)


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def trakt_headers(access_token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": TRAKT_CLIENT_ID,
    }


def parse_imdb(entity_picture: str) -> Optional[str]:
    if not entity_picture:
        return None
    m = IMDB_RE.search(entity_picture)
    return m.group(1) if m else None


def parse_episode(media_title: str) -> Optional[Tuple[int, int]]:
    if not media_title:
        return None
    m = EP_RE.search(media_title)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def is_stremio(attrs: Dict[str, Any]) -> bool:
    return (attrs.get("app_name") or "") == "Stremio"


def is_authorized_trakt() -> bool:
    tokens = load_json(TOKENS_FILE, None)
    return bool(tokens and tokens.get("access_token"))


async def trakt_add_to_history(access_token: str, body: Dict[str, Any]) -> None:
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            f"{TRAKT_API}/sync/history",
            headers=trakt_headers(access_token),
            json=body,
        )
        if r.status_code not in (200, 201):
            raise RuntimeError(f"Trakt error {r.status_code}: {r.text}")


async def handle_stop(entity_id: str, attrs: Dict[str, Any]) -> None:
    """
    Fail-safe: watched rozhodujeme VYLUCNE z realnych hodnot, ktere poslal HA v old_state.
    Tím pádem se nemůže stát, že by se použil "starej" progress z minulého přehrávání.
    """
    title = (attrs.get("media_title") or "").strip()
    duration = float(attrs.get("media_duration") or 0.0)
    pos = float(attrs.get("media_position") or 0.0)

    if duration <= 0 or duration < MIN_DURATION_SECONDS:
        return

    imdb = parse_imdb(attrs.get("entity_picture") or "")
    if not imdb:
        return

    ep = parse_episode(title)
    season = episode = None
    if ep:
        season, episode = ep

    progress = pos / duration
    if progress < WATCHED_THRESHOLD:
        return

    if season is not None and episode is not None:
        key = f"{imdb}:S{season:02d}E{episode:02d}"
        body = {
            "shows": [
                {
                    "ids": {"imdb": imdb},
                    "seasons": [{"number": season, "episodes": [{"number": episode}]}],
                }
            ]
        }
        kind = "episode"
    else:
        key = imdb
        body = {"movies": [{"ids": {"imdb": imdb}}]}
        kind = "movie"

    sent = load_json(SENT_FILE, {})
    if key in sent:
        return

    tokens = load_json(TOKENS_FILE, None)
    access_token = (tokens or {}).get("access_token")
    if not access_token:
        return

    try:
        await trakt_add_to_history(access_token, body)
    except Exception as e:
        print(f"[trakt] failed: {e}")
        return

    sent[key] = {
        "title": title,
        "imdb": imdb,
        "season": season,
        "episode": episode,
        "progress_percent": round(progress * 100, 1),
        "pos": round(pos, 2),
        "duration": round(duration, 2),
        "entity_id": entity_id,
    }
    save_json(SENT_FILE, sent)

    print(f"[trakt] SENT {kind}: {key} progress={round(progress*100,1)}% title='{title}'")


async def ha_ws_once_failfast():
    if not HA_TOKEN:
        print("[ha] HA_TOKEN missing; exiting (fail-fast).")
        sys.exit(1)

    try:
        async with websockets.connect(HA_WS_URL, ping_interval=30, ping_timeout=30) as ws:
            hello = json.loads(await ws.recv())
            if hello.get("type") != "auth_required":
                print(f"[ha] unexpected hello: {hello}. Exiting (fail-fast).")
                sys.exit(1)

            await ws.send(json.dumps({"type": "auth", "access_token": HA_TOKEN}))
            auth_resp = json.loads(await ws.recv())
            if auth_resp.get("type") != "auth_ok":
                print(f"[ha] auth failed: {auth_resp}. Exiting (fail-fast).")
                sys.exit(1)

            await ws.send(json.dumps({"id": 1, "type": "subscribe_events", "event_type": "state_changed"}))
            sub_resp = json.loads(await ws.recv())
            if sub_resp.get("type") != "result" or not sub_resp.get("success", False):
                print(f"[ha] subscribe failed: {sub_resp}. Exiting (fail-fast).")
                sys.exit(1)

            print(f"[ha] subscribed. Watching entities: {sorted(ENTITIES)} (Stremio only)")

            async for msg in ws:
                data = json.loads(msg)
                if data.get("type") != "event":
                    continue

                event = data.get("event", {})
                if event.get("event_type") != "state_changed":
                    continue

                ev = event.get("data", {})
                entity_id = ev.get("entity_id")
                if not entity_id or entity_id not in ENTITIES:
                    continue

                new_state = ev.get("new_state")
                old_state = ev.get("old_state")
                if not new_state or not old_state:
                    continue

                new_s = new_state.get("state")
                old_s = old_state.get("state")
                new_attrs = new_state.get("attributes") or {}
                old_attrs = old_state.get("attributes") or {}

                # filter only Stremio
                if not is_stremio(new_attrs) and not is_stremio(old_attrs):
                    continue

                # watched decision on transition FROM playing -> anything else
                if old_s == "playing" and new_s != "playing":
                    await handle_stop(entity_id, old_attrs)

    except Exception as e:
        print(f"[ha] websocket error: {e}. Exiting (fail-fast).")
        sys.exit(1)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(ha_ws_once_failfast())


@app.get("/health")
def health():
    return {
        "ok": True,
        "authorized_trakt": is_authorized_trakt(),
        "entities": sorted(ENTITIES),
        "watched_threshold": WATCHED_THRESHOLD,
        "min_duration_seconds": MIN_DURATION_SECONDS,
        "ws_url": HA_WS_URL,
        "trakt_oauth": TRAKT_OAUTH,
    }


@app.get("/status")
def status():
    sent = load_json(SENT_FILE, {})
    return {
        "authorized_trakt": is_authorized_trakt(),
        "sent_count": len(sent),
        "watching_entities": sorted(ENTITIES),
    }


@app.get("/", response_class=HTMLResponse)
def index():
    return """
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Trakt Bridge - Stremio</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 860px; margin: 24px auto; padding: 0 16px; }
    .row { display:flex; gap:12px; flex-wrap:wrap; }
    .card { border: 1px solid #e6e6e6; border-radius: 12px; padding: 16px; margin: 12px 0; }
    button { padding: 10px 14px; border-radius: 10px; border: 1px solid #ccc; cursor: pointer; background:#fff; }
    button:hover { background:#f6f6f6; }
    pre { background: #f6f6f6; padding: 12px; border-radius: 10px; overflow: auto; }
    .pill { display:inline-block; padding: 6px 10px; border-radius: 999px; border:1px solid #ddd; font-weight:600; }
    .ok { background:#e9fbe9; border-color:#bfe8bf; }
    .bad { background:#ffecec; border-color:#f3baba; }
    code { background:#f3f3f3; padding:2px 6px; border-radius:6px; }
  </style>
</head>
<body>
  <h2>Trakt Bridge (Stremio only)</h2>

  <div class="card">
    <div class="row" style="align-items:center; justify-content:space-between;">
      <div>
        <div><strong>Trakt Status</strong></div>
        <div style="margin-top:6px;">
          <span id="authPill" class="pill">Loading…</span>
          <span class="pill" id="sentPill">Sent: ?</span>
        </div>
      </div>
      <div>
        <button onclick="refreshStatus()">Refresh</button>
      </div>
    </div>
    <pre id="statusOut"></pre>
  </div>

  <div class="card">
    <p><strong>1) Start pairing</strong> (vygeneruje kód a odkaz)</p>
    <button onclick="startPairing()">Start pairing</button>
    <pre id="startOut"></pre>
  </div>

  <div class="card">
    <p><strong>2) Potvrď v Traktu</strong> přes <code>verification_url</code> a <code>user_code</code></p>
    <p><strong>3) Finish pairing</strong> (uloží tokeny do <code>/data</code>)</p>
    <button onclick="finishPairing()">Finish pairing</button>
    <pre id="pollOut"></pre>
  </div>

<script>
function setPill(el, ok, text){
  el.textContent = text;
  el.classList.remove('ok','bad');
  el.classList.add(ok ? 'ok' : 'bad');
}

async function refreshStatus(){
  const r = await fetch('/status');
  const t = await r.text();
  document.getElementById('statusOut').textContent = t;

  try {
    const j = JSON.parse(t);
    setPill(document.getElementById('authPill'), !!j.authorized_trakt, j.authorized_trakt ? 'AUTHORIZED' : 'NOT AUTHORIZED');
    document.getElementById('sentPill').textContent = 'Sent: ' + (j.sent_count ?? '?');
  } catch(e) {
    setPill(document.getElementById('authPill'), false, 'UNKNOWN');
  }
}

async function startPairing(){
  const r = await fetch('/auth/device/start', { method: 'POST' });
  const t = await r.text();
  document.getElementById('startOut').textContent = t;
}

async function finishPairing(){
  const r = await fetch('/auth/device/poll', { method: 'POST' });
  const t = await r.text();
  document.getElementById('pollOut').textContent = t;
  await refreshStatus();
}

refreshStatus();
</script>
</body>
</html>
"""


@app.post("/auth/device/start")
async def auth_device_start():
    if not TRAKT_CLIENT_ID:
        raise HTTPException(400, "Missing TRAKT_CLIENT_ID (vyplň v konfiguraci add-onu)")

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            f"{TRAKT_OAUTH}/device/code",
            json={"client_id": TRAKT_CLIENT_ID},
            headers={"Content-Type": "application/json"},
        )

        if r.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"Trakt device/code failed: {r.status_code} {r.text}",
            )

        data = r.json()
        save_json(DEVICE_FLOW_FILE, data)
        return {
            "user_code": data.get("user_code"),
            "verification_url": data.get("verification_url"),
            "expires_in": data.get("expires_in"),
            "interval": data.get("interval"),
        }


@app.post("/auth/device/poll")
async def auth_device_poll():
    if not (TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET):
        raise HTTPException(400, "Missing TRAKT_CLIENT_ID or TRAKT_CLIENT_SECRET (vyplň v konfiguraci add-onu)")

    flow = load_json(DEVICE_FLOW_FILE, None)
    if not flow:
        raise HTTPException(400, "Device flow not started. Call /auth/device/start first.")

    payload = {
        "code": flow["device_code"],
        "client_id": TRAKT_CLIENT_ID,
        "client_secret": TRAKT_CLIENT_SECRET,
    }

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            f"{TRAKT_OAUTH}/device/token",
            json=payload,
            headers={"Content-Type": "application/json"},
        )

        if r.status_code == 200:
            tokens = r.json()
            save_json(TOKENS_FILE, tokens)
            return {"ok": True, "message": "Authorized. Tokens saved to /data."}

        return {"ok": False, "status_code": r.status_code, "body": r.text}
