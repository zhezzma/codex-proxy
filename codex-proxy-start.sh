#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -f ./.env ]; then
  set -a
  source ./.env
  set +a
fi

# Ignore generic, easily-polluted env names from the parent shell/PM2 daemon.
unset DATA_DIR

exec node dist/index.js
