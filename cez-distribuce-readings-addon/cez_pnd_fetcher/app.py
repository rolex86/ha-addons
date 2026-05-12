from __future__ import annotations

import html
import json
import logging
import os
import time
import urllib.parse
from datetime import datetime
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


def write_json(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


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


def fetch_once(options: dict[str, Any]) -> None:
    username = str(options.get("username") or "").strip()
    password = str(options.get("password") or "").strip()
    device_set_id = str(options.get("device_set_id") or "").strip()
    id_assembly = int(options.get("id_assembly") or -1001)
    debug_dump = bool(options.get("debug_dump", True))
    output_dir = Path("/config/cez_distribuce_readings")
    debug_dir = Path("/config/cez_distribuce_readings_debug") / (
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
        output_dir.mkdir(parents=True, exist_ok=True)
        export_path = output_dir / f"pnd_export_{safe_key(str(device_set_id))}.json"
        write_json(export_path, export)
        LOG.warning("PND export saved to: %s", export_path)
        LOG.warning("Debug files saved in: %s", debug_dir)
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
