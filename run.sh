#!/usr/bin/env bash
# Convenience launcher for the Supplier Catalog Repository.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"

if ! python3 -c "import fastapi" 2>/dev/null; then
  echo "Installing dependencies..."
  pip install -r requirements.txt
fi

echo "Starting Supplier Catalog Repository on http://127.0.0.1:${PORT}"
exec python3 -m uvicorn backend.main:app --host 0.0.0.0 --port "${PORT}" --reload
