# Trip Rooms platform

Temporary, trip-scoped group rooms that **AbhiBus, ConfirmTkt, ixigo Trains and ixigo Flights** create for a trip, fill with their travellers and open inside their own app. Everything — rooms, chat, safety, location fusion, Tara, polls, games, ads, the consoles — lives here. A tenant app only **calls APIs** and **opens one screen**.

| Piece | Folder | Port | What it is |
|---|---|---|---|
| Platform server | `platform/server` | 4100 | REST API (`/v1`), console API (`/console/v1`), realtime (`/ws`), rules engine, webhooks |
| Console | `platform/dashboard` | 5180 | Sign-in for **Admin, Ops, Support, Marketing, Developer, Viewer** |
| Hosted chat screen | `platform/chat` | 8090 | The traveller screen every app opens in a WebView / iframe |

Data: local MySQL database **`trip_rooms`** only (no Docker). The platform never connects to `abrs_new`.

## Run it

```bash
# once: database + user on your local MySQL 8+
mysql -u root <<'SQL'
CREATE DATABASE trip_rooms CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'trip_rooms'@'localhost' IDENTIFIED BY '<password>';
GRANT ALL PRIVILEGES ON trip_rooms.* TO 'trip_rooms'@'localhost';
SQL
cp platform/server/.env.example platform/server/.env   # set DATABASE_URL and the secrets

./scripts/platform-dev.sh        # applies migrations, then starts server, console and chat screen
```

Then open **http://localhost:5180** and tap a demo account (password `TripRooms@2026`):

| Account | Sees |
|---|---|
| `admin@triprooms.local` | Everything: users & roles, tenants, keys, audit |
| `ops@triprooms.local` | Live rooms, room control, action inbox, bulk broadcast, audit |
| `support@triprooms.local` | Rooms (read) and the action inbox |
| `marketing@triprooms.local` | Campaigns, results, ad rules |
| `developer@triprooms.local` | API reference, sandbox, webhooks, keys, tenant config, event log |
| `viewer@triprooms.local` | Read-only overview |
| `abhibus.ops@triprooms.local` | Ops, but only AbhiBus rooms (tenant-scoped user) |

Re-seed demo data any time: `cd platform/server && npm run seed`. Demo API keys for each app are written to `platform/server/.demo-credentials.json`. Treat that file like a secret, even locally.

## Integrate an app (four calls)

All server-to-server. The client secret never ships in an app.

```text
1. POST /v1/oauth/token                          client_credentials → 1 h tenant token
2. PUT  /v1/rooms/by-key/{trip_key}              create-or-get the trip's room (idempotent)
3. POST /v1/rooms/{room_id}/members              add the traveller (idempotent per external_user_id)
4. POST /v1/rooms/{room_id}/members/{mid}/token  → { token, chat_url }  → open chat_url in the app
```

Then keep the room accurate with `POST /v1/rooms/{id}/trip-events` (delay, breakdown, platform/gate change, landed…) and optionally `POST /v1/rooms/{id}/location/sources` (VTS, running status, flight status). The console's **Developer → Quickstart** has copy-paste code for bus, train and flight; **Try it (sandbox)** runs real calls.

`trip_key` examples: `bus:{operator}:{service}:{date}`, `train:{train_no}:{date}:{coach}`, `flight:{carrier}{no}:{date}`.

### Open the chat screen

`chat_url` is `…/?token=<member token>`. Mint a fresh token each time the user taps **Trip chat**; tokens are room-scoped and never outlive the room.

```tsx
// React Native (AbhiBus, ixigo)
<WebView source={{ uri: chatUrl }} geolocationEnabled onMessage={(e) => handle(JSON.parse(e.nativeEvent.data))} />
```
```kotlin
// Android (ConfirmTkt)
webView.addJavascriptInterface(Bridge(), "TripRoomsHost"); webView.loadUrl(chatUrl)
```
```html
<!-- Web -->
<iframe src="{chat_url}" allow="geolocation; clipboard-write"></iframe>
```

The screen posts these events to the host: `tr:ready`, `tr:unread {count}`, `tr:close` (user tapped back or leave), `tr:token_expired` (mint a new token), `tr:sos`. Brand colour, logo text, features and identity mode (random handles vs profile names) come from the tenant config, so no app ships UI code.

### Webhooks you'll want

Signed with `X-TripRooms-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")`. Reply 2xx within 5 s; retries back off for 24 h. Dedupe on `event.id`.

- `notification.requested`: send the push, SMS or WhatsApp through your own stack.
- `sos.raised`, `wait_request.raised`, `issue.escalated`, `care.mentioned`: route these to your support desk.
- `voucher.claimed`: credit the wallet.
- `member.revealed`: an Ops agent looked up a booking, with a logged reason.

The full list, with payloads, is under **Developer → Webhooks** in the console.

## What the platform enforces (apps can't turn these off)

- No traveller DMs, links or photos.
- Phone numbers, emails and UPI IDs are blocked or masked.
- Reports hide messages; a majority of reports removes the sender.
- SOS is private to Ops.
- Location sharing is opt-in and stops at the drop point.
- Ads never appear during SOS, during a breakdown, or right after an Ops alert. They respect quiet hours and are always labelled.
- Every identity reveal and moderation action lands in the audit log.

## Layout

```
platform/server/src
  http/v1.ts           tenant API          http/console.ts   console API (role + tenant scoped)
  http/chat.ts         chat bootstrap      realtime/socket.ts chat realtime
  core/*               rooms, members, trip events, location fusion, alerts, moderation, Tara, ads, lifecycle
  shared/*             protocol + safety filter (copied to platform/chat by scripts/sync-platform.sh)
platform/dashboard/src pages/{ops,marketing,developer,admin}.tsx
platform/chat/src      screens/TripChatScreen.tsx, components/PlatformCards.tsx, services/host.ts
```
