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
