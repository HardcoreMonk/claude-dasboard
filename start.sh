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

# Load .env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

source "$VENV/bin/activate"

# Build JS bundle if node is available
if command -v node &>/dev/null && [ -f "$SCRIPT_DIR/package.json" ]; then
  echo "📦 JS 번들 빌드 중..."
  (cd "$SCRIPT_DIR" && npm run build --silent 2>&1) || echo "⚠️  JS 빌드 실패 — 개별 파일 모드로 계속"
fi

# Install or upgrade dependencies
echo "📦 의존성 확인 중..."
pip install -q -r requirements.txt

PORT="${PORT:-8617}"
HOST="${HOST:-0.0.0.0}"

AUTH_STATUS="OFF"
if [ -n "$DASHBOARD_PASSWORD" ]; then
  AUTH_STATUS="ON (login required)"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "  Claude Usage Dashboard"
echo "  http://localhost:${PORT}"
echo "  Auth: ${AUTH_STATUS}"
echo "═══════════════════════════════════════════"
echo ""

exec uvicorn main:app \
  --host "$HOST" \
  --port "$PORT" \
  --loop asyncio \
  --http h11 \
  --log-level info
