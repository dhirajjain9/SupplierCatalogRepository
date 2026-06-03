"""Vercel serverless entrypoint.

Vercel's @vercel/python builder serves the module-level ASGI ``app``. The repo
root is added to ``sys.path`` so the ``backend`` package imports cleanly, and
storage is pointed at the writable ``/tmp`` directory via env vars in
``vercel.json`` (the rest of the filesystem is read-only on Vercel).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.main import app  # noqa: E402  (re-exported for the Vercel runtime)
