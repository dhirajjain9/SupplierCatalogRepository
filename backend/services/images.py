"""Extract product images from a zip archive or embedded in an Excel file.

Images are matched to catalog items by SKU:
  * zip / loose files  -> SKU taken from the file name stem (``BH-01.jpg`` ->
    ``BH-01``); a trailing ``_1`` / ``_2`` lets one product have several photos.
  * embedded in .xlsx   -> the image's anchor row is mapped to that row's SKU.
"""
from __future__ import annotations

import io
import os
import re
import zipfile
from dataclasses import dataclass

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
_CONTENT_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
}
_SUFFIX_RE = re.compile(r"_\d+$")  # trailing _1, _2 … for multiple photos per SKU


@dataclass
class ExtractedImage:
    filename: str
    data: bytes
    content_type: str
    sku: str | None = None       # set for filename-based sources
    source_row: int | None = None  # 1-based row, set for embedded xlsx images


def content_type_for(filename: str) -> str:
    return _CONTENT_TYPES.get(os.path.splitext(filename)[1].lower(), "application/octet-stream")


def is_image(filename: str) -> bool:
    return os.path.splitext(filename)[1].lower() in IMAGE_EXTS


def sku_candidates(filename: str) -> list[str]:
    """Possible SKUs for an image filename, most specific first.

    ``BH-01_2.jpg`` -> ['BH-01_2', 'BH-01'] so an exact match wins but a numbered
    photo still falls back to its base SKU.
    """
    stem = os.path.splitext(os.path.basename(filename))[0].strip()
    candidates = [stem]
    base = _SUFFIX_RE.sub("", stem)
    if base and base != stem:
        candidates.append(base)
    return candidates


def extract_zip_images(data: bytes) -> list[ExtractedImage]:
    """Pull every image file out of a zip, ignoring folders and non-images."""
    images: list[ExtractedImage] = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            name = info.filename
            if info.is_dir() or os.path.basename(name).startswith("."):
                continue
            if not is_image(name):
                continue
            images.append(
                ExtractedImage(
                    filename=os.path.basename(name),
                    data=zf.read(info),
                    content_type=content_type_for(name),
                )
            )
    return images


def extract_xlsx_images(data: bytes) -> list[ExtractedImage]:
    """Pull images embedded in the first worksheet, tagged with their anchor row."""
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(data))
    ws = wb.active
    images: list[ExtractedImage] = []
    for idx, img in enumerate(getattr(ws, "_images", [])):
        try:
            blob = img._data()
        except Exception:
            continue
        ext = f".{(img.format or 'png').lower()}"
        # anchor._from.row is 0-based; +1 makes it match our 1-based row numbers.
        row = None
        anchor = getattr(img, "anchor", None)
        frm = getattr(anchor, "_from", None)
        if frm is not None:
            row = frm.row + 1
        images.append(
            ExtractedImage(
                filename=f"image_{idx + 1}{ext}",
                data=blob,
                content_type=_CONTENT_TYPES.get(ext, "image/png"),
                source_row=row,
            )
        )
    wb.close()
    return images
