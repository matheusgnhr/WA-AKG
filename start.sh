#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Installation, database migrations and administrator provisioning are explicit separate operations.
if [ ! -f node_modules/tsx/dist/cli.mjs ]; then
  echo "Dependencies missing: review package-lock.json and run npm ci --ignore-scripts first." >&2
  exit 1
fi
export NODE_ENV="${NODE_ENV:-production}"
exec node node_modules/tsx/dist/cli.mjs src/server/index.ts
