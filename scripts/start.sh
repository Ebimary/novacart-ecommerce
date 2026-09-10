#!/usr/bin/env bash
# Start the private dev MariaDB (if needed) then launch the app.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
bash scripts/dev-db.sh start
exec node server.js