"""Database engine, session management and base model declaration."""
from __future__ import annotations

import os
from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Session
from sqlalchemy.pool import NullPool

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _resolve_url() -> str:
    """Pick the database URL.

    Prefers an explicit ``DATABASE_URL`` (or Vercel Postgres' ``POSTGRES_URL``).
    Falls back to a local SQLite file for development/tests. ``postgres://`` and
    ``postgresql://`` are normalized to the psycopg (v3) driver SQLAlchemy expects.
    """
    url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
    if not url:
        # No Postgres configured: use SQLite. On Vercel the only writable path is
        # /tmp (and it's ephemeral), so fall back there to at least boot.
        path = "/tmp/catalog.db" if os.environ.get("VERCEL") else os.path.join(BASE_DIR, "data", "catalog.db")
        return f"sqlite:///{path}"
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


DATABASE_URL = _resolve_url()
_is_sqlite = DATABASE_URL.startswith("sqlite")

# SQLite needs check_same_thread off under FastAPI's threadpool. On Postgres we
# use NullPool so serverless invocations don't reuse stale/cross-instance
# connections, and pre-ping to drop dead ones.
if _is_sqlite:
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False}, future=True)
else:
    engine = create_engine(DATABASE_URL, poolclass=NullPool, pool_pre_ping=True, future=True)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency that yields a database session and closes it after."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create all tables. Safe to call on every startup."""
    # Import models so they are registered on the metadata before create_all.
    from backend import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_columns()


def _ensure_columns() -> None:
    """Tiny additive migration for columns added after a DB was first created.

    create_all() never alters existing tables, so add new nullable columns by
    hand. Keeps older SQLite files working without a full migration tool.
    """
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    with engine.begin() as conn:
        if "suppliers" in tables:
            scols = {c["name"] for c in inspector.get_columns("suppliers")}
            if "type" not in scols:
                conn.execute(text(
                    "ALTER TABLE suppliers ADD COLUMN type VARCHAR(20) NOT NULL DEFAULT 'supplier'"
                ))
        if "catalog_items" in tables:
            cols = {c["name"] for c in inspector.get_columns("catalog_items")}
            if "attributes" not in cols:
                conn.execute(text("ALTER TABLE catalog_items ADD COLUMN attributes JSON"))
            if "master_category" not in cols:
                conn.execute(text("ALTER TABLE catalog_items ADD COLUMN master_category VARCHAR(120)"))
            if "sub_category" not in cols:
                conn.execute(text("ALTER TABLE catalog_items ADD COLUMN sub_category VARCHAR(120)"))
        if "documents" in tables:
            cols = {c["name"] for c in inspector.get_columns("documents")}
            if "kind" not in cols:
                conn.execute(text(
                    "ALTER TABLE documents ADD COLUMN kind VARCHAR(20) "
                    "NOT NULL DEFAULT 'document'"
                ))
            if "data" not in cols:
                blob_type = "BYTEA" if engine.dialect.name == "postgresql" else "BLOB"
                conn.execute(text(f"ALTER TABLE documents ADD COLUMN data {blob_type}"))
            # Relabel image files that were stored as generic documents (so the
            # catalog gallery, which filters on kind='image', picks them up).
            mislabeled = conn.execute(text(
                "SELECT COUNT(*) FROM documents WHERE kind = 'document' "
                "AND content_type LIKE 'image/%'"
            )).scalar()
            if mislabeled:
                conn.execute(text(
                    "UPDATE documents SET kind = 'image' "
                    "WHERE kind = 'document' AND content_type LIKE 'image/%'"
                ))
