from __future__ import annotations

import html
import json
import logging
import time
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import requests

LOG = logging.getLogger("cez_pnd_fetcher")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

CAS_BASE_URL = "https://cas.cez.cz/cas"
CEZ_BASE_URL = "https://dip.cezdistribuce.cz/irj/portal"
PND_BASE_URL = "https://pnd.cezdistribuce.cz/cezpnd2"
CEZ_CLIENT_ID = "fjR3ZL9zrtsNcDQF.onpremise.dip.sap.dipcezdistribucecz.prod"
CLIENT_NAME = "CasOAuthClient"
RESPONSE_TYPE = "code"
SCOPE = "openid"
TIMEOUT = 30

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "application/json,text/plain,*/*;q=0.8"
    ),
    "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
}

WARMUP_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://pnd.cezdistribuce.cz/",
}

DATA_HEADERS = {
    "Origin": "https://pnd.cezdistribuce.cz",
    "Referer": "https://pnd.cezdistribuce.cz/cezpnd2/external/dashboard/view",
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
}

ADDON_HA_CONFIG_DIR = Path("/homeassistant")
LEGACY_HA_CONFIG_DIR = Path("/config")
HA_VISIBLE_CONFIG_DIR = Path("/config")
VALID_PND_STATUS = "naměřená data OK"
PND_INTERVAL_HOURS = 0.25


@dataclass(frozen=True)
class ExportAssessment:
    has_data_flag: Any
    series_count: int | None
    usable_measurements_count: int
    is_usable: bool
    reason: str


class LoginFormParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.forms: list[dict[str, Any]] = []
        self.current_form: dict[str, Any] | None = None
        self.global_inputs: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs_list: list[tuple[str, str | None]]) -> None:
        attrs = {key: value or "" for key, value in attrs_list}
        if tag.lower() == "form":
            self.current_form = {"action": attrs.get("action") or "", "inputs": {}}
            return
        if tag.lower() != "input":
            return
        name = attrs.get("name")
        if not name:
            return
        value = attrs.get("value") or ""
        if self.current_form is not None:
            self.current_form["inputs"][name] = value
        else:
            self.global_inputs[name] = value

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "form" and self.current_form is not None:
            self.forms.append(self.current_form)
            self.current_form = None


def current_month_interval() -> tuple[str, str]:
    now = datetime.now()
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if start.month == 12:
        end = start.replace(year=start.year + 1, month=1)
    else:
        end = start.replace(month=start.month + 1)
    return start.strftime("%d.%m.%Y %H:%M"), end.strftime("%d.%m.%Y %H:%M")


def parse_pnd_datetime(value: str) -> datetime:
    date_part, time_part = str(value).strip().split(" ")
    if time_part == "24:00":
        day = datetime.strptime(date_part, "%d.%m.%Y")
        return day + timedelta(days=1)
    return datetime.strptime(str(value).strip(), "%d.%m.%Y %H:%M")


def parse_pnd_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        timestamp = float(value)
        if abs(timestamp) >= 1_000_000_000_000:
            timestamp /= 1000
        return datetime.fromtimestamp(timestamp)
    text = str(value).strip()
    if not text:
        raise ValueError("Empty PND timestamp")
    if text.isdigit():
        return parse_pnd_timestamp(int(text))
    try:
        return parse_pnd_datetime(text)
    except ValueError:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))


def parse_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value).strip().replace(",", "."))
    except (InvalidOperation, ValueError):
        return None


def sanitize_url(value: str | None) -> str | None:
    if not value:
        return value
    parsed = urllib.parse.urlparse(value)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    masked = []
    for key, val in query:
        masked.append((key, "***" if key.lower() in {"code", "ticket", "state", "nonce"} else val))
    return urllib.parse.urlunparse(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            urllib.parse.urlencode(masked),
            parsed.fragment,
        )
    )


def safe_headers(headers: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    for key, value in dict(headers or {}).items():
        lowered = str(key).lower()
        if lowered in {"cookie", "authorization", "set-cookie", "x-request-token"}:
            result[str(key)] = "***"
        else:
            result[str(key)] = str(value)
    return result


def parse_login_form(html_text: str, login_url: str, username: str, password: str) -> tuple[str, dict[str, str]]:
    parser = LoginFormParser()
    parser.feed(html_text)
    selected_form: dict[str, Any] | None = None
    for form in parser.forms:
        inputs = form.get("inputs") or {}
        if "execution" in inputs:
            selected_form = form
            break
    if selected_form is None:
        if "execution" in parser.global_inputs:
            selected_form = {"action": login_url, "inputs": parser.global_inputs}
        else:
            raise RuntimeError("CAS login form does not contain execution token")
    action = html.unescape(str(selected_form.get("action") or login_url))
    form_action = urllib.parse.urljoin(login_url, action)
    payload = dict(selected_form.get("inputs") or {})
    payload.update(
        {
            "username": username,
            "password": password,
            "_eventId": "submit",
            "geolocation": payload.get("geolocation", ""),
        }
    )
    return form_action, payload


def extract_token(payload: Any) -> str | None:
    if isinstance(payload, str):
        token = payload.strip()
        return token or None
    if isinstance(payload, dict):
        for key in ("data", "token", "requestToken", "xRequestToken", "X-Request-Token", "xsrfToken", "csrfToken"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, dict):
                nested = extract_token(value)
                if nested:
                    return nested
        for value in payload.values():
            if isinstance(value, dict):
                nested = extract_token(value)
                if nested:
                    return nested
    return None


def safe_key(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in value).strip("_") or "unknown"


def looks_like_homeassistant_config_dir(path: Path) -> bool:
    return path.is_dir() and (
        (path / "configuration.yaml").is_file() or (path / ".storage").is_dir()
    )


def resolve_homeassistant_config_dir() -> Path:
    if looks_like_homeassistant_config_dir(ADDON_HA_CONFIG_DIR):
        return ADDON_HA_CONFIG_DIR
    if looks_like_homeassistant_config_dir(LEGACY_HA_CONFIG_DIR):
        LOG.warning("Falling back to legacy Home Assistant config mount at: %s", LEGACY_HA_CONFIG_DIR)
        return LEGACY_HA_CONFIG_DIR
    raise RuntimeError(
        "Home Assistant config directory is not mounted. "
        "Expected `map: type: homeassistant_config` to expose the host config at /homeassistant."
    )


def to_homeassistant_visible_path(path: Path, homeassistant_config_dir: Path) -> Path:
    try:
        relative = path.relative_to(homeassistant_config_dir)
    except ValueError:
        return path
    return HA_VISIBLE_CONFIG_DIR / relative


def write_json(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def copy_file(source: Path, target: Path) -> None:
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(source.read_bytes())
    tmp.replace(target)


def dump_response(debug_dir: Path, kind: str, response: requests.Response, payload: dict[str, Any] | None = None) -> None:
    debug_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    base = debug_dir / f"{stamp}_{kind}"
    content_type = response.headers.get("content-type", "")
    if "html" in content_type.lower():
        body_path = base.with_suffix(".html")
    elif "json" in content_type.lower():
        body_path = base.with_suffix(".response.json")
    else:
        body_path = base.with_suffix(".txt")
    body_path.write_bytes(response.content)
    meta = {
        "captured_at": datetime.now().isoformat(),
        "kind": kind,
        "status_code": response.status_code,
        "final_url": sanitize_url(response.url),
        "content_type": content_type,
        "redirect_history": [
            {
                "status_code": item.status_code,
                "url": sanitize_url(item.url),
                "location": sanitize_url(item.headers.get("location")),
            }
            for item in response.history
        ],
        "request": {
            "method": response.request.method if response.request else None,
            "url": sanitize_url(response.request.url) if response.request else None,
            "headers": safe_headers(response.request.headers) if response.request else {},
        },
        "response_headers": safe_headers(response.headers),
        "body_preview": response.text[:3000],
        "payload": payload,
        "body_path": str(body_path),
    }
    meta_path = base.with_suffix(".json")
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    LOG.warning("saved debug meta: %s", meta_path)
    LOG.warning("saved response body: %s", body_path)


def load_options() -> dict[str, Any]:
    options_path = Path("/data/options.json")
    data = json.loads(options_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError("Invalid add-on options.json")
    return data


def count_usable_measurements(payload: dict[str, Any]) -> int:
    series = payload.get("series")
    if not isinstance(series, list):
        return 0

    count = 0
    seen: set[tuple[str, str, str | None]] = set()
    interval_duration = timedelta(hours=PND_INTERVAL_HOURS)
    for series_item in series:
        if not isinstance(series_item, dict):
            continue

        series_name = (
            str(series_item.get("name")).strip()
            if series_item.get("name") is not None
            else None
        )
        data_points = series_item.get("data")
        if not isinstance(data_points, list):
            continue

        for point in data_points:
            if not isinstance(point, (list, tuple)) or len(point) < 3:
                continue

            status = str(point[2]).strip() if point[2] is not None else ""
            if status != VALID_PND_STATUS:
                continue

            try:
                end_time = parse_pnd_timestamp(point[0])
            except (TypeError, ValueError):
                continue

            kw = parse_decimal(point[1])
            if kw is None:
                continue

            start_time = end_time - interval_duration
            signature = (start_time.isoformat(), end_time.isoformat(), series_name)
            if signature in seen:
                continue
            seen.add(signature)
            count += 1

    return count


def assess_export_payload(payload: dict[str, Any]) -> ExportAssessment:
    series = payload.get("series")
    series_count = len(series) if isinstance(series, list) else None
    has_data_flag = payload.get("hasData")
    usable_measurements_count = count_usable_measurements(payload)

    if has_data_flag is False:
        return ExportAssessment(
            has_data_flag=has_data_flag,
            series_count=series_count,
            usable_measurements_count=usable_measurements_count,
            is_usable=False,
            reason="payload.hasData is false",
        )
    if series_count == 0:
        return ExportAssessment(
            has_data_flag=has_data_flag,
            series_count=series_count,
            usable_measurements_count=usable_measurements_count,
            is_usable=False,
            reason="payload.series is empty",
        )
    if usable_measurements_count <= 0:
        return ExportAssessment(
            has_data_flag=has_data_flag,
            series_count=series_count,
            usable_measurements_count=usable_measurements_count,
            is_usable=False,
            reason="payload contains no usable measurements",
        )
    return ExportAssessment(
        has_data_flag=has_data_flag,
        series_count=series_count,
        usable_measurements_count=usable_measurements_count,
        is_usable=True,
        reason="payload contains usable measurements",
    )


def save_diagnostic_export(path: Path, export: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, export)


def ensure_main_export_from_backup(
    export_path: Path,
    backup_path: Path,
    homeassistant_config_dir: Path,
) -> bool:
    if export_path.exists():
        return False
    if not backup_path.exists():
        return False
    export_path.parent.mkdir(parents=True, exist_ok=True)
    copy_file(backup_path, export_path)
    LOG.warning("Main PND export restored from last good backup: %s", export_path)
    LOG.warning(
        "Restored export is visible in Home Assistant at: %s",
        to_homeassistant_visible_path(export_path, homeassistant_config_dir),
    )
    return True


def fetch_once(options: dict[str, Any]) -> None:
    username = str(options.get("username") or "").strip()
    password = str(options.get("password") or "").strip()
    device_set_id = str(options.get("device_set_id") or "").strip()
    id_assembly = int(options.get("id_assembly") or -1001)
    debug_dump = bool(options.get("debug_dump", True))
    homeassistant_config_dir = resolve_homeassistant_config_dir()
    output_dir = homeassistant_config_dir / "cez_distribuce_readings"
    debug_dir = (homeassistant_config_dir / "cez_distribuce_readings_debug") / (
        f"addon_cez_pnd_fetcher_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}"
    )

    if not username or not password or not device_set_id:
        raise RuntimeError("username, password and device_set_id must be configured")

    interval_from, interval_to = current_month_interval()
    session = requests.Session()
    session.max_redirects = 30
    session.headers.update(BROWSER_HEADERS)

    service_url = (
        f"{CAS_BASE_URL}/oauth2.0/callbackAuthorize"
        f"?client_id={CEZ_CLIENT_ID}"
        f"&redirect_uri={urllib.parse.quote(CEZ_BASE_URL)}"
        f"&response_type={RESPONSE_TYPE}"
        f"&client_name={CLIENT_NAME}"
    )
    login_url = f"{CAS_BASE_URL}/login?service={urllib.parse.quote(service_url)}"
    authorize_url = (
        f"{CAS_BASE_URL}/oidc/authorize"
        f"?scope={SCOPE}"
        f"&response_type={RESPONSE_TYPE}"
        f"&redirect_uri={urllib.parse.quote(CEZ_BASE_URL)}"
        f"&client_id={CEZ_CLIENT_ID}"
    )

    try:
        LOG.warning("### 1) CAS login page")
        response = session.get(login_url, timeout=TIMEOUT)
        LOG.warning("status=%s url=%s", response.status_code, response.url)
        response.raise_for_status()
        form_action, form_payload = parse_login_form(response.text, login_url, username, password)

        LOG.warning("### 2) CAS login submit")
        response = session.post(
            form_action,
            data=form_payload,
            headers={"Origin": "https://cas.cez.cz", "Referer": login_url},
            timeout=TIMEOUT,
        )
        LOG.warning("status=%s url=%s", response.status_code, response.url)
        response.raise_for_status()

        LOG.warning("### 3) CAS authorize")
        response = session.get(authorize_url, timeout=TIMEOUT)
        LOG.warning("status=%s url=%s", response.status_code, response.url)
        response.raise_for_status()

        LOG.warning("### 4) ČEZ token")
        token_url = f"{CEZ_BASE_URL}/rest-auth-api?path=/token/get"
        response = session.get(token_url, timeout=TIMEOUT)
        LOG.warning("status=%s url=%s", response.status_code, response.url)
        response.raise_for_status()
        try:
            token = extract_token(response.json())
        except Exception:
            token = None
        if token:
            session.headers.update({"X-Request-Token": token})
            LOG.warning("X-Request-Token loaded")

        LOG.warning("### 5) PND warm-up")
        warmup_url = f"{PND_BASE_URL}/external/dashboard/view"
        response = session.get(warmup_url, headers=WARMUP_HEADERS, timeout=TIMEOUT)
        warmup_status_code = response.status_code
        warmup_url_final = response.url
        if debug_dump or response.status_code >= 400:
            dump_response(debug_dir, "05_pnd_warmup", response)
        LOG.warning("status=%s url=%s", response.status_code, response.url)

        LOG.warning("### 6) PND data POST")
        payload = {
            "format": "chart",
            "idAssembly": id_assembly,
            "idDeviceSet": str(device_set_id),
            "intervalFrom": interval_from,
            "intervalTo": interval_to,
            "compareFrom": None,
            "opmId": None,
            "electrometerId": None,
        }
        response = session.post(
            f"{PND_BASE_URL}/external/data",
            json=payload,
            headers=DATA_HEADERS,
            timeout=TIMEOUT,
        )
        data_status_code = response.status_code
        data_url_final = response.url
        if debug_dump or response.status_code >= 400:
            dump_response(debug_dir, "06_pnd_data", response, payload=payload)
        LOG.warning("status=%s url=%s content-type=%s", response.status_code, response.url, response.headers.get("content-type"))

        content_type = (response.headers.get("content-type") or "").lower()
        if response.status_code != 200 or "application/json" not in content_type:
            raise RuntimeError(
                f"FAILED status: {response.status_code} content-type: {response.headers.get('content-type')}"
            )

        chart_payload = response.json()
        export = {
            "fetched_at": datetime.now().isoformat(),
            "device_set_id": str(device_set_id),
            "id_assembly": id_assembly,
            "interval_from": interval_from,
            "interval_to": interval_to,
            "warmup_status_code": warmup_status_code,
            "warmup_url": warmup_url_final,
            "data_status_code": data_status_code,
            "data_url": data_url_final,
            "content_type": response.headers.get("content-type"),
            "payload": chart_payload,
        }
        assessment = assess_export_payload(chart_payload)
        export["payload_summary"] = {
            "has_data": assessment.has_data_flag,
            "series_count": assessment.series_count,
            "usable_measurements_count": assessment.usable_measurements_count,
            "is_usable": assessment.is_usable,
            "reason": assessment.reason,
        }
        output_dir.mkdir(parents=True, exist_ok=True)
        LOG.warning("Home Assistant config mount resolved to: %s", homeassistant_config_dir)
        export_key = safe_key(str(device_set_id))
        export_path = output_dir / f"pnd_export_{export_key}.json"
        backup_path = output_dir / f"pnd_export_{export_key}.last_good.json"

        if assessment.is_usable:
            write_json(export_path, export)
            LOG.warning(
                "PND export downloaded and contains data "
                "(hasData=%r, series_count=%s, usable_measurements=%s)",
                assessment.has_data_flag,
                assessment.series_count,
                assessment.usable_measurements_count,
            )
            LOG.warning("PND export saved inside add-on container to: %s", export_path)
            LOG.warning(
                "PND export is visible in Home Assistant at: %s",
                to_homeassistant_visible_path(export_path, homeassistant_config_dir),
            )
            write_json(backup_path, export)
            LOG.warning("Last good PND export backup updated: %s", backup_path)
            LOG.warning(
                "Last good backup is visible in Home Assistant at: %s",
                to_homeassistant_visible_path(backup_path, homeassistant_config_dir),
            )
        else:
            diagnostic_export_path = debug_dir / f"pnd_export_{export_key}.empty.json"
            save_diagnostic_export(diagnostic_export_path, export)
            LOG.warning(
                "PND export downloaded but is empty and will not overwrite the main export "
                "(reason=%s, hasData=%r, series_count=%s, usable_measurements=%s)",
                assessment.reason,
                assessment.has_data_flag,
                assessment.series_count,
                assessment.usable_measurements_count,
            )
            LOG.warning("Empty diagnostic export saved to: %s", diagnostic_export_path)
            LOG.warning(
                "Empty diagnostic export is visible in Home Assistant at: %s",
                to_homeassistant_visible_path(diagnostic_export_path, homeassistant_config_dir),
            )
            restored_from_backup = ensure_main_export_from_backup(
                export_path=export_path,
                backup_path=backup_path,
                homeassistant_config_dir=homeassistant_config_dir,
            )
            if export_path.exists():
                LOG.warning("Main PND export was not overwritten: %s", export_path)
                LOG.warning(
                    "Using last good PND export visible in Home Assistant at: %s",
                    to_homeassistant_visible_path(export_path, homeassistant_config_dir),
                )
            elif backup_path.exists():
                LOG.warning("Last good PND export backup is available at: %s", backup_path)
                LOG.warning(
                    "Backup is visible in Home Assistant at: %s",
                    to_homeassistant_visible_path(backup_path, homeassistant_config_dir),
                )
                if not restored_from_backup:
                    LOG.warning("Main PND export remains missing because restore was not needed.")
            else:
                LOG.warning(
                    "No last good PND export is available yet; main export remains unchanged."
                )
        LOG.warning("Debug files saved inside add-on container to: %s", debug_dir)
        LOG.warning(
            "Debug files are visible in Home Assistant at: %s",
            to_homeassistant_visible_path(debug_dir, homeassistant_config_dir),
        )
    finally:
        session.close()


def main() -> None:
    options = load_options()
    interval_min = max(int(options.get("update_interval_min") or 60), 30)
    while True:
        try:
            fetch_once(options)
        except Exception as err:
            LOG.exception("PND fetcher cycle failed: %s", err)
        time.sleep(interval_min * 60)


if __name__ == "__main__":
    main()
