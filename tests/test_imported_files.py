"""The 'already imported' memory (Drive picker dedupe)."""


def test_drive_imported_starts_empty_and_is_listable(client):
    r = client.get("/api/drive/imported")
    assert r.status_code == 200
    assert r.json() == []


def test_remember_imported_records_and_dedupes():
    # Self-contained DB so we exercise the recorder the import path uses.
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from backend import models
    from backend.database import Base
    from backend.routers import google as g

    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    Session = sessionmaker(bind=eng)
    with Session() as db:
        g._remember_imported(db, "drive-file-1", "Acme.xlsx", 12)
        g._remember_imported(db, "drive-file-1", "Acme.xlsx", 15)  # re-import → update, not a dup
        g._remember_imported(db, None, "skipped.csv", 5)           # no id → ignored
        db.commit()
        rows = db.query(models.ImportedFile).all()
        assert len(rows) == 1
        assert rows[0].file_id == "drive-file-1" and rows[0].rows == 15
