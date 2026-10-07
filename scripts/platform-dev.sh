#!/usr/bin/env bash
# Runs the whole Trip Rooms platform locally:
#   :4100 platform server (APIs, realtime, rules engine, demo simulator)
#   :5180 console (login → Ops / Marketing / Developer / Admin)
#   :8090 hosted chat screen (what AbhiBus / ConfirmTkt / ixigo open in a WebView)
# Uses ONLY the local Docker Postgres database `trip_rooms`. Never touches abrs_new.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker compose up -d postgres >/dev/null
until docker compose exec -T postgres pg_isready -U chat >/dev/null 2>&1; do sleep 1; done
docker compose exec -T postgres psql -U chat -d journey_chat -tc "SELECT 1 FROM pg_database WHERE datname='trip_rooms'" | grep -q 1 \
  || docker compose exec -T postgres psql -U chat -d journey_chat -c "CREATE DATABASE trip_rooms" >/dev/null

(cd platform/server && [ -d node_modules ] || npm install --no-audit --no-fund)
(cd platform/dashboard && [ -d node_modules ] || npm install --no-audit --no-fund)
(cd platform/server && npx prisma db push --skip-generate >/dev/null && npx prisma generate >/dev/null)

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
