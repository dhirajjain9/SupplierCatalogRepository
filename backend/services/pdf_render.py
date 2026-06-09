"""Server-side PDF rasterisation for AI-vision import.

Lets the server render an image-only PDF page-by-page (instead of the browser
downloading the whole file and rendering it), which avoids large client-side
downloads stalling. Uses pypdfium2 (ships a self-contained wheel, no system
binaries). The downloaded PDF is cached in /tmp keyed by file id so repeated
per-page requests don't re-download it on a warm instance.
"""
from __future__ import annotations

import hashlib
import io
import os


def _key(file_id: str) -> str:
    return hashlib.sha1((file_id or "").encode()).hexdigest()[:16]


def _cache_path(file_id: str) -> str:
    return os.path.join("/tmp", f"pdfcache_{_key(file_id)}.pdf")


def cache_pdf(file_id: str, data: bytes) -> None:
    if not file_id:
        return
    try:
        with open(_cache_path(file_id), "wb") as f:
            f.write(data)
    except Exception:
        pass


def cached_pdf(file_id: str) -> bytes | None:
    if not file_id:
        return None
    try:
        with open(_cache_path(file_id), "rb") as f:
            return f.read()
    except Exception:
        return None


def page_count(data: bytes) -> int:
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(data)
    try:
        return len(pdf)
    finally:
        pdf.close()


def render_page_jpeg(data: bytes, index: int, scale: float = 2.0,
                     max_dim: int = 1600, quality: int = 82) -> bytes:
    """Render one 0-based page to a downscaled JPEG (bytes)."""
    import pypdfium2 as pdfium
    from PIL import Image  # noqa: F401  (Pillow is a dependency)

    pdf = pdfium.PdfDocument(data)
    try:
        page = pdf[index]
        pil = page.render(scale=scale).to_pil()
        if max(pil.size) > max_dim:
            pil.thumbnail((max_dim, max_dim))
        if pil.mode != "RGB":
            pil = pil.convert("RGB")
        out = io.BytesIO()
        pil.save(out, format="JPEG", quality=quality)
        return out.getvalue()
    finally:
        pdf.close()


def crop_jpeg(jpeg: bytes, box, quality: int = 85) -> bytes | None:
    """Crop a product's photo from a rendered page JPEG using a normalized
    [x0, y0, x1, y1] box (fractions of the page, or percentages). Returns None if
    the box is missing/invalid or the crop is too small to be useful."""
    if not box or len(box) != 4:
        return None
    try:
        x0, y0, x1, y1 = (float(v) for v in box)
    except (TypeError, ValueError):
        return None
    from PIL import Image

    if max(x0, y0, x1, y1) > 1.5:  # given as percentages
        x0, y0, x1, y1 = x0 / 100, y0 / 100, x1 / 100, y1 / 100
    im = Image.open(io.BytesIO(jpeg))
    w, h = im.size
    left = int(max(0.0, min(x0, x1)) * w)
    top = int(max(0.0, min(y0, y1)) * h)
    right = int(min(1.0, max(x0, x1)) * w)
    bottom = int(min(1.0, max(y0, y1)) * h)
    if right - left < 12 or bottom - top < 12:
        return None
    crop = im.crop((left, top, right, bottom))
    if crop.mode != "RGB":
        crop = crop.convert("RGB")
    out = io.BytesIO()
    crop.save(out, format="JPEG", quality=quality)
    return out.getvalue()
