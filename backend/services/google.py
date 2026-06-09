"""Google OAuth + Google Chat API (single-user owner integration).

Lets the owner connect their Workspace account and pull catalog attachments
straight out of Google Chat spaces/DMs. Uses stdlib urllib (no extra deps).
Tokens are stored in the oauth_tokens table; the access token is refreshed on
demand from the stored refresh token.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from sqlalchemy.orm import Session

from backend import models

PROVIDER = "google_chat"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
CHAT_BASE = "https://chat.googleapis.com/v1"
SCOPES = (
    "openid email "
    "https://www.googleapis.com/auth/chat.spaces.readonly "
    "https://www.googleapis.com/auth/chat.messages.readonly "
    "https://www.googleapis.com/auth/drive.readonly"
)


class NotConfigured(RuntimeError):
    pass


class NotConnected(RuntimeError):
    pass


def is_configured() -> bool:
    return bool(os.environ.get("GOOGLE_CLIENT_ID") and os.environ.get("GOOGLE_CLIENT_SECRET"))


def _creds() -> tuple[str, str]:
    cid, secret = os.environ.get("GOOGLE_CLIENT_ID"), os.environ.get("GOOGLE_CLIENT_SECRET")
    if not (cid and secret):
        raise NotConfigured("Google isn't configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).")
    return cid, secret


def auth_url(redirect_uri: str, state: str) -> str:
    cid, _ = _creds()
    q = urllib.parse.urlencode({
        "client_id": cid, "redirect_uri": redirect_uri, "response_type": "code",
        "scope": SCOPES, "access_type": "offline", "include_granted_scopes": "true",
        "prompt": "consent", "state": state,
    })
    return f"{AUTH_URL}?{q}"


def _post_form(url: str, data: dict) -> dict:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def _get(url: str, token: str, raw: bool = False):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read() if raw else json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")[:600]
        except Exception:
            body = ""
        raise RuntimeError(f"{e.code} {e.reason} — {body}") from None


def exchange_code(code: str, redirect_uri: str, db: Session) -> models.OAuthToken:
    cid, secret = _creds()
    tok = _post_form(TOKEN_URL, {
        "code": code, "client_id": cid, "client_secret": secret,
        "redirect_uri": redirect_uri, "grant_type": "authorization_code",
    })
    email = None
    try:
        email = _get(USERINFO_URL, tok["access_token"]).get("email")
    except Exception:
        pass
    row = db.get(models.OAuthToken, PROVIDER) or models.OAuthToken(provider=PROVIDER)
    row.access_token = tok.get("access_token")
    if tok.get("refresh_token"):
        row.refresh_token = tok["refresh_token"]
    row.expires_at = _dt.datetime.utcnow() + _dt.timedelta(seconds=tok.get("expires_in", 3600) - 60)
    row.email = email
    db.merge(row)
    db.commit()
    return row


def access_token(db: Session) -> str:
    row = db.get(models.OAuthToken, PROVIDER)
    if row is None or not row.refresh_token:
        raise NotConnected("Google Chat isn't connected yet.")
    if row.access_token and row.expires_at and row.expires_at > _dt.datetime.utcnow():
        return row.access_token
    cid, secret = _creds()
    tok = _post_form(TOKEN_URL, {
        "client_id": cid, "client_secret": secret,
        "refresh_token": row.refresh_token, "grant_type": "refresh_token",
    })
    row.access_token = tok.get("access_token")
    row.expires_at = _dt.datetime.utcnow() + _dt.timedelta(seconds=tok.get("expires_in", 3600) - 60)
    db.commit()
    return row.access_token


def status(db: Session) -> dict:
    row = db.get(models.OAuthToken, PROVIDER)
    return {"configured": is_configured(), "connected": bool(row and row.refresh_token),
            "email": row.email if row else None,
            # Optional default Drive folder (id or share link) for catalog imports.
            "drive_folder": folder_id_from_link(os.environ.get("GOOGLE_DRIVE_FOLDER"))}


def list_spaces(db: Session) -> list[dict]:
    tok = access_token(db)
    out, page = [], None
    for _ in range(10):
        url = f"{CHAT_BASE}/spaces?pageSize=100" + (f"&pageToken={page}" if page else "")
        data = _get(url, tok)
        for s in data.get("spaces", []):
            out.append({"name": s.get("name"), "displayName": s.get("displayName") or s.get("name"),
                        "type": s.get("spaceType") or s.get("type")})
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def list_attachments(db: Session, space: str, limit: int = 60) -> list[dict]:
    """Recent messages in a space that carry file attachments."""
    tok = access_token(db)
    files, page, scanned = [], None, 0
    while scanned < 400 and len(files) < limit:
        params = {"pageSize": 100, "orderBy": "createTime desc"}
        if page:
            params["pageToken"] = page
        url = f"{CHAT_BASE}/{space}/messages?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        data = _get(url, tok)
        for m in data.get("messages", []):
            scanned += 1
            for att in m.get("attachment", []) or []:
                ref = (att.get("attachmentDataRef") or {}).get("resourceName")
                drive = (att.get("driveDataRef") or {}).get("driveFileId")
                files.append({
                    "message": m.get("name"), "time": m.get("createTime"),
                    "sender": (m.get("sender") or {}).get("displayName"),
                    "filename": att.get("contentName"), "contentType": att.get("contentType"),
                    "resourceName": ref, "driveFileId": drive,
                })
        page = data.get("nextPageToken")
        if not page:
            break
    return files


DRIVE_BASE = "https://www.googleapis.com/drive/v3"
_FOLDER_MIME = "application/vnd.google-apps.folder"


def folder_id_from_link(value: str | None) -> str | None:
    """Accept a Drive folder share link or a bare folder id and return the id."""
    value = (value or "").strip()
    if not value:
        return None
    m = re.search(r"/folders/([a-zA-Z0-9_-]+)", value)
    if m:
        return m.group(1)
    m = re.search(r"[?&]id=([a-zA-Z0-9_-]+)", value)
    if m:
        return m.group(1)
    # Looks like a bare id already.
    return value if re.fullmatch(r"[a-zA-Z0-9_-]{10,}", value) else None


def list_drive_folders(db: Session, limit: int = 200) -> list[dict]:
    """List the user's Drive folders (most-recently-modified first)."""
    tok = access_token(db)
    out, page = [], None
    while len(out) < limit:
        params = {
            "q": f"mimeType='{_FOLDER_MIME}' and trashed=false",
            "fields": "nextPageToken,files(id,name,modifiedTime)",
            "pageSize": 100, "orderBy": "modifiedTime desc",
            "spaces": "drive",
        }
        if page:
            params["pageToken"] = page
        url = f"{DRIVE_BASE}/files?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        data = _get(url, tok)
        for f in data.get("files", []):
            out.append({"id": f.get("id"), "name": f.get("name") or "(untitled)"})
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def list_drive_files(db: Session, folder_id: str, limit: int = 300) -> list[dict]:
    """List the (non-folder) files inside a Drive folder, newest first."""
    tok = access_token(db)
    out, page = [], None
    while len(out) < limit:
        params = {
            "q": f"'{folder_id}' in parents and trashed=false",
            "fields": "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
            "pageSize": 100, "orderBy": "modifiedTime desc",
            "spaces": "drive",
        }
        if page:
            params["pageToken"] = page
        url = f"{DRIVE_BASE}/files?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        data = _get(url, tok)
        for f in data.get("files", []):
            if f.get("mimeType") == _FOLDER_MIME:
                continue
            out.append({
                "driveFileId": f.get("id"), "filename": f.get("name") or "file",
                "contentType": f.get("mimeType"), "time": f.get("modifiedTime"),
                "size": int(f["size"]) if str(f.get("size") or "").isdigit() else None,
                "resourceName": None,
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return out


def _media_url(resource_name: str | None, drive_file_id: str | None) -> str:
    if resource_name:
        return f"{CHAT_BASE}/media/{resource_name}?alt=media"
    if drive_file_id:
        return f"https://www.googleapis.com/drive/v3/files/{drive_file_id}?alt=media"
    raise ValueError("No attachment reference")


def download_attachment(db: Session, resource_name: str | None, drive_file_id: str | None) -> bytes:
    return _get(_media_url(resource_name, drive_file_id), access_token(db), raw=True)


def download_attachment_range(
    db: Session, resource_name: str | None, drive_file_id: str | None,
    offset: int, length: int,
) -> tuple[bytes, int]:
    """Download a byte window [offset, offset+length) of a Chat/Drive attachment.

    Returns (chunk_bytes, total_size). Lets the browser pull large files in small
    slices so no single serverless response exceeds Vercel's size limit. If Google
    ignores the Range header (returns the whole file), we slice it ourselves so the
    response stays small either way.
    """
    url = _media_url(resource_name, drive_file_id)
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {access_token(db)}",
        "Range": f"bytes={offset}-{offset + length - 1}",
    })
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
            content_range = resp.headers.get("Content-Range")  # e.g. "bytes 0-999/12345"
            partial = resp.status == 206
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")[:600]
        except Exception:
            body = ""
        raise RuntimeError(f"{e.code} {e.reason} — {body}") from None
    if partial and content_range and "/" in content_range:
        total = int(content_range.rsplit("/", 1)[-1])
        return data, total
    # Range not honored: `data` is the full file — return just the requested window.
    return data[offset:offset + length], len(data)
