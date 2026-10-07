#!/usr/bin/env bash
# Runs the whole Trip Rooms platform locally:
#   :4100 platform server (APIs, realtime, rules engine, demo simulator)
#   :5180 console (login → Ops / Marketing / Developer / Admin)
#   :8090 hosted chat screen (what AbhiBus / ConfirmTkt / ixigo open in a WebView)
# Uses ONLY the local MySQL database `trip_rooms` (DATABASE_URL in platform/server/.env). Never touches abrs_new.
# Create it once:  see platform/README.md ("Run it").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ -f platform/server/.env ] || { echo "platform/server/.env missing: copy platform/server/.env.example and set DATABASE_URL (MySQL)"; exit 1; }
(cd platform/server && [ -d node_modules ] || npm install --no-audit --no-fund)
(cd platform/dashboard && [ -d node_modules ] || npm install --no-audit --no-fund)
# Local DB: apply migrations. Demo DB (USE_DEMO_DB=yes): the DBA creates the chat_console_* tables
# with server/prisma/sql/abrs_new_chat_tables1.sql, so only generate the client.
if grep -qE '^USE_DEMO_DB=(yes|true)' platform/server/.env; then
  (cd platform/server && npx prisma generate >/dev/null)
else
  (cd platform/server && npx prisma migrate deploy >/dev/null && npx prisma generate >/dev/null)
fi

trap 'kill 0' EXIT
(cd platform/server && npm run dev) &
(cd platform/dashboard && npx vite --port 5180) &
(cd platform/chat && EXPO_PUBLIC_API_URL=http://localhost:4100 npx expo start --web --port 8090) &
sleep 8
echo ""
echo "  Console      http://localhost:5180   (admin@triprooms.local / TripRooms@2026 — or tap a demo account)"
echo "  Chat screen  opens from Console → Operations → any room (live traveller view)"
echo "  API          http://localhost:4100/v1   docs: Console → Developer → API reference"
echo ""
wait
