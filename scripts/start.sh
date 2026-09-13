#!/usr/bin/env bash
# Start the private dev PostgreSQL (if needed) then launch the app.
#
# In production (Render etc.) there is no local database to manage — the
# gitignored scripts/dev-db.sh is not part of a fresh clone and NODE_ENV is
# "production" — so just run the app with the DATABASE_URL from the
# environment. This keeps `npm start` working on any host.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ "${NODE_ENV:-}" = "production" ] || [ ! -f "scripts/dev-db.sh" ]; then
  exec node server.js
fi

bash scripts/dev-db.sh start
exec node server.js