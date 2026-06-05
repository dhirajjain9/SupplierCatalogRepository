"""Tests for the Google Chat integration plumbing (no live Google calls)."""
import contextlib
import io

from backend.services import google


def test_google_status_unconfigured(client, monkeypatch):
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_CLIENT_SECRET", raising=False)
    r = client.get("/api/google/status").json()
    assert r["configured"] is False and r["connected"] is False


def test_connect_requires_config(client, monkeypatch):
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_CLIENT_SECRET", raising=False)
    r = client.get("/api/google/connect", follow_redirects=False)
    assert r.status_code == 400


def test_auth_url_built_when_configured(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid123")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "secret")
    url = google.auth_url("https://app.example/api/google/callback", "state1")
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "client_id=cid123" in url and "chat.spaces.readonly" in url and "state=state1" in url


def test_chat_spaces_requires_connection(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "sec")
    r = client.get("/api/chat/spaces")
    assert r.status_code == 401  # not connected yet


def test_chat_download_requires_connection(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "sec")
    r = client.get("/api/chat/download?filename=x.pdf&resourceName=media/abc")
    assert r.status_code == 401  # not connected yet


class _FakeResp:
    def __init__(self, data, status, headers):
        self._data = data
        self.status = status
        self.headers = headers

    def read(self):
        return self._data


def _patch_download(monkeypatch, resp):
    monkeypatch.setattr(google, "access_token", lambda db: "tok")
    monkeypatch.setattr(google.urllib.request, "urlopen",
                        lambda req, timeout=120: contextlib.nullcontext(resp))


def test_download_range_partial(monkeypatch):
    """When Google honors Range (206), return the chunk and parse the real total."""
    _patch_download(monkeypatch, _FakeResp(b"abc", 206, {"Content-Range": "bytes 0-2/100"}))
    chunk, total = google.download_attachment_range(None, "media/x", None, 0, 3)
    assert chunk == b"abc" and total == 100


def test_download_range_fallback_slices(monkeypatch):
    """When Range is ignored (200, whole file), slice to the requested window."""
    _patch_download(monkeypatch, _FakeResp(b"0123456789", 200, {}))
    chunk, total = google.download_attachment_range(None, "media/x", None, 4, 3)
    assert chunk == b"456" and total == 10
