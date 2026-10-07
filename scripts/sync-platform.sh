#!/usr/bin/env bash
# The hosted chat screen shares the realtime contract + safety filter with the platform server.
set -euo pipefail
cd "$(dirname "$0")/../platform"
for f in protocol moderation; do
  { echo "// COPY of platform/server/src/shared/$f.ts — keep in sync (scripts/sync-platform.sh)."; cat "server/src/shared/$f.ts"; } > "chat/src/shared/$f.ts"
done
echo "synced protocol.ts + moderation.ts → platform/chat"
