# Journey Chat: what to share with each team

## AbhiBus backend team

**Done in `bus-online`:** one shared method `pushToChatInbox()` (`application/core/MY_Controller.php`) and two calls: `ticket.php` `makeTicketHistory()` (BOOKING, once per confirmed ticket) and `Webservices_App.php` `ConfirmCancellation()` (CANCELLATION). They insert into `abrs_new.chat_abhibus_inbox`. No API calls, no keys. They only need to deploy it once the DBA has created the `chat_*` tables.

| Send | Notes |
|---|---|
| [API_CURL.md](API_CURL.md) "Recommended" section | **Simplest path: forward the `GetTicket` and `ConfirmCancellation` responses unchanged** to `/v1/partner/abhibus/ticket` and `/abhibus/cancellation`. We do the mapping |
| [API_CURL.md](API_CURL.md) | Copy-paste curl for booked / modified / cancelled, journey updates, GPS, trip events, chat sessions, seat release, plus webhook samples and signature checks (Node, PHP, Java) |
| [INTEGRATION.md](INTEGRATION.md) Part A | Field rules, error codes, retry rules |
| Base URL per environment | e.g. `https://chat-api.staging.abhibus.com`, `https://chat-api.abhibus.com` |
| `x-api-key` | **Two keys per environment** (`PARTNER_API_KEYS`), shared over a secret manager or vault, never chat/email |
| Webhook signing secret | `PARTNER_WEBHOOK_SECRET`, same channel as the keys |

**What we need back from them**

1. Booking hooks: call us on **book**, **modify** and **cancel**.
2. The **unique key of a bus run**: `serviceId` + `journeyDate`, identical for every PNR on the same physical bus (including API/aggregator bookings).
3. `startTime` / `estimatedEndTime` per run, and how delays are published.
4. Route stops with coordinates (pickup points, rest stops, tolls).
5. A GPS feed per bus, with the bus → `journeyId` mapping.
6. Their webhook URL, and an owner for the "Your trip chat is open" push.
7. The session endpoint the app calls, which checks PNR ownership and then calls our `chat-sessions`.
8. Safety desk contact and phone for `sos.raised` (P1).

## iOS team (Swift) and Android team (React Native)

| Send | Notes |
|---|---|
| [WEBVIEW_PLAN.md](WEBVIEW_PLAN.md) | Bridge contract (§4), native checklist (§5), **Swift and React Native reference code (§5b)**, security rules, test checklist |
| Web chat URL per environment | e.g. `https://chat.staging.abhibus.com`, `https://chat.abhibus.com` |
| **Test harness** | `https://chat.staging.abhibus.com/harness/`: plays the app, logs every bridge message. Their WebView should behave the same way |
| Design assets | Screenshots in `docs/screenshots/`, tokens in `mobile/src/theme/tokens.ts`, for their native "Trip chat" button and push copy |

**What we need back from them**
- A stable per-install `deviceId` (iOS: Keychain; Android: secure storage).
- The capabilities their first release supports (`call`, `openExternal`, `location`, `haptics`, `voice`).
- Minimum OS versions.

## Infra / DevOps

| Send | Notes |
|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Topology, load-balancer `jid` affinity (nginx config), sizing, env checklist, monitoring, runbook |
| `server/Dockerfile` | Chat API image + `--target migrate` image (run once per release) |
| `mobile/Dockerfile.web` | Web chat image (static, nginx). `API_URL` per environment; `ENABLE_HARNESS=true` on staging only |
| `server/.env.example` | Every setting, with comments |
| `server/prisma/sql/abrs_new_chat_tables.sql` | **DBA**: creates the 14 `chat_*` tables in `abrs_new`, plus the grants in DEPLOYMENT.md |
| `server/prisma/sql/abrs_new_chat_tables1.sql` | **DBA**: creates the 23 Ops-console tables (`chat_console_*`) in `abrs_new`. Run after the first file |

**They provide**
- MySQL 8+ (a separate database and user, utf8mb4).
- Two hostnames with TLS: the chat API (e.g. `chat-api.abhibus.com`) and the web chat (e.g. `chat.abhibus.com`).
- Redis 7 (once there are 2+ instances).
- TLS, a load balancer with WebSocket support and `jid` hashing, a secret manager, logs and a metrics scraper.

## Product / legal sign-off

- Room opens **30 or 45 min** before departure (`CHAT_OPEN_BEFORE_START_MIN`).
- Chat and passenger data (and the trip's `chat_abhibus_inbox` rows) are deleted **3 h after the last passenger's drop time** (`CHAT_CLOSE_AFTER_LAST_DROP_MIN`), or 3 h after the actual arrival if the bus is later. SOS records are kept; reported-message snapshots are kept **30 days**.
- The women-only room is gated on the **gender declared at booking**.
- Passenger **name and booking contact phone are stored encrypted**, readable only by Ops through an audited endpoint, and deleted with the chat.

## Never share

- `JWT_SECRET`, `PHONE_HASH_PEPPER`, `PII_ENCRYPTION_KEY`, `OPS_API_KEY`, `CONDUCTOR_API_KEY`, database or Redis passwords.
- The partner API key with the mobile teams. It's server-to-server only.
