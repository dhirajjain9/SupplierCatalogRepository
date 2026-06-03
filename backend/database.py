"""Database engine, session management and base model declaration."""
from __future__ import annotations

import os
from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Session

# The database URL can be overridden (e.g. for tests). Defaults to a SQLite
# file stored alongside the application data.
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB_PATH = os.path.join(BASE_DIR, "data", "catalog.db")
DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DEFAULT_DB_PATH}")

# check_same_thread is required for SQLite when used with FastAPI's threadpool.
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args, future=True)
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
        if "catalog_items" in tables:
            cols = {c["name"] for c in inspector.get_columns("catalog_items")}
            if "attributes" not in cols:
                conn.execute(text("ALTER TABLE catalog_items ADD COLUMN attributes JSON"))
        if "documents" in tables:
            cols = {c["name"] for c in inspector.get_columns("documents")}
            if "kind" not in cols:
                conn.execute(text(
                    "ALTER TABLE documents ADD COLUMN kind VARCHAR(20) "
                    "NOT NULL DEFAULT 'document'"
                ))
