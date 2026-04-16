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
  _ORIG_PORT_SET="${PORT+x}"
  _ORIG_PORT="$PORT"
  _ORIG_HOST_SET="${HOST+x}"
  _ORIG_HOST="$HOST"
  _ORIG_DASHBOARD_PASSWORD_SET="${DASHBOARD_PASSWORD+x}"
  _ORIG_DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD"
  _ORIG_DASHBOARD_SECRET_SET="${DASHBOARD_SECRET+x}"
  _ORIG_DASHBOARD_SECRET="$DASHBOARD_SECRET"
  _ORIG_DASHBOARD_SECURE_SET="${DASHBOARD_SECURE+x}"
  _ORIG_DASHBOARD_SECURE="$DASHBOARD_SECURE"
  _ORIG_DASHBOARD_CORS_ORIGINS_SET="${DASHBOARD_CORS_ORIGINS+x}"
  _ORIG_DASHBOARD_CORS_ORIGINS="$DASHBOARD_CORS_ORIGINS"
  _ORIG_DASHBOARD_DB_PATH_SET="${DASHBOARD_DB_PATH+x}"
  _ORIG_DASHBOARD_DB_PATH="$DASHBOARD_DB_PATH"
  _ORIG_DASHBOARD_BACKUP_DIR_SET="${DASHBOARD_BACKUP_DIR+x}"
  _ORIG_DASHBOARD_BACKUP_DIR="$DASHBOARD_BACKUP_DIR"
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
  if [ -n "$_ORIG_PORT_SET" ]; then export PORT="$_ORIG_PORT"; fi
  if [ -n "$_ORIG_HOST_SET" ]; then export HOST="$_ORIG_HOST"; fi
  if [ -n "$_ORIG_DASHBOARD_PASSWORD_SET" ]; then export DASHBOARD_PASSWORD="$_ORIG_DASHBOARD_PASSWORD"; fi
  if [ -n "$_ORIG_DASHBOARD_SECRET_SET" ]; then export DASHBOARD_SECRET="$_ORIG_DASHBOARD_SECRET"; fi
  if [ -n "$_ORIG_DASHBOARD_SECURE_SET" ]; then export DASHBOARD_SECURE="$_ORIG_DASHBOARD_SECURE"; fi
  if [ -n "$_ORIG_DASHBOARD_CORS_ORIGINS_SET" ]; then export DASHBOARD_CORS_ORIGINS="$_ORIG_DASHBOARD_CORS_ORIGINS"; fi
  if [ -n "$_ORIG_DASHBOARD_DB_PATH_SET" ]; then export DASHBOARD_DB_PATH="$_ORIG_DASHBOARD_DB_PATH"; fi
  if [ -n "$_ORIG_DASHBOARD_BACKUP_DIR_SET" ]; then export DASHBOARD_BACKUP_DIR="$_ORIG_DASHBOARD_BACKUP_DIR"; fi
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
echo "  Codex Usage Dashboard"
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
