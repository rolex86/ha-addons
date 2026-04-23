from __future__ import annotations

import re
import unicodedata
from urllib.parse import urlparse


def normalize_text(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value)
    ascii_only = folded.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", " ", ascii_only.lower()).strip()


def slugify_filename(value: str, fallback: str = "station") -> str:
    folded = unicodedata.normalize("NFKD", value)
    ascii_only = folded.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", ascii_only).strip("-._")
    return slug[:96] or fallback


def ensure_unique_file_basename(
    preferred: str,
    station_id: str,
    used: set[str],
) -> str:
    base = (preferred or "station").strip() or "station"
    if base not in used:
        used.add(base)
        return base

    suffix = slugify_filename(station_id, fallback="id")[:12] or "id"
    candidate = f"{base}-{suffix}"[:96].strip("-._") or f"station-{suffix}"
    if candidate not in used:
        used.add(candidate)
        return candidate

    counter = 2
    while True:
        candidate = f"{base}-{suffix}-{counter}"[:96].strip("-._") or f"station-{suffix}-{counter}"
        if candidate not in used:
            used.add(candidate)
            return candidate
        counter += 1


def preferred_stream_url(
    stream_url_raw: str | None,
    stream_url_resolved: str | None,
) -> str:
    raw = (stream_url_raw or "").strip()
    resolved = (stream_url_resolved or "").strip()
    if not resolved:
        return raw
    if raw and _looks_ephemeral_stream_url(resolved):
        return raw
    return resolved


def _looks_ephemeral_stream_url(url: str) -> bool:
    value = url.lower()
    return any(
        token in value
        for token in (
            "token=",
            "sig=",
            "signature=",
            "expires=",
            "expiry=",
            "rj-ttl=",
            "rj-tok=",
            "aw_0_1st",
            "amsparams=",
            "&cid=",
            "&sid=",
            "&tvf=",
            "?cid=",
            "?sid=",
            "?tvf=",
        )
    )


def keyword_match(haystack: str, keywords: list[str]) -> bool:
    if not keywords:
        return True
    normalized = normalize_text(haystack)
    return any(normalize_text(keyword) in normalized for keyword in keywords if keyword.strip())


def hostname_from_url(url: str | None) -> str:
    if not url:
        return ""
    try:
        return urlparse(url).hostname or ""
    except ValueError:
        return ""
