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
