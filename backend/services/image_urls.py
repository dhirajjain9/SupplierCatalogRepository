"""Attach product images that a catalog row references by URL.

Many catalogs keep photos as links rather than embedded bytes — e.g. a Google
Drive ``uc?id=…`` URL sitting in a ``Display Image`` / ``Image 2`` column. This
module finds those URLs (only in image-ish columns, so links like an Alibaba
product page or a PI document are ignored), downloads each one, and downscales
it to a small JPEG ready to store against the item.

Drive links are fetched through the connected Google account when a token is
available (so private files work); anything else is fetched with a plain HTTP
GET. Every failure is non-fatal — a broken link just means one missing photo.
"""
from __future__ import annotations

import io
import re
import urllib.request
from typing import Callable

# Columns whose header looks like it holds a picture. Matched as whole words so
# "image"/"images"/"img"/"photo"/"picture"/"pic"/"thumbnail" qualify but
# "Alibaba Link" / "PI Document URL" do not.
_IMAGE_HEADER_RE = re.compile(r"\b(image|images|img|imgs|photo|photos|picture|pic|thumbnail)\b", re.I)
_URL_RE = re.compile(r"https?://[^\s,;|]+", re.I)
# Drive file-id forms: uc?id=, open?id=, ?id=, /file/d/<id>, /d/<id>.
_DRIVE_ID_RES = (
    re.compile(r"[?&]id=([a-zA-Z0-9_-]{10,})"),
    re.compile(r"/file/d/([a-zA-Z0-9_-]{10,})"),
    re.compile(r"/d/([a-zA-Z0-9_-]{10,})"),
)

_MAX_BYTES = 25 * 1024 * 1024  # don't pull anything absurdly large over HTTP
_MAX_DIM = 1280                # longest edge after downscale
_JPEG_QUALITY = 82


def is_image_header(header: str) -> bool:
    return bool(_IMAGE_HEADER_RE.search(header or ""))


def drive_file_id(url: str) -> str | None:
    if "drive.google.com" not in url and "docs.google.com" not in url and "googleusercontent" not in url:
        return None
    for rx in _DRIVE_ID_RES:
        m = rx.search(url)
        if m:
            return m.group(1)
    return None


def collect(attributes: dict | None) -> list[str]:
    """Ordered, de-duplicated image URLs found in a row's image-ish columns."""
    urls: list[str] = []
    seen: set[str] = set()
    for header, value in (attributes or {}).items():
        if not is_image_header(header) or not isinstance(value, str):
            continue
        for m in _URL_RE.findall(value):
            u = m.rstrip(").,;")
            if u not in seen:
                seen.add(u)
                urls.append(u)
    return urls


def _http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read(_MAX_BYTES + 1)


def fetch(url: str, drive_get: Callable[[str], bytes] | None) -> bytes | None:
    """Download the raw bytes for a URL, or None if it can't be retrieved."""
    try:
        fid = drive_file_id(url)
        if fid and drive_get is not None:
            data = drive_get(fid)
        elif fid:
            # Public Drive file, no connected account: use the direct-download host.
            data = _http_get(f"https://drive.google.com/uc?export=download&id={fid}")
        else:
            data = _http_get(url)
    except Exception:
        return None
    if not data or len(data) > _MAX_BYTES:
        return None
    return data


def to_jpeg(data: bytes) -> tuple[bytes, str] | None:
    """Downscale to a small JPEG. Returns (bytes, content_type), or None if the
    bytes aren't a decodable image."""
    try:
        from PIL import Image
    except Exception:
        return None
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception:
        return None
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    im.thumbnail((_MAX_DIM, _MAX_DIM))
    out = io.BytesIO()
    im.save(out, format="JPEG", quality=_JPEG_QUALITY)
    return out.getvalue(), "image/jpeg"
