# Journey Chat: integration guide

Copy-paste curl for every call: [API_CURL.md](API_CURL.md). The WebView plan for the apps: [WEBVIEW_PLAN.md](WEBVIEW_PLAN.md).

For the **AbhiBus backend team** (booking push, sessions, webhooks) and the **mobile team** (chat screen in the AbhiBus app).

Journey Chat is an independent service. It never reads the booking database. AbhiBus pushes what it needs, and the app talks to it over one WebSocket.

```
 Booking system ──(1) booking confirmed / changed / cancelled──▶ ┌──────────────┐
 Tracking (VTS) ──(2) bus GPS every 15–60 s ─────────────────────▶ │ Journey Chat │
                                                                   │   service    │
 AbhiBus backend ◀─(3) webhook: room.opened ────────────────────── │              │
       │  sends push "Your trip chat is open" (deep link)          │              │
       │                                                           │              │
 AbhiBus app ──(4) "open trip chat" ─▶ AbhiBus backend             │              │
       │                     └──(5) POST /v1/partner/chat-sessions▶│              │
       │◀──────────────── { token, journey, me } ─────────────────│              │
       └──(6) WebSocket wss://<host>/ws  (token) ─────────────────▶└──────────────┘
```

**Lifecycle of a room.** A booking is pushed (any time before departure) and stored. **30 or 45 min before the earliest passenger boards** (`CHAT_OPEN_BEFORE_START_MIN`) the room opens and a `room.opened` webhook goes out. Passengers chat during the trip. **3 h after the last passenger's drop time** (latest `droppingDateTime`, `CHAT_CLOSE_AFTER_LAST_DROP_MIN`), or 3 h after the actual arrival if the bus is running later, all messages, passenger data and the trip's `chat_abhibus_inbox` rows are hard-deleted and a `journey.closed` webhook goes out. On arrival everyone sees "chat deletes at …".

---

## Part A: AbhiBus backend

> **Simplest path:** forward the `GetTicket` response on booking or modification, and the `ConfirmCancellation` response (plus `cancel_seats`) on cancellation, unchanged. See [API_CURL.md, "Recommended"](API_CURL.md). The sections below describe the generic API with our own field names.

### Authentication

Every `/v1/partner/*` call carries `x-api-key: <key>`. The key is server-to-server only and must never ship in the app. We issue two keys so you can rotate without downtime. Base URL: `https://<journey-chat-host>`.

### Retry rules

- Every write is **idempotent**. On a timeout or a `5xx`, retry with the **same payload** (back off 1s, 5s, 30s).
- `400` means the payload is wrong (the response lists the fields), so don't retry. `401` means a bad key. `404` and `409` are explained in the body (`code`, `message`).

### 1. Booking confirmed or changed: `POST /v1/partner/bookings`

Send it when the booking is confirmed **and again on any change** (seat change, partial cancellation, passenger gender corrected). Always send the **full current state** of the PNR. Seats you leave out are treated as cancelled.

```json
{
  "pnr": "AB7X2K9Q",
  "status": "CONFIRMED",
  "channel": "OWN",
  "customerId": "u_1029384",
  "mobile": "9876543210",
  "journey": {
    "serviceId": "45821",
    "journeyDate": "2026-10-08",
    "busNumber": "TS09UB1234",
    "operatorName": "Orange Travels",
    "sourceCity": "Hyderabad",
    "destinationCity": "Bengaluru",
    "startTime": "2026-10-08T21:30:00+05:30",
    "estimatedEndTime": "2026-10-09T06:00:00+05:30",
    "route": [
      { "name": "Hyderabad (Ameerpet)", "lat": 17.4375, "lng": 78.4483, "kind": "PICKUP", "title": "Opp. Metro pillar 1102" },
      { "name": "Kurnool", "lat": 15.8281, "lng": 78.0373, "kind": "REST" },
      { "name": "Penukonda Toll", "lat": 14.0835, "lng": 77.596, "kind": "TOLL" },
      { "name": "Bengaluru (Madiwala)", "lat": 12.9177, "lng": 77.6238, "kind": "DROP" }
    ]
  },
  "seats": [ { "seat": "12L", "gender": "F" }, { "seat": "12U", "gender": "M" } ]
}
```

| Field | Notes |
|---|---|
| `journey.serviceId` + `journeyDate` | Together they identify **one physical bus run**. Every PNR on that bus must send the same pair, or passengers land in different rooms. Format: `[A-Za-z0-9_-]{1,40}` and `YYYY-MM-DD`. |
| `startTime`, `estimatedEndTime` | ISO 8601 with offset. They drive when the room opens and when it's deleted. Resend them when the schedule changes. |
| `seats[].gender` | `F`/`M`/`O` (also accepts `Female`, `2`, and so on). **This gates the women-only room.** Send what was declared at booking. |
| `customerId` | The AbhiBus account that booked. Optional, but needed for `STRICT_PNR_OWNERSHIP`. |
| `mobile` | Optional. Stored only as an HMAC, never in plain text. |
| `route` | Optional but strongly recommended: up to 200 ordered stops. Without it there's no "near Kurnool" label, no next-stop info, no pickup cards and no toll game, and the bus position comes from the timetable only. `kind`: `PICKUP` shows a pickup card (`title`, `caption`, `imageUrl`), and `TOLL` enables the toll guessing game. |

We **never** want passenger names or ages, so please don't send them.

Response: `{ "journeyId": "45821:2026-10-08", "seats": ["12L","12U"], "added": 2, "removed": 0 }`

**Backfill or catch-up:** `POST /v1/partner/bookings/batch` with `{ "bookings": [ …up to 500… ] }`. Each item succeeds or fails on its own: `{ results: [...], failed: n }`. Use it at go-live (for already-booked trips) and after any outage on your side.

### 2. Booking cancelled: `POST /v1/partner/bookings/{pnr}/cancel`

Body `{}` cancels the whole PNR. `{ "seats": ["12U"] }` cancels just those seats. Anyone on a cancelled seat who's in the chat is disconnected straight away. (Sending the booking with `"status": "CANCELLED"` does the same.)

### 3. Schedule, bus or route change: `POST /v1/partner/journeys`

Send the `journey` object on its own. Use it for delays, a bus swap or a route correction. If a trip's departure is delayed by 2 hours, send this, or the room opens too early.

### 4. Bus GPS: `POST /v1/partner/locations`

```json
{ "fixes": [ { "journeyId": "45821:2026-10-08", "lat": 15.83, "lng": 78.04, "speedKmph": 64, "recordedAt": "2026-10-08T23:41:10+05:30" } ] }
```
Send up to 2,000 fixes per call, every 15–60 s per bus, for buses whose room is open. Fixes that arrive out of order (older than the last one) are ignored. One call for 2,000 buses takes about 80 ms. **SOS alerts carry this location**, so this feed matters for safety and not only for the progress bar.

### 5. Trip events: `POST /v1/partner/journeys/{journeyId}/events`

| Body | Effect |
|---|---|
| `{ "type": "ARRIVED" }` | "You've arrived, chat deletes at …" (also detected automatically from GPS or the timetable) |
| `{ "type": "CANCELLED" }` | Bus run cancelled: passengers are told and the room closes within about 1 minute |
| `{ "type": "ANNOUNCEMENT", "text": "Dinner stop in 20 minutes" }` | Crew announcement in every room on the bus |
| `{ "type": "REST_STOP", "label": "Dinner stop", "durationMin": 15, "place": "Hotel Highway Treat" }` | Pinned countdown that ticks down in sync on every phone |
| `{ "type": "REST_STOP_END" }` | Ends the countdown early |

`journeyId` is `"<serviceId>:<journeyDate>"` and must be URL-encoded (`45821%3A2026-10-08`).

### 6. Opening the chat for a passenger: `POST /v1/partner/chat-sessions`

The app calls **your** backend ("open trip chat for PNR X, seat Y"). You check that the signed-in user owns the PNR, then call:

```json
{ "pnr": "AB7X2K9Q", "seat": "12L", "deviceId": "<stable per-install id from the app>", "customerId": "u_1029384" }
```

Return our response to the app unchanged:

```json
{ "token": "<chat JWT>", "me": { "seat": "12L", "name": "Asha", "gender": "F", ... },
  "journey": { "journeyId": "45821:2026-10-08", "startTime": "...", "purgeAt": "...", ... }, "supportPhone": "..." }
```

| Error | Meaning | What the app shows |
|---|---|---|
| `403 TRIP_NOT_LIVE` | Room not open yet (`meta.opensAt`) | "Trip chat opens at 9:00 PM" |
| `404 NOT_FOUND` | No active booking for that PNR and seat | Generic "couldn't find your trip" |
| `409 SEAT_CLAIMED` | That seat is already in the chat on another phone | "Already open on another phone. Contact support." |
| `410 JOURNEY_CLOSED` | The chat has been deleted | "This trip chat has ended" |
| `403 REMOVED` | Removed after reports from passengers | Show `message` |
| `400 INVALID` | Name failed the filter (letters only, max 24) | Show `message` |

Passengers don't pick a name: the chat gives each one a random trip name and avatar, for example "Snoring Hulk" with a Hulk badge or "Window Seat Baburao" with a 👓 face. The full list is in `shared/personas.ts`. Names never repeat on one bus and stay the same when a passenger rejoins, and women get women heroes and characters. Any `profile` field sent is ignored. Seats are bound to the **first phone** that opens them. That's what stops a co-traveller on a family PNR from taking a woman's seat to get into the women-only room.

**Phone changed or app reinstalled** (`SEAT_CLAIMED` for the real passenger): support verifies the person, then calls `POST /v1/partner/journeys/{journeyId}/seats/{seat}/release`, and the next phone that opens it gets the seat.

### 7. Webhooks we send you

Configured with `PARTNER_WEBHOOK_URL`. Requests are `POST` JSON `{ id, event, createdAt, data }` and retried 4 times (1s, 5s, 30s, 2m). Reply `2xx` quickly and dedupe on `id`.

| `x-journeychat-event` | `data` | What to do |
|---|---|---|
| `room.opened` | `journeyId, busNumber, startTime, closesAt, passengers: [{ pnr, seat, customerId }]` | Push notification to each passenger: "Your trip chat is open", deep-linking into the chat. Also sent for passengers who book after the room opened. |
| `sos.raised` | `incidentId, priority: "P1", journeyId, busNumber, seat, pnr, location, raisedAt` | Page the safety desk. |
| `journey.closed` | `journeyId` | Hide the "Trip chat" entry point. |

**Verify every webhook.** The header is `x-journeychat-signature: t=<unix>,v1=<hex>`, where `v1 = HMAC_SHA256(secret, t + "." + rawBody)`. Reject if `t` is more than 5 minutes old.

```js
const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
const expected = crypto.createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex');
const valid = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) && Math.abs(Date.now() / 1000 - +t) < 300;
```

### 8. Status: `GET /v1/partner/journeys/{journeyId}`

Returns `status, opensAt, roomsOpenedAt, closesAt, lastFixAt, seatsBooked, seatsJoined`. Use it for support tooling and dashboards.

---

## Part B: mobile apps (WebView)

The chat screen is **our hosted web chat** (built and tested, `mobile/Dockerfile.web`), shown in a WebView: `WKWebView` in the iOS app (Swift) and `react-native-webview` in the Android app (React Native). The apps don't implement chat, sockets or moderation. They:

1. Show the **"Trip chat"** entry point on the booking screen from 30 (or 45) min before departure until `journey.purgeAt`, and open it from the `room.opened` push.
2. Ask the AbhiBus backend for a session (Part A §6), passing a **stable `deviceId`** from the app.
3. Open the WebView, inject the session before the page loads, and handle a small bridge (close, call 112/support, voice, location, haptics, share, Android back).

Full details (bridge contract, native checklist per platform, security rules, timeline, test plan) are in **[WEBVIEW_PLAN.md](WEBVIEW_PLAN.md)**.

For reference, the realtime protocol our web chat uses is in [`shared/protocol.ts`](../shared/protocol.ts) (WebSocket at `wss://<host>/ws`, Socket.IO v4). App teams don't need to implement it.

---

## What each side needs to share

**AbhiBus to Journey Chat (before go-live)**
1. A confirmed booking event feed (the trigger and owning team), plus cancellation and modification events.
2. The definition of `serviceId` + `journeyDate`, confirmed to be identical for every PNR on the same physical bus, **including API/aggregator bookings**.
3. Departure and arrival times per service, and how delays are published.
4. Route stops with coordinates per service (pickup points, rest stops, tolls).
5. A GPS feed per bus (VTS), with mapping from bus/vehicle to `journeyId`.
6. The gender values stored at booking, and confirmation that they're passenger-declared.
7. A webhook endpoint URL for `room.opened`, `sos.raised` and `journey.closed`, and an owner for the push notification.
8. Safety desk contacts: who receives `sos.raised` (P1 paging), and the `SUPPORT_PHONE` number.
9. A support tool for seat release (or a manual process that calls the endpoint).
10. Legal sign-off on retention: chat is deleted 3 h after the last passenger's drop time, SOS records are kept, and reported-message snapshots are kept 30 days.

**Journey Chat to the AbhiBus backend team**
- The base URL per environment (staging, production) and two `x-api-key` keys per environment.
- The webhook signing secret.
- This document, plus a staging environment with `npm run test:partner` showing a passing run.

**Journey Chat to the mobile teams (iOS Swift, Android React Native)**
- The web chat URL per environment (staging, production) and the test harness page.
- [WEBVIEW_PLAN.md](WEBVIEW_PLAN.md) with the bridge contract.
- Design assets for their native entry points (the "Night Highway" tokens in `mobile/src/theme/tokens.ts`, screenshots).

**Infra**
- MySQL 8+ (managed), Redis 7 (managed, once there are 2+ instances), a load balancer with WebSocket support and `jid` affinity, TLS certificates, a log sink and a metrics scraper. See [DEPLOYMENT.md](DEPLOYMENT.md).
