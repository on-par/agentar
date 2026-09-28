#!/usr/bin/env bash
# Start Agentar: the bridge starts and the avatar opens in your browser.
#
# In a checkout of this repo, this installs dependencies and builds when
# needed, then runs `npm start`. Copied anywhere else, it runs the released
# package instead: `npx agentar@0.1.0 start`.
#
# Linux: run `scripts/agentar-start.sh`, or mark it executable and
# double-click it in your file manager. macOS: double-click Agentar.command.
set -euo pipefail

RELEASE="agentar@0.1.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Apps started from Finder or a file manager get a short PATH. Look where
# Homebrew and nvm put Node too.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null
  nvm use --silent 24 >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Agentar needs Node.js 24 or newer. Install it from https://nodejs.org and try again."
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 24 ]; then
  echo "Agentar needs Node.js 24 or newer. You have $(node -v). Install a newer one from https://nodejs.org."
  exit 1
fi

if [ ! -f "$ROOT/package.json" ] || [ ! -d "$ROOT/packages/cli" ]; then
  echo "Starting $RELEASE…"
  exec npx --yes "$RELEASE" start
fi

cd "$ROOT"
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing dependencies (first run only)…"
  npm install
fi
# Build when the output is missing or a source file changed since the last build.
if [ ! -f packages/cli/dist/index.js ] || [ ! -f apps/web/dist/index.html ] ||
  [ -n "$(find packages apps -path '*/node_modules' -prune -o -path '*/src/*' -newer packages/cli/dist/index.js -print -quit)" ]; then
  echo "Building Agentar…"
  npm run build
fi

echo "Starting Agentar. Your browser opens in a moment: click the page once so it may play sound, then use the Talk tab."
echo "Press Ctrl+C (or close this window) to stop."
exec npm start
