"""SQLAlchemy ORM models for the Supplier Catalog Repository.

Entity relationships
--------------------
Supplier  1---*  CatalogItem  1---*  Quote
Supplier  1---*  Document
CatalogItem 1---* Document   (a document may attach to a supplier and/or item)
"""
from __future__ import annotations

from datetime import datetime, date

from sqlalchemy import (
    String,
    Text,
    Integer,
    Float,
    Date,
    DateTime,
    ForeignKey,
    JSON,
    LargeBinary,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.database import Base


class Supplier(Base):
    __tablename__ = "suppliers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    contact_name: Mapped[str | None] = mapped_column(String(200))
    email: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(50))
    address: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(120), index=True)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    catalog_items: Mapped[list["CatalogItem"]] = relationship(
        back_populates="supplier",
        cascade="all, delete-orphan",
    )
    documents: Mapped[list["Document"]] = relationship(
        back_populates="supplier",
        cascade="all, delete-orphan",
    )


class CatalogItem(Base):
    __tablename__ = "catalog_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    supplier_id: Mapped[int] = mapped_column(
        ForeignKey("suppliers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sku: Mapped[str | None] = mapped_column(String(120), index=True)
    name: Mapped[str] = mapped_column(String(300), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text)
    unit: Mapped[str | None] = mapped_column(String(50))
    category: Mapped[str | None] = mapped_column(String(120), index=True)
    # Full fidelity copy of the original imported row: every column from the
    # source file (including ones that don't map to a typed field above) keyed
    # by its original header. Ensures no data from the upload is lost.
    attributes: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    supplier: Mapped["Supplier"] = relationship(back_populates="catalog_items")
    quotes: Mapped[list["Quote"]] = relationship(
        back_populates="catalog_item",
        cascade="all, delete-orphan",
    )
    documents: Mapped[list["Document"]] = relationship(
        back_populates="catalog_item",
        cascade="all, delete-orphan",
    )


class Quote(Base):
    __tablename__ = "quotes"

    id: Mapped[int] = mapped_column(primary_key=True)
    catalog_item_id: Mapped[int] = mapped_column(
        ForeignKey("catalog_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    unit_price: Mapped[float] = mapped_column(Float, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    min_quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    valid_from: Mapped[date | None] = mapped_column(Date)
    valid_until: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    catalog_item: Mapped["CatalogItem"] = relationship(back_populates="quotes")


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    supplier_id: Mapped[int | None] = mapped_column(
        ForeignKey("suppliers.id", ondelete="CASCADE"), index=True
    )
    catalog_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("catalog_items.id", ondelete="CASCADE"), index=True
    )
    filename: Mapped[str] = mapped_column(String(300), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(120))
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    # "document" for generic attachments, "image" for product photos (marketing
    # collateral). Lets the UI show a gallery separately from spec sheets.
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="document", index=True)
    # File bytes are stored in the database so the app is stateless and works on
    # serverless hosts (Vercel) with no local/persistent filesystem. ``stored_name``
    # is retained (nullable) for backwards compatibility with disk-based rows.
    data: Mapped[bytes | None] = mapped_column(LargeBinary)
    stored_name: Mapped[str | None] = mapped_column(String(300))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    supplier: Mapped["Supplier | None"] = relationship(back_populates="documents")
    catalog_item: Mapped["CatalogItem | None"] = relationship(back_populates="documents")
