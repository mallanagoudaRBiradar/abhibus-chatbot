#!/bin/sh
# Writes the per-environment settings, then starts nginx.
#   API_URL         required  e.g. https://chat-api.abhibus.com   (the journey-chat server)
#   ENABLE_HARNESS  optional  true on staging only: serves /harness/ (WebView test page)
set -eu
HTML=/usr/share/nginx/html

: "${API_URL:?Set API_URL, e.g. https://chat-api.abhibus.com}"
case "$API_URL" in
  http://*|https://*) ;;
  *) echo "API_URL must start with http:// or https://" >&2; exit 1 ;;
esac
# Only a plain origin + optional path: this value is written into a script.
if ! printf '%s' "$API_URL" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$'; then
  echo "API_URL has unexpected characters: $API_URL" >&2; exit 1
fi

API_ORIGIN=$(printf '%s' "$API_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
WS_ORIGIN=$(printf '%s' "$API_ORIGIN" | sed -E 's#^http#ws#')
export API_ORIGIN WS_ORIGIN

printf 'window.__TRIPCHAT_CONFIG__ = {"apiUrl":"%s"};\n' "$API_URL" > "$HTML/config.js"
if [ "${ENABLE_HARNESS:-false}" != "true" ]; then rm -rf "$HTML/harness"; fi

envsubst '${API_ORIGIN} ${WS_ORIGIN}' < /etc/nginx/templates/chat.conf.template > /etc/nginx/conf.d/default.conf
echo "trip chat web: API_URL=$API_URL harness=${ENABLE_HARNESS:-false}"
exec nginx -g 'daemon off;'
