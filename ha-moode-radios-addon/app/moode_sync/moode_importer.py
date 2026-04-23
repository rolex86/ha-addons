from __future__ import annotations

import json
import logging
from pathlib import Path

import asyncssh

from .config import MoodeConfig
from .models import Station


LOGGER = logging.getLogger(__name__)


REMOTE_SCRIPT = r"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

catalog_path = Path(sys.argv[1])
asset_root = catalog_path.parent
policy = sys.argv[2]
managed_marker = "managed-by=ha-moode-radios-addon"

with catalog_path.open("r", encoding="utf-8") as handle:
    payload = json.load(handle)

stations = payload["stations"]

radio_candidates = [
    Path("/var/lib/mpd/music/RADIO"),
    Path("/var/www/mpdmusic/RADIO"),
]
logo_candidates = [
    Path("/var/local/www/imagesw"),
    Path("/var/www/images/radio-logos"),
]
db_candidates = [
    Path("/var/local/www/db/moode-sqlite3.db"),
    Path("/var/www/db/player.db"),
]
manifest_candidates = [
    Path("/var/local/www/db/ha-moode-radios-managed.json"),
    Path("/var/tmp/ha-moode-radios-managed.json"),
]

radio_dir = next((path for path in radio_candidates if path.exists()), radio_candidates[0])
logo_dir = next((path for path in logo_candidates if path.exists()), logo_candidates[0])
db_path = next((path for path in db_candidates if path.exists()), db_candidates[0])
manifest_path = next((path for path in manifest_candidates if path.parent.exists()), manifest_candidates[-1])

radio_dir.mkdir(parents=True, exist_ok=True)
logo_dir.mkdir(parents=True, exist_ok=True)
manifest_path.parent.mkdir(parents=True, exist_ok=True)

managed_before = []
if manifest_path.exists():
    try:
        managed_before = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        managed_before = []

incoming_names = {station["display_name"] for station in stations}
incoming_files = {station["file_basename"] for station in stations}

if policy == "replace":
    for item in managed_before:
        path = radio_dir / f"{item['file_basename']}.pls"
        if path.exists():
            path.unlink()
        logo = logo_dir / f"{item['file_basename']}.jpg"
        if logo.exists():
            logo.unlink()

conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row
cursor = conn.cursor()
cursor.execute("CREATE TABLE IF NOT EXISTS cfg_radio (id INTEGER PRIMARY KEY, station CHAR(128), name CHAR(128), permalink CHAR(128), logo CHAR(128))")
columns = [row[1] for row in cursor.execute("PRAGMA table_info(cfg_radio)").fetchall()]

if policy == "replace":
    for item in managed_before:
        cursor.execute("DELETE FROM cfg_radio WHERE name = ? OR station = ?", (item["display_name"], item["display_name"]))

max_id = cursor.execute("SELECT COALESCE(MAX(id), 0) FROM cfg_radio").fetchone()[0]

for station in stations:
    basename = station["file_basename"]
    display_name = station["display_name"]
    stream_url = station.get("stream_url_resolved") or station.get("stream_url_raw") or ""
    if not stream_url:
        continue

    pls_text = "\n".join([
        "[playlist]",
        "NumberOfEntries=1",
        f"File1={stream_url}",
        f"Title1={display_name}",
        "Length1=-1",
        "Version=2",
        f"; {managed_marker}",
        "",
    ])
    (radio_dir / f"{basename}.pls").write_text(pls_text, encoding="utf-8")

    logo_flag = station.get("logo_url") or ""
    local_candidate = asset_root / f"{basename}.jpg"
    if local_candidate.exists():
        src_logo = local_candidate
        if src_logo.exists():
            shutil.copyfile(src_logo, logo_dir / f"{basename}.jpg")
            logo_flag = "local"

    existing = cursor.execute(
        "SELECT id FROM cfg_radio WHERE lower(name) = lower(?) OR lower(station) = lower(?)",
        (display_name, display_name),
    ).fetchone()

    if existing:
        values = {
            "station": display_name,
            "name": display_name,
            "permalink": station.get("homepage") or station.get("station_page_url") or "",
            "logo": logo_flag,
        }
        set_clause = ", ".join(f"{column} = ?" for column in values if column in columns)
        params = [values[column] for column in values if column in columns] + [existing["id"]]
        cursor.execute(f"UPDATE cfg_radio SET {set_clause} WHERE id = ?", params)
    else:
        max_id += 1
        values = {
            "id": max_id,
            "station": display_name,
            "name": display_name,
            "permalink": station.get("homepage") or station.get("station_page_url") or "",
            "logo": logo_flag,
        }
        insert_columns = [column for column in values if column in columns]
        insert_values = [values[column] for column in insert_columns]
        placeholders = ", ".join(["?"] * len(insert_columns))
        cursor.execute(
            f"INSERT INTO cfg_radio ({', '.join(insert_columns)}) VALUES ({placeholders})",
            insert_values,
        )

conn.commit()
conn.close()

manifest_path.write_text(
    json.dumps(
        [{"display_name": station["display_name"], "file_basename": station["file_basename"]} for station in stations],
        indent=2,
    ),
    encoding="utf-8",
)

for command in [["mpc", "update"], ["systemctl", "restart", "mpd"]]:
    try:
        subprocess.run(command, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception:
        pass

print(json.dumps({
    "radio_dir": str(radio_dir),
    "logo_dir": str(logo_dir),
    "db_path": str(db_path),
    "station_count": len(stations),
}))
"""


async def push_catalog(stations: list[Station], moode: MoodeConfig) -> bool:
    if not moode.enabled or not moode.host:
        LOGGER.info("Skipping moOde push because integration is disabled.")
        return False

    remote_root = moode.remote_import_path.rstrip("/")
    catalog_payload = {"stations": [station.model_dump(mode="json") for station in stations]}

    async with asyncssh.connect(
        moode.host,
        port=moode.port,
        username=moode.username,
        password=moode.password or None,
        known_hosts=None,
    ) as connection:
        await connection.run(f"mkdir -p {remote_root}", check=False)
        async with connection.start_sftp_client() as sftp:
            await _write_remote_text(sftp, f"{remote_root}/catalog.json", json.dumps(catalog_payload))
            await _write_remote_text(sftp, f"{remote_root}/import_catalog.py", REMOTE_SCRIPT)
            for station in stations:
                if station.logo_path:
                    local_logo = Path(station.logo_path)
                    if local_logo.exists():
                        await sftp.put(str(local_logo), f"{remote_root}/{station.file_basename}.jpg")

        result = await connection.run(
            f"python3 {remote_root}/import_catalog.py {remote_root}/catalog.json {moode.import_policy}",
            check=False,
        )
        if result.stdout:
            LOGGER.info("moOde import stdout: %s", result.stdout.strip())
        if result.stderr:
            LOGGER.warning("moOde import stderr: %s", result.stderr.strip())
        return result.exit_status == 0


async def _write_remote_text(sftp: asyncssh.SFTPClient, path: str, content: str) -> None:
    async with sftp.open(path, "w") as remote:
        await remote.write(content)
