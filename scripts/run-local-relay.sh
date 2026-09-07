#!/bin/zsh
# Local durable bridge for the GitHub Pages workbench.  Credentials are read
# only from this Mac's Keychain; they never enter the repository or browser.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_ROOT="$PROJECT_ROOT/worker"
VENV="$WORKER_ROOT/.venv"

if [[ ! -x "$VENV/bin/python" ]]; then
  /usr/bin/python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet -r "$WORKER_ROOT/requirements.txt" fastapi 'uvicorn[standard]'
fi

export SEE_THROUGH_API_TOKEN="$(security find-generic-password -a "$USER" -s 'morph-live2d-modelscope-api-token' -w)"
export MORPH_DEVICE_TOKEN="$(security find-generic-password -a "$USER" -s 'morph-live2d-device-token' -w)"
export MORPH_DATA_ROOT="$WORKER_ROOT/.local-state"
export MORPH_ALLOWED_ORIGINS="https://a1m0nd-bao.github.io,http://localhost:4173,http://127.0.0.1:4173"

cd "$WORKER_ROOT"
exec "$VENV/bin/uvicorn" app.main:app --host 127.0.0.1 --port 7861
