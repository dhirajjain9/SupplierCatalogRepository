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
    "name": {"name", "product", "product name", "part name", "item", "item name",
             "item description", "product description", "title", "material", "model"},
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
    # 1-based source row number (header is row 1); used to align embedded images.
    source_row: int = 0
    # Verbatim copy of the whole source row, keyed by original header — every
    # column is preserved here, including ones with no typed mapping.
    attributes: dict[str, str] = field(default_factory=dict)

    @property
    def has_price(self) -> bool:
        return self.unit_price is not None


@dataclass
class ImportResult:
    rows: list[ParsedRow] = field(default_factory=list)
    # Non-fatal: the row is still imported, but a value couldn't be typed.
    warnings: list[dict] = field(default_factory=list)  # {"row": int, "warning": str}


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


def _label_headers(headers: list) -> list[str]:
    """Turn the raw header cells into stable, unique, non-empty labels.

    Blank headers become ``Column N`` and duplicates get a numeric suffix so the
    attributes dict never silently collapses two source columns into one.
    """
    labels: list[str] = []
    seen: dict[str, int] = {}
    for idx, h in enumerate(headers):
        base = _clean(h) or f"Column {idx + 1}"
        if base in seen:
            seen[base] += 1
            base = f"{base} ({seen[base]})"
        else:
            seen[base] = 1
        labels.append(base)
    return labels


def normalize_rows(headers: list, raw_rows: list[list]) -> ImportResult:
    """Map headers to canonical fields while preserving every row and column.

    Each non-empty row produces exactly one ``ParsedRow`` whose ``attributes``
    holds the complete original record. Recognized columns are additionally
    parsed into typed fields; values that fail to parse are recorded as warnings
    but never cause the row (or the file) to be dropped. Row numbers in warnings
    are 1-based and count the header as row 1.
    """
    result = ImportResult()
    labels = _label_headers(headers)

    # Column index -> canonical field name (first match wins per field).
    col_map: dict[int, str] = {}
    for idx, h in enumerate(headers):
        canon = canonical_header(h)
        if canon and canon not in col_map.values():
            col_map[idx] = canon

    for offset, raw in enumerate(raw_rows):
        row_no = offset + 2  # +1 for header, +1 for 1-based

        # Full-fidelity capture of every column in this row.
        attributes: dict[str, str] = {}
        for idx, label in enumerate(labels):
            cell = _clean(raw[idx]) if idx < len(raw) else None
            if cell is not None:
                attributes[label] = cell
        # Any extra cells beyond the header count still get captured.
        for idx in range(len(labels), len(raw)):
            cell = _clean(raw[idx])
            if cell is not None:
                attributes[f"Column {idx + 1}"] = cell

        # Skip only rows that are entirely empty.
        if not attributes:
            continue

        # Pull recognized fields by column index.
        values: dict[str, str | None] = {
            field_name: (_clean(raw[idx]) if idx < len(raw) else None)
            for idx, field_name in col_map.items()
        }

        # Name: use the mapped column, else fall back so the row is never lost.
        name = values.get("name")
        if not name:
            name = values.get("sku") or next(iter(attributes.values()))
            if "name" in col_map.values():
                result.warnings.append(
                    {"row": row_no, "warning": f"Missing name; using {name!r}"}
                )

        row = ParsedRow(name=name, attributes=attributes, source_row=row_no)
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
                if price < 0:
                    raise ValueError("negative")
                row.unit_price = price
            except ValueError:
                result.warnings.append(
                    {"row": row_no, "warning": f"Unparseable unit_price {price_raw!r}; "
                                               "stored in attributes only"}
                )

        currency = values.get("currency")
        if currency:
            if len(currency) == 3 and currency.isalpha():
                row.currency = currency.upper()
            else:
                result.warnings.append(
                    {"row": row_no, "warning": f"Invalid currency {currency!r}; defaulting to USD"}
                )

        min_qty = values.get("min_quantity")
        if min_qty is not None:
            try:
                qty = int(float(min_qty))
                if qty < 1:
                    raise ValueError("too small")
                row.min_quantity = qty
            except ValueError:
                result.warnings.append(
                    {"row": row_no, "warning": f"Invalid min_quantity {min_qty!r}; defaulting to 1"}
                )

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
