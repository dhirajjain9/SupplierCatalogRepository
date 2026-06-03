"""Generate a set of realistic sample catalogs for manual/demo testing.

Produces, under this directory:
  electronics_catalog.csv   — basic catalog with extra supplier columns (no price)
  hardware_catalog.xlsx     — catalog with embedded product images
  textiles_catalog.pdf      — a ruled price-list table inside a PDF
  hardware_quotation.csv    — Step 2: prices + MOQ keyed by SKU
  product_images.zip        — images named by SKU (incl. a second photo + a stray)

Run:  python3 samples/generate_samples.py
"""
from __future__ import annotations

import csv
import io
import os
import zipfile

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))


def _swatch(text: str, color: tuple[int, int, int], size: int = 240) -> bytes:
    """A simple labelled colour tile standing in for a product photo."""
    img = Image.new("RGB", (size, size), color)
    d = ImageDraw.Draw(img)
    d.rectangle([8, 8, size - 8, size - 8], outline=(255, 255, 255), width=3)
    d.text((20, size // 2 - 6), text, fill=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def electronics_csv() -> None:
    rows = [
        ["Part Name", "SKU", "Category", "UOM", "Description", "RoHS", "Lead Time", "Datasheet"],
        ["Resistor 10kΩ 1/4W", "RES-10K", "Passives", "reel", "5% carbon film", "Yes", "2 weeks", "res10k.pdf"],
        ["Capacitor 100nF 50V", "CAP-100N", "Passives", "reel", "X7R ceramic", "Yes", "3 weeks", "cap100n.pdf"],
        ["ATmega328P-PU", "MCU-328P", "Microcontrollers", "tray", "8-bit AVR, DIP-28", "Yes", "6 weeks", "atmega328p.pdf"],
        ["LM358 Op-Amp", "IC-LM358", "ICs", "tube", "Dual op-amp, SOIC-8", "Yes", "4 weeks", "lm358.pdf"],
        ["Tactile Switch 6mm", "SW-TACT6", "Electromech", "bag", "SPST momentary", "Yes", "1 week", ""],
    ]
    with open(os.path.join(HERE, "electronics_catalog.csv"), "w", newline="") as fh:
        csv.writer(fh).writerows(rows)


def hardware_xlsx() -> None:
    import openpyxl
    from openpyxl.drawing.image import Image as XLImage

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Catalog"
    ws.append(["Name", "SKU", "Category", "Unit", "Finish"])
    data = [
        ("Brass Butt Hinge 3\"", "HW-HINGE3", "Hinges", "pair", "Polished Brass", (181, 138, 61)),
        ("SS Hex Bolt M8x40", "HW-BOLTM8", "Fasteners", "box", "Stainless 304", (120, 124, 130)),
        ("Cabinet Knob Round", "HW-KNOB1", "Handles", "each", "Matte Black", (40, 40, 44)),
    ]
    for r, (name, sku, cat, unit, finish, color) in enumerate(data, start=2):
        ws.append([name, sku, cat, unit, finish])
        img = XLImage(io.BytesIO(_swatch(sku, color)))
        img.width = img.height = 48
        ws.add_image(img, f"G{r}")
    for col, w in {"A": 24, "B": 14, "C": 12, "D": 8, "E": 16, "G": 10}.items():
        ws.column_dimensions[col].width = w
    wb.save(os.path.join(HERE, "hardware_catalog.xlsx"))


def textiles_pdf() -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    from reportlab.lib.styles import getSampleStyleSheet

    styles = getSampleStyleSheet()
    doc = SimpleDocTemplate(os.path.join(HERE, "textiles_catalog.pdf"), pagesize=A4)
    header = ["Product", "SKU", "Category", "Unit Price", "Currency", "MOQ"]
    rows = [
        ["Cotton Twill 240gsm", "TX-TWILL240", "Woven", "3.20", "USD", "500"],
        ["Linen Blend 180gsm", "TX-LINEN180", "Woven", "4.75", "USD", "300"],
        ["Polyester Fleece", "TX-FLEECE", "Knit", "2.10", "USD", "1000"],
        ["Organic Jersey 160gsm", "TX-JERSEY160", "Knit", "3.95", "USD", "400"],
    ]
    table = Table([header] + rows, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0071e3")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f5f5f7")]),
        ("PADDING", (0, 0), (-1, -1), 6),
    ]))
    doc.build([
        Paragraph("Spring Textiles — Price List", styles["Title"]),
        Spacer(1, 12), table,
    ])


def hardware_quotation_csv() -> None:
    rows = [
        ["SKU", "Unit Price", "Currency", "MOQ"],
        ["HW-HINGE3", "1.85", "USD", "200"],
        ["HW-BOLTM8", "0.12", "USD", "1000"],
        ["HW-KNOB1", "0.95", "USD", "150"],
        ["HW-UNKNOWN", "9.99", "USD", "1"],   # SKU not in catalog -> reported
    ]
    with open(os.path.join(HERE, "hardware_quotation.csv"), "w", newline="") as fh:
        csv.writer(fh).writerows(rows)


def product_images_zip() -> None:
    entries = {
        "RES-10K.png": _swatch("RES-10K", (200, 60, 60)),
        "CAP-100N.png": _swatch("CAP-100N", (60, 120, 200)),
        "MCU-328P.png": _swatch("MCU-328P", (40, 160, 90)),
        "MCU-328P_2.png": _swatch("MCU-328P alt", (30, 130, 70)),  # 2nd photo, same SKU
        "GHOST-SKU.png": _swatch("no match", (120, 120, 120)),     # unmatched
        "readme.txt": b"These images are named by SKU.",            # skipped
    }
    with zipfile.ZipFile(os.path.join(HERE, "product_images.zip"), "w") as zf:
        for name, blob in entries.items():
            zf.writestr(name, blob)


if __name__ == "__main__":
    electronics_csv()
    hardware_xlsx()
    textiles_pdf()
    hardware_quotation_csv()
    product_images_zip()
    print("Samples written to", HERE)
    for f in sorted(os.listdir(HERE)):
        if f != "generate_samples.py":
            print("  ", f, os.path.getsize(os.path.join(HERE, f)), "bytes")
