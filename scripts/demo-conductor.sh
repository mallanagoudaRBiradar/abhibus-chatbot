#!/usr/bin/env bash
# Plays the conductor / ops side of the demo against a local server.
# Usage: ./scripts/demo-conductor.sh <command>
#   rest   — start a 15-min dinner stop      end   — end the stop now
#   say    — conductor announcement          game  — start toll ETA game
#   arrive — mark bus arrived (starts 2h auto-delete)
set -euo pipefail
API=${API:-http://localhost:4000}
CK=${CONDUCTOR_API_KEY:?export CONDUCTOR_API_KEY from server/.env}
OK=${OPS_API_KEY:?export OPS_API_KEY from server/.env}
JID=${JOURNEY_ID:-"DEMO-HYD-BLR-2245:$(date -u -d '-3 hours' +%F 2>/dev/null || date -u -v-3H +%F)"}
J=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$JID")
case "${1:-}" in
  rest)   curl -s -XPOST "$API/v1/conductor/journeys/$J/rest-stop" -H "x-api-key: $CK" -H 'content-type: application/json' -d '{"label":"Dinner stop","durationMin":15,"place":"Hotel Highway Treat, Kurnool"}' ;;
  end)    curl -s -XPOST "$API/v1/conductor/journeys/$J/rest-stop/end" -H "x-api-key: $CK" ;;
  say)    curl -s -XPOST "$API/v1/conductor/journeys/$J/announce" -H "x-api-key: $CK" -H 'content-type: application/json' -d "{\"text\":\"${2:-We will reach Anantapur in 40 minutes.}\"}" ;;
  game)   curl -s -XPOST "$API/v1/ops/journeys/$J/eta-game" -H "x-api-key: $OK" ;;
  arrive) curl -s -XPOST "$API/v1/conductor/journeys/$J/arrived" -H "x-api-key: $CK" ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
echo
