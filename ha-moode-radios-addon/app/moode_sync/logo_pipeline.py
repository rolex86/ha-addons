from __future__ import annotations

import logging
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

from .config import LogoConfig
from .models import Station


LOGGER = logging.getLogger(__name__)


class LogoPipeline:
    def __init__(self, http: httpx.AsyncClient, logos_dir: Path, config: LogoConfig, timeout: int) -> None:
        self.http = http
        self.logos_dir = logos_dir
        self.config = config
        self.timeout = timeout

    async def ensure_logo(self, station: Station) -> str | None:
        self.logos_dir.mkdir(parents=True, exist_ok=True)
        target = self.logos_dir / f"{station.file_basename}.jpg"
        if target.exists():
            station.logo_path = str(target)
            return str(target)

        if self.config.enabled and station.logo_url:
            try:
                response = await self.http.get(station.logo_url, timeout=self.timeout, follow_redirects=True)
                response.raise_for_status()
                image = Image.open(BytesIO(response.content))
                image = self._square_rgb(image)
                image.save(target, format="JPEG", quality=90)
                station.logo_path = str(target)
                return str(target)
            except Exception as exc:
                LOGGER.warning("Logo download failed for %s: %s", station.display_name, exc)

        image = self._fallback_image(station.display_name[:20] or self.config.default_logo_text)
        image.save(target, format="JPEG", quality=90)
        station.logo_path = str(target)
        station.logo_source = station.logo_source or "fallback"
        return str(target)

    def _square_rgb(self, image: Image.Image) -> Image.Image:
        image = image.convert("RGBA")
        size = max(image.size)
        canvas = Image.new("RGBA", (size, size), (245, 239, 231, 255))
        offset = ((size - image.width) // 2, (size - image.height) // 2)
        canvas.paste(image, offset, image)
        return canvas.convert("RGB").resize((512, 512))

    def _fallback_image(self, text: str) -> Image.Image:
        image = Image.new("RGB", (512, 512), (244, 239, 231))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((24, 24, 488, 488), radius=42, fill=(0, 109, 119))
        font = ImageFont.load_default()
        bbox = draw.multiline_textbbox((0, 0), text, font=font, spacing=6)
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        draw.multiline_text(
            ((512 - width) / 2, (512 - height) / 2),
            text,
            fill=(255, 250, 243),
            font=font,
            align="center",
            spacing=6,
        )
        return image
