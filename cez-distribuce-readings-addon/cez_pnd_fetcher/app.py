from __future__ import annotations

import html
import json
import logging
import re
import time
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from curl_cffi import requests as curl_requests

LOG = logging.getLogger("cez_pnd_fetcher")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

CAS_BASE_URL = "https://mepas.cez.cz/cas"
CEZ_BASE_URL = "https://dip.cezdistribuce.cz/irj/portal"
PND_BASE_URL = "https://pnd.cezdistribuce.cz/cezpnd2"
CEZ_CLIENT_ID = "emiCuDBbivwYxraX.dip.dip.ext.zak.prod.v1"
CLIENT_NAME = "CasOAuthClient"
RESPONSE_TYPE = "code"
SCOPE = "openid"
TIMEOUT = 30
TRANSIENT_ATTEMPTS = 3
TRANSIENT_BACKOFF_SECONDS = 2
MAX_REDIRECTS = 30
IMPERSONATE_TARGET = "chrome146"
REDIRECT_STATUSES = {301, 302, 303, 307, 308}

SESSION_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/146.0.0.0 Safari/537.36"
    ),
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
}

NAVIGATION_HEADERS = {
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    ),
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

FORM_HEADERS = {
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    ),
    "Origin": "https://mepas.cez.cz",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

AUTHORIZE_HEADERS = {
    **NAVIGATION_HEADERS,
    "Referer": CEZ_BASE_URL,
    "Sec-Fetch-Site": "cross-site",
}

TOKEN_HEADERS = {
    "Accept": "application/json",
    "Referer": CEZ_BASE_URL,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
}

WARMUP_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://pnd.cezdistribuce.cz/",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

DATA_HEADERS = {
    "Origin": "https://pnd.cezdistribuce.cz",
    "Referer": "https://pnd.cezdistribuce.cz/cezpnd2/external/dashboard/view",
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
}

ADDON_HA_CONFIG_DIR = Path("/homeassistant")
LEGACY_HA_CONFIG_DIR = Path("/config")
HA_VISIBLE_CONFIG_DIR = Path("/config")
VALID_PND_STATUS = "naměřená data OK"
PND_INTERVAL_HOURS = 0.25
SENSITIVE_KEYS = {
    "access_token",
    "authorization",
    "code",
    "cookie",
    "execution",
    "id_token",
    "nonce",
    "password",
    "refresh_token",
    "set-cookie",
    "state",
    "ticket",
    "token",
    "username",
    "x-request-token",
    "xrequesttoken",
    "xsrftoken",
    "csrftoken",
}


class CasAccessBlockedError(RuntimeError):
    def __init__(self, status_code: int, reason: str, identifier: str | None = None) -> None:
        self.status_code = status_code
        self.reason = reason
        self.identifier = identifier
        suffix = f", identifier={identifier}" if identifier else ""
        super().__init__(
            f"CAS access blocked with HTTP {status_code}: reason={reason}{suffix}"
        )


class CasLoginPageChangedError(RuntimeError):
    pass


class CasAuthenticationError(RuntimeError):
    pass


class CezTokenError(RuntimeError):
    pass


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
    masked: list[tuple[str, str]] = []
    for key, val in query:
        lowered = key.lower()
        if lowered in SENSITIVE_KEYS:
            safe_value = "***"
        elif val.startswith(("http://", "https://")):
            safe_value = sanitize_url(val) or ""
        else:
            safe_value = val
        masked.append((key, safe_value))
    return urllib.parse.urlunparse(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            urllib.parse.urlencode(masked, quote_via=urllib.parse.quote),
            redact_sensitive_text(parsed.fragment),
        )
    )


def safe_headers(headers: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    for key, value in dict(headers or {}).items():
        lowered = str(key).lower()
        if (
            lowered in SENSITIVE_KEYS
            or "authorization" in lowered
            or "cookie" in lowered
            or "token" in lowered
        ):
            result[str(key)] = "***"
        elif lowered in {"location", "referer"}:
            result[str(key)] = sanitize_url(str(value)) or ""
        else:
            result[str(key)] = str(value)
    return result


def redact_sensitive_text(value: str, secrets: tuple[str, ...] = ()) -> str:
    redacted = value
    for secret in sorted((item for item in secrets if item), key=len, reverse=True):
        redacted = redacted.replace(secret, "***")

    def redact_sensitive_input(match: re.Match[str]) -> str:
        tag = match.group(0)
        name_match = re.search(
            r"""(?i)\bname\s*=\s*["']([^"']+)["']""",
            tag,
        )
        if not name_match or name_match.group(1).lower() not in SENSITIVE_KEYS:
            return tag
        return re.sub(
            r"""(?i)(\bvalue\s*=\s*["'])[^"']*(["'])""",
            r"\1***\2",
            tag,
        )

    redacted = re.sub(
        r"(?is)<input\b[^>]*>",
        redact_sensitive_input,
        redacted,
    )
    sensitive_names = "|".join(re.escape(key) for key in sorted(SENSITIVE_KEYS))
    redacted = re.sub(
        rf"(?i)((?:{sensitive_names})(?:=|%3d|\"\s*:\s*\"?))([^&\s<>\"']+)",
        r"\1***",
        redacted,
    )
    redacted = re.sub(r"(?i)\b(ST|TGT)-[A-Za-z0-9._~-]+", r"\1-***", redacted)
    return redacted


def sanitize_diagnostic_data(value: Any, secrets: tuple[str, ...] = ()) -> Any:
    if isinstance(value, dict):
        return {
            str(key): (
                "***"
                if str(key).lower() in SENSITIVE_KEYS
                else sanitize_diagnostic_data(item, secrets)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_diagnostic_data(item, secrets) for item in value]
    if isinstance(value, tuple):
        return [sanitize_diagnostic_data(item, secrets) for item in value]
    if isinstance(value, str):
        return redact_sensitive_text(value, secrets)
    return value


def build_auth_urls() -> tuple[str, str, str]:
    service_url = (
        f"{CAS_BASE_URL}/oauth2.0/callbackAuthorize?"
        + urllib.parse.urlencode(
            {
                "client_id": CEZ_CLIENT_ID,
                "scope": SCOPE,
                "redirect_uri": CEZ_BASE_URL,
                "response_type": RESPONSE_TYPE,
                "client_name": CLIENT_NAME,
            },
            quote_via=urllib.parse.quote,
        )
    )
    login_url = (
        f"{CAS_BASE_URL}/login?"
        + urllib.parse.urlencode(
            {"service": service_url},
            quote_via=urllib.parse.quote,
        )
    )
    authorize_url = (
        f"{CAS_BASE_URL}/oidc/oidcAuthorize?"
        + urllib.parse.urlencode(
            {
                "response_type": RESPONSE_TYPE,
                "redirect_uri": CEZ_BASE_URL,
                "client_id": CEZ_CLIENT_ID,
                "scope": SCOPE,
            },
            quote_via=urllib.parse.quote,
        )
    )
    return service_url, login_url, authorize_url


def classify_cas_response(
    response: curl_requests.Response,
) -> tuple[str, str | None]:
    body = response.text.lower()
    header_text = " ".join(
        f"{key}:{value}" for key, value in response.headers.items()
    ).lower()
    evidence = f"{header_text}\n{body}"
    markers = (
        ("cloudflare", ("cloudflare", "cf-ray", "/cdn-cgi/challenge")),
        ("akamai", ("akamai", "ak_bmsc", "bm_sv", "reference #")),
        ("imperva", ("imperva", "incapsula", "_incap_")),
        ("datadome", ("datadome", "captcha-delivery.com")),
        ("perimeterx", ("perimeterx", "_pxhd", "px-captcha")),
    )
    for identifier, patterns in markers:
        if any(pattern in evidence for pattern in patterns):
            return "possible_bot_protection", identifier

    challenge_markers = (
        "enable javascript",
        "javascript is required",
        "checking your browser",
        "verify you are human",
        "cookie challenge",
    )
    if any(marker in evidence for marker in challenge_markers):
        return "javascript_or_cookie_challenge", "generic_challenge"

    hostname = (urllib.parse.urlparse(response.url).hostname or "").lower()
    if response.status_code == 403 and hostname == "cas.cez.cz":
        return "obsolete_cas_endpoint", "legacy_cas_host"
    if response.status_code == 403:
        return "access_denied_by_cas", None
    return "unexpected_cas_response", None


def contains_cas_login_form(html_text: str) -> bool:
    parser = LoginFormParser()
    parser.feed(html_text)
    return any("execution" in (form.get("inputs") or {}) for form in parser.forms)


def validate_cas_login_page(response: curl_requests.Response) -> None:
    if response.status_code != 200:
        reason, identifier = classify_cas_response(response)
        if response.status_code == 403:
            LOG.error(
                "CAS login blocked: status=%s reason=%s identifier=%s",
                response.status_code,
                reason,
                identifier or "none",
            )
            raise CasAccessBlockedError(response.status_code, reason, identifier)
        response.raise_for_status()
        raise CasLoginPageChangedError(
            f"CAS login returned unexpected HTTP {response.status_code}"
        )

    content_type = (response.headers.get("content-type") or "").lower()
    if "html" not in content_type:
        raise CasLoginPageChangedError(
            f"CAS login page is not HTML (content-type={content_type or 'missing'})"
        )

    if not contains_cas_login_form(response.text):
        reason, identifier = classify_cas_response(response)
        if reason == "javascript_or_cookie_challenge":
            raise CasAccessBlockedError(response.status_code, reason, identifier)
        raise CasLoginPageChangedError(
            "CAS login page does not contain the expected execution token"
        )


def request_with_backoff(
    session: curl_requests.Session,
    method: str,
    url: str,
    *,
    sleep: Any = time.sleep,
    **kwargs: Any,
) -> curl_requests.Response:
    response: curl_requests.Response | None = None
    for attempt in range(1, TRANSIENT_ATTEMPTS + 1):
        response = request_with_history(session, method, url, **kwargs)
        is_transient = response.status_code == 429 or response.status_code >= 500
        if not is_transient or attempt == TRANSIENT_ATTEMPTS:
            return response
        delay = TRANSIENT_BACKOFF_SECONDS * (2 ** (attempt - 1))
        LOG.warning(
            "Transient HTTP %s at %s; retry %s/%s in %ss",
            response.status_code,
            sanitize_url(url),
            attempt + 1,
            TRANSIENT_ATTEMPTS,
            delay,
        )
        response.close()
        sleep(delay)
    assert response is not None
    return response


def request_with_history(
    session: curl_requests.Session,
    method: str,
    url: str,
    **kwargs: Any,
) -> curl_requests.Response:
    allow_redirects = bool(kwargs.pop("allow_redirects", True))
    if not allow_redirects:
        return session.request(method, url, allow_redirects=False, **kwargs)

    history: list[curl_requests.Response] = []
    current_method = method.upper()
    current_url = url
    current_kwargs = dict(kwargs)

    for _ in range(MAX_REDIRECTS + 1):
        response = session.request(
            current_method,
            current_url,
            allow_redirects=False,
            **current_kwargs,
        )
        location = response.headers.get("location")
        if response.status_code not in REDIRECT_STATUSES or not location:
            response.history = history
            return response

        history.append(response)
        if len(history) > MAX_REDIRECTS:
            raise RuntimeError(f"Too many HTTP redirects (limit={MAX_REDIRECTS})")

        next_url = urllib.parse.urljoin(response.url, location)
        changes_to_get = response.status_code == 303 or (
            response.status_code in {301, 302} and current_method == "POST"
        )
        if changes_to_get and current_method != "HEAD":
            current_method = "GET"
            current_kwargs.pop("data", None)
            current_kwargs.pop("json", None)

        headers = dict(current_kwargs.get("headers") or {})
        headers["Referer"] = response.url
        previous = urllib.parse.urlparse(response.url)
        upcoming = urllib.parse.urlparse(next_url)
        headers["Sec-Fetch-Site"] = (
            "same-origin"
            if (previous.scheme, previous.netloc) == (upcoming.scheme, upcoming.netloc)
            else "cross-site"
        )
        if current_method in {"GET", "HEAD"}:
            headers.pop("Origin", None)
            headers.pop("Content-Type", None)
        current_kwargs["headers"] = headers
        current_url = next_url

    raise RuntimeError(f"Too many HTTP redirects (limit={MAX_REDIRECTS})")


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
            raise CasLoginPageChangedError(
                "CAS login form does not contain execution token"
            )
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


def dump_response(
    debug_dir: Path,
    kind: str,
    response: curl_requests.Response,
    payload: dict[str, Any] | None = None,
    secrets: tuple[str, ...] = (),
) -> None:
    debug_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    base = debug_dir / f"{stamp}_{kind}"
    content_type = response.headers.get("content-type", "")
    if "html" in content_type.lower():
        body_path = base.with_suffix(".sanitized.html")
    elif "json" in content_type.lower():
        body_path = base.with_suffix(".sanitized.response.json")
    else:
        body_path = base.with_suffix(".sanitized.txt")
    if "json" in content_type.lower():
        try:
            sanitized_body = json.dumps(
                sanitize_diagnostic_data(response.json(), secrets),
                ensure_ascii=False,
                indent=2,
            )
        except (curl_requests.exceptions.RequestException, ValueError):
            sanitized_body = redact_sensitive_text(response.text, secrets)
    else:
        sanitized_body = redact_sensitive_text(response.text, secrets)
    body_path.write_text(sanitized_body, encoding="utf-8")
    classification: dict[str, str | None] | None = None
    if kind.startswith(("01_cas_", "02_cas_", "03_cas_")):
        reason, identifier = classify_cas_response(response)
        classification = {
            "reason": reason,
            "identifier": identifier,
        }
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
        "body_preview": sanitized_body[:5000],
        "classification": classification,
        "payload": sanitize_diagnostic_data(payload, secrets),
        "body_path": str(body_path),
        "body_sanitized": True,
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


def error_type_for_exception(error: Exception) -> str:
    if isinstance(error, CasAccessBlockedError):
        return "cas_blocked"
    if isinstance(error, CasLoginPageChangedError):
        return "cas_login_page_changed"
    if isinstance(error, CasAuthenticationError):
        return "cas_authentication_failed"
    if isinstance(error, CezTokenError):
        return "cez_token_missing"
    if isinstance(error, curl_requests.exceptions.HTTPError):
        return "http_error"
    return "fetch_failed"


def status_code_for_exception(error: Exception) -> int | None:
    status_code = getattr(error, "status_code", None)
    if isinstance(status_code, int):
        return status_code
    response = getattr(error, "response", None)
    value = getattr(response, "status_code", None)
    return value if isinstance(value, int) else None


def save_failure_diagnostic(
    path: Path,
    *,
    stage: str,
    error: Exception,
    debug_dir: Path,
    export_path: Path,
    backup_path: Path,
    homeassistant_config_dir: Path,
    secrets: tuple[str, ...],
) -> None:
    reason = getattr(error, "reason", None)
    diagnostic = {
        "ok": False,
        "stage": stage,
        "status_code": status_code_for_exception(error),
        "error_type": error_type_for_exception(error),
        "reason": reason,
        "message": redact_sensitive_text(str(error), secrets),
        "failed_at": datetime.now().astimezone().isoformat(),
        "last_good_export_preserved": export_path.exists() or backup_path.exists(),
        "main_export_exists": export_path.exists(),
        "last_good_backup_exists": backup_path.exists(),
        "debug_directory": str(
            to_homeassistant_visible_path(debug_dir, homeassistant_config_dir)
        ),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, diagnostic)
    LOG.error(
        "Failure diagnostic saved: %s",
        to_homeassistant_visible_path(path, homeassistant_config_dir),
    )


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

    export_key = safe_key(str(device_set_id))
    export_path = output_dir / f"pnd_export_{export_key}.json"
    backup_path = output_dir / f"pnd_export_{export_key}.last_good.json"
    failure_path = (
        homeassistant_config_dir
        / "cez_distribuce_readings_debug"
        / f"pnd_fetch_{export_key}.last_failure.json"
    )
    interval_from, interval_to = current_month_interval()
    session = curl_requests.Session(
        impersonate=IMPERSONATE_TARGET,
        max_redirects=30,
        headers=SESSION_HEADERS,
    )
    _, login_url, authorize_url = build_auth_urls()
    token: str | None = None
    stage = "initialization"

    try:
        LOG.info("HTTP transport=curl_cffi impersonate=%s", IMPERSONATE_TARGET)
        LOG.info("CAS login URL: %s", sanitize_url(login_url))
        LOG.info("CAS authorize URL: %s", sanitize_url(authorize_url))

        stage = "cas_login"
        LOG.warning("### 1) CAS login page")
        response = request_with_backoff(
            session,
            "GET",
            login_url,
            headers=NAVIGATION_HEADERS,
            timeout=TIMEOUT,
        )
        login_dumped = debug_dump or response.status_code >= 400
        if login_dumped:
            dump_response(
                debug_dir,
                "01_cas_login",
                response,
                secrets=(username, password),
            )
        LOG.warning(
            "status=%s url=%s",
            response.status_code,
            sanitize_url(response.url),
        )
        try:
            validate_cas_login_page(response)
        except Exception:
            if not login_dumped:
                dump_response(
                    debug_dir,
                    "01_cas_login",
                    response,
                    secrets=(username, password),
                )
            raise
        form_action, form_payload = parse_login_form(
            response.text,
            login_url,
            username,
            password,
        )

        stage = "cas_submit"
        LOG.warning("### 2) CAS login submit")
        response = request_with_backoff(
            session,
            "POST",
            form_action,
            data=form_payload,
            headers={**FORM_HEADERS, "Referer": login_url},
            timeout=TIMEOUT,
        )
        submit_dumped = debug_dump or response.status_code >= 400
        if submit_dumped:
            dump_response(
                debug_dir,
                "02_cas_submit",
                response,
                secrets=(username, password),
            )
        LOG.warning(
            "status=%s url=%s",
            response.status_code,
            sanitize_url(response.url),
        )
        if response.status_code == 403:
            reason, identifier = classify_cas_response(response)
            LOG.error(
                "CAS submit blocked: status=403 reason=%s identifier=%s",
                reason,
                identifier or "none",
            )
            raise CasAccessBlockedError(403, reason, identifier)
        response.raise_for_status()
        if contains_cas_login_form(response.text):
            if not submit_dumped:
                dump_response(
                    debug_dir,
                    "02_cas_submit",
                    response,
                    secrets=(username, password),
                )
            raise CasAuthenticationError(
                "CAS returned the login form after credential submission"
            )

        stage = "cas_authorize"
        LOG.warning("### 3) CAS authorize")
        response = request_with_backoff(
            session,
            "GET",
            authorize_url,
            headers=AUTHORIZE_HEADERS,
            timeout=TIMEOUT,
        )
        authorize_dumped = debug_dump or response.status_code >= 400
        if authorize_dumped:
            dump_response(
                debug_dir,
                "03_cas_authorize",
                response,
                secrets=(username, password),
            )
        LOG.warning(
            "status=%s url=%s",
            response.status_code,
            sanitize_url(response.url),
        )
        if response.status_code == 403:
            reason, identifier = classify_cas_response(response)
            LOG.error(
                "CAS authorize blocked: status=403 reason=%s identifier=%s",
                reason,
                identifier or "none",
            )
            raise CasAccessBlockedError(403, reason, identifier)
        response.raise_for_status()
        if contains_cas_login_form(response.text):
            if not authorize_dumped:
                dump_response(
                    debug_dir,
                    "03_cas_authorize",
                    response,
                    secrets=(username, password),
                )
            raise CasAuthenticationError(
                "CAS authorization returned the login form instead of the ČEZ portal"
            )

        stage = "cez_token"
        LOG.warning("### 4) ČEZ token")
        token_url = f"{CEZ_BASE_URL}/rest-auth-api?path=/token/get"
        response = request_with_backoff(
            session,
            "GET",
            token_url,
            headers=TOKEN_HEADERS,
            timeout=TIMEOUT,
        )
        LOG.warning(
            "status=%s url=%s",
            response.status_code,
            sanitize_url(response.url),
        )
        if response.status_code >= 400:
            dump_response(
                debug_dir,
                "04_cez_token",
                response,
                secrets=(username, password),
            )
        response.raise_for_status()
        try:
            token = extract_token(response.json())
        except (curl_requests.exceptions.RequestException, ValueError):
            token = None
        if debug_dump or not token:
            dump_response(
                debug_dir,
                "04_cez_token",
                response,
                secrets=(username, password, token or ""),
            )
        if not token:
            raise CezTokenError("ČEZ token response did not contain a request token")
        if token:
            session.headers.update({"X-Request-Token": token})
            LOG.warning("X-Request-Token loaded")

        stage = "pnd_warmup"
        LOG.warning("### 5) PND warm-up")
        warmup_url = f"{PND_BASE_URL}/external/dashboard/view"
        response = request_with_backoff(
            session,
            "GET",
            warmup_url,
            headers=WARMUP_HEADERS,
            timeout=TIMEOUT,
        )
        warmup_status_code = response.status_code
        warmup_url_final = sanitize_url(response.url)
        if debug_dump or response.status_code >= 400:
            dump_response(
                debug_dir,
                "05_pnd_warmup",
                response,
                secrets=(username, password, token),
            )
        LOG.warning(
            "status=%s url=%s",
            response.status_code,
            sanitize_url(response.url),
        )
        response.raise_for_status()

        stage = "pnd_data"
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
        response = request_with_backoff(
            session,
            "POST",
            f"{PND_BASE_URL}/external/data",
            json=payload,
            headers=DATA_HEADERS,
            timeout=TIMEOUT,
        )
        data_status_code = response.status_code
        data_url_final = sanitize_url(response.url)
        data_dumped = debug_dump or response.status_code >= 400
        if data_dumped:
            dump_response(
                debug_dir,
                "06_pnd_data",
                response,
                payload=payload,
                secrets=(username, password, token),
            )
        LOG.warning(
            "status=%s url=%s content-type=%s",
            response.status_code,
            sanitize_url(response.url),
            response.headers.get("content-type"),
        )

        content_type = (response.headers.get("content-type") or "").lower()
        if response.status_code != 200:
            response.raise_for_status()
        if "application/json" not in content_type:
            if not data_dumped:
                dump_response(
                    debug_dir,
                    "06_pnd_data",
                    response,
                    payload=payload,
                    secrets=(username, password, token),
                )
            raise RuntimeError(
                "PND response has unexpected content-type: "
                f"{response.headers.get('content-type')}"
            )

        try:
            chart_payload = response.json()
        except ValueError:
            if not data_dumped:
                dump_response(
                    debug_dir,
                    "06_pnd_data",
                    response,
                    payload=payload,
                    secrets=(username, password, token),
                )
            raise RuntimeError("PND response body is not valid JSON")
        if not isinstance(chart_payload, dict):
            if not data_dumped:
                dump_response(
                    debug_dir,
                    "06_pnd_data",
                    response,
                    payload=payload,
                    secrets=(username, password, token),
                )
            raise RuntimeError("PND response JSON is not an object")
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
        if debug_dir.exists():
            LOG.warning("Debug files saved inside add-on container to: %s", debug_dir)
            LOG.warning(
                "Debug files are visible in Home Assistant at: %s",
                to_homeassistant_visible_path(debug_dir, homeassistant_config_dir),
            )
    except Exception as error:
        ensure_main_export_from_backup(
            export_path=export_path,
            backup_path=backup_path,
            homeassistant_config_dir=homeassistant_config_dir,
        )
        save_failure_diagnostic(
            failure_path,
            stage=stage,
            error=error,
            debug_dir=debug_dir,
            export_path=export_path,
            backup_path=backup_path,
            homeassistant_config_dir=homeassistant_config_dir,
            secrets=(username, password, token or ""),
        )
        raise
    finally:
        session.close()


def main() -> None:
    options = load_options()
    interval_min = max(int(options.get("update_interval_min") or 60), 30)
    while True:
        try:
            fetch_once(options)
        except Exception as err:
            LOG.exception(
                "PND fetcher cycle failed: %s",
                redact_sensitive_text(str(err)),
            )
        time.sleep(interval_min * 60)


if __name__ == "__main__":
    main()
