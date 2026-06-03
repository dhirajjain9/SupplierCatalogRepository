"""Catalog import: parse CSV / XLSX / PDF files into validated catalog rows.

The module separates *parsing* (turning a file into a header + raw rows) from
*normalization/validation* (mapping arbitrary headers to our canonical fields
and type-checking each value). This keeps the router thin and makes the
format-agnostic logic easy to unit test.

Canonical fields: name (required), sku, unit, category, description,
unit_price, currency, min_quantity.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field

# Map each canonical field to the set of lower-cased header aliases we accept.
HEADER_ALIASES: dict[str, set[str]] = {
    "name": {"name", "product", "product name", "item", "item name", "title"},
    "sku": {"sku", "code", "item code", "product code", "part", "part number",
            "part no", "part no.", "mpn"},
    "unit": {"unit", "uom", "unit of measure"},
    "category": {"category", "type", "product type", "group", "class"},
    "description": {"description", "desc", "details", "notes"},
    "unit_price": {"unit price", "price", "cost", "rate", "unit cost", "list price"},
    "currency": {"currency", "ccy", "cur"},
    "min_quantity": {"min quantity", "min qty", "moq", "minimum quantity",
                     "minimum order quantity", "min order qty"},
}

# Reverse lookup: alias -> canonical field.
_ALIAS_TO_FIELD = {alias: field for field, aliases in HEADER_ALIASES.items() for alias in aliases}

TEMPLATE_HEADERS = [
    "Name", "SKU", "Unit", "Category", "Description",
    "Unit Price", "Currency", "Min Quantity",
]


@dataclass
class ParsedRow:
    name: str
    sku: str | None = None
    unit: str | None = None
    category: str | None = None
    description: str | None = None
    unit_price: float | None = None
    currency: str = "USD"
    min_quantity: int = 1

    @property
    def has_price(self) -> bool:
        return self.unit_price is not None


@dataclass
class ImportResult:
    rows: list[ParsedRow] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)  # {"row": int, "error": str}


class UnsupportedFileType(Exception):
    pass


def canonical_header(raw: str | None) -> str | None:
    if raw is None:
        return None
    return _ALIAS_TO_FIELD.get(str(raw).strip().lower())


def _clean(value) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def normalize_rows(headers: list, raw_rows: list[list]) -> ImportResult:
    """Map headers to canonical fields and validate each raw row.

    ``headers`` and each entry of ``raw_rows`` are positional lists of cells.
    Row numbers in errors are 1-based and count the header as row 1.
    """
    result = ImportResult()

    # Column index -> canonical field name.
    col_map: dict[int, str] = {}
    for idx, h in enumerate(headers):
        canon = canonical_header(h)
        if canon and canon not in col_map.values():
            col_map[idx] = canon

    if "name" not in col_map.values():
        result.errors.append({
            "row": 1,
            "error": "Could not find a 'Name' column. Recognized headers: "
                     + ", ".join(sorted(_ALIAS_TO_FIELD)),
        })
        return result

    for offset, raw in enumerate(raw_rows):
        row_no = offset + 2  # +1 for header, +1 for 1-based
        values: dict[str, str | None] = {}
        for idx, field_name in col_map.items():
            values[field_name] = _clean(raw[idx]) if idx < len(raw) else None

        # Skip completely blank rows silently.
        if not any(values.values()):
            continue

        name = values.get("name")
        if not name:
            result.errors.append({"row": row_no, "error": "Missing required 'name'"})
            continue

        row = ParsedRow(name=name)
        row.sku = values.get("sku")
        row.unit = values.get("unit")
        row.category = values.get("category")
        row.description = values.get("description")

        price_raw = values.get("unit_price")
        if price_raw is not None:
            try:
                # Tolerate currency symbols / thousands separators.
                cleaned = price_raw.replace(",", "").lstrip("$€£ ").strip()
                price = float(cleaned)
            except ValueError:
                result.errors.append(
                    {"row": row_no, "error": f"Invalid unit_price: {price_raw!r}"}
                )
                continue
            if price < 0:
                result.errors.append({"row": row_no, "error": "unit_price cannot be negative"})
                continue
            row.unit_price = price

        currency = values.get("currency")
        if currency:
            if len(currency) != 3 or not currency.isalpha():
                result.errors.append(
                    {"row": row_no, "error": f"Invalid currency: {currency!r} (use a 3-letter code)"}
                )
                continue
            row.currency = currency.upper()

        min_qty = values.get("min_quantity")
        if min_qty is not None:
            try:
                qty = int(float(min_qty))
            except ValueError:
                result.errors.append(
                    {"row": row_no, "error": f"Invalid min_quantity: {min_qty!r}"}
                )
                continue
            if qty < 1:
                result.errors.append({"row": row_no, "error": "min_quantity must be >= 1"})
                continue
            row.min_quantity = qty

        result.rows.append(row)

    return result


# --------------------------------------------------------------------------- #
# Format-specific parsing -> (headers, raw_rows)
# --------------------------------------------------------------------------- #
def _parse_csv(data: bytes) -> tuple[list, list[list]]:
    text = data.decode("utf-8-sig", errors="replace")
    reader = list(csv.reader(io.StringIO(text)))
    if not reader:
        return [], []
    return reader[0], reader[1:]


def _parse_xlsx(data: bytes) -> tuple[list, list[list]]:
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = wb.active
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    wb.close()
    if not rows:
        return [], []
    return rows[0], rows[1:]


# Table-detection strategies tried in order: ruled tables first (most reliable),
# then a text-alignment heuristic for borderless tables.
_PDF_TABLE_SETTINGS = (
    {},  # pdfplumber default ("lines")
    {"vertical_strategy": "text", "horizontal_strategy": "text"},
)


def _parse_pdf(data: bytes) -> tuple[list, list[list]]:
    """Best-effort extraction of tabular rows from a PDF.

    Scans every table on every page; the first table whose header row maps to a
    'name' column defines the headers, and subsequent matching tables contribute
    data rows. Falls back from ruled-line detection to a text-alignment strategy
    so both bordered and borderless catalog tables are handled.
    """
    import pdfplumber

    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for settings in _PDF_TABLE_SETTINGS:
            headers: list = []
            raw_rows: list[list] = []
            for page in pdf.pages:
                for table in page.extract_tables(settings) or []:
                    if not table:
                        continue
                    head, *body = table
                    if "name" in {canonical_header(c) for c in head}:
                        if not headers:
                            headers = head
                        raw_rows.extend(body)
            if headers:
                return headers, raw_rows
    return [], []


def parse_catalog_file(filename: str, content_type: str | None, data: bytes) -> ImportResult:
    """Dispatch to the right parser based on file extension, then normalize."""
    name = (filename or "").lower()
    if name.endswith(".csv"):
        headers, rows = _parse_csv(data)
    elif name.endswith(".xlsx"):
        headers, rows = _parse_xlsx(data)
    elif name.endswith(".pdf"):
        headers, rows = _parse_pdf(data)
    else:
        raise UnsupportedFileType(
            "Unsupported file type. Please upload a .csv, .xlsx or .pdf file."
        )
    return normalize_rows(headers, rows)


def template_csv() -> str:
    """Return a CSV template string with the canonical headers and an example."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(TEMPLATE_HEADERS)
    writer.writerow(["Resistor 10k", "R10K", "each", "Passives",
                     "1/4W 5% carbon film", "0.05", "USD", "1000"])
    return buf.getvalue()
