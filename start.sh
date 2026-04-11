#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV="$SCRIPT_DIR/.venv"
PYENV_PYTHON="$HOME/.pyenv/versions/3.12.9/bin/python3"

# Create virtualenv if it doesn't exist
if [ ! -d "$VENV" ]; then
  echo "🔧 가상환경 생성 중..."
  if [ -x "$PYENV_PYTHON" ]; then
    "$PYENV_PYTHON" -m venv "$VENV"
  else
    python3 -m venv "$VENV"
  fi
fi

source "$VENV/bin/activate"

# Install or upgrade dependencies
echo "📦 의존성 확인 중..."
pip install -q -r requirements.txt

PORT="${PORT:-8765}"
HOST="${HOST:-0.0.0.0}"

echo ""
echo "═══════════════════════════════════════════"
echo "  Claude Usage Dashboard"
echo "  http://localhost:${PORT}"
echo "═══════════════════════════════════════════"
echo ""

exec uvicorn main:app \
  --host "$HOST" \
  --port "$PORT" \
  --loop asyncio \
  --http h11 \
  --log-level info
