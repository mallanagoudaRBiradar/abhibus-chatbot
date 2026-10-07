# Journey Chat API: curl reference

Copy-paste requests for the **AbhiBus backend team**. Field rules, error codes and the full flow are in [INTEGRATION.md](INTEGRATION.md).

```bash
export CHAT_URL="http://localhost:4000"          # staging / production URL we give you
export PARTNER_KEY="<x-api-key we give you>"     # server-to-server only, never in the app
```

Every write is **idempotent**. On a timeout or `5xx`, resend the same payload. `journeyId` = `<serviceId>:<journeyDate>` and must be URL-encoded in paths (`45821%3A2026-10-08`).

---

## Primary path: bus-online writes the inbox table (no API calls)

`bus-online` inserts, unchanged, into **`chat_abhibus_inbox`** in `abrs_new`:
- **`BOOKING`**: `application/controllers/ticket.php` → `makeTicketHistory()`, once per confirmed ticket (onward and return separately): the ticket history it just saved (`othInfo`, incl. per-seat `passengerdetails`) + the ticket's `additional_info`.
- **`CANCELLATION`**: `application/controllers/Webservices_App.php` → `ConfirmCancellation()`: the response + the request's `cancel_seats`.

Both go through one method, `pushToChatInbox()` in `application/core/MY_Controller.php`. The chat service reads that table every 3 s and does everything else (rooms, seats, cancellations). Nothing below is needed for that path.

| Column | Value |
|---|---|
| `event_type` | `BOOKING` (makeTicketHistory) or `CANCELLATION` (ConfirmCancellation). `TICKET` (a GetTicketDetails response) is also understood |
| `pnr` | ticket number |
| `cancel_seats` | the request's `cancel_seats` (cancellations only) |
| `payload` | `BOOKING`: `{ ticket_no, journey_type, account_id, othInfo, additional_info }`; `CANCELLATION`: the response JSON, unchanged |
| `created_at`, `processed_at`, `attempts`, `last_error` | set by the database / the chat service |

Check what happened to a ticket: `SELECT id, event_type, processed_at, attempts, last_error FROM chat_abhibus_inbox WHERE pnr = 'DZ…' ORDER BY id;`. Processed rows are cleared at once and deleted after an hour; rows that failed 5 times stay 7 days with `last_error`.

## Alternative: forward the AbhiBus responses over HTTP

The simplest integration: after each AbhiBus call, **POST its JSON response to us unchanged**. We map the fields (`server/src/booking/abhibusAdapter.ts`), so you never maintain a mapping.

| When in AbhiBus | You already have | Send it to |
|---|---|---|
| Ticket **booked** | the `GetTicket` response | `POST /v1/partner/abhibus/ticket` |
| Ticket **modified** (seat change, reschedule, passenger edit) | a fresh `GetTicket` response | `POST /v1/partner/abhibus/ticket` |
| Ticket **cancelled** (all or some seats, incl. "user is not coming") | the `ConfirmCancellation` response + the `cancel_seats` you sent | `POST /v1/partner/abhibus/cancellation` |

```bash
# Booked / modified: the GetTicket response body, unchanged (whole body or just ticketList[0])
curl -sS -X POST "$CHAT_URL/v1/partner/abhibus/ticket" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  --data-binary @getTicket-response.json
```
**200**: `{ "pnr": "DZ5675184138", "status": "CONFIRMED", "journeyId": "2291_7_150:2026-10-08", "seats": ["11U"], "added": 1, "removed": 0 }`

```bash
# Cancelled: the ConfirmCancellation response, plus "cancel_seats" from your request
jq '. + {cancel_seats: "11U"}' cancelTicket-response.json | \
curl -sS -X POST "$CHAT_URL/v1/partner/abhibus/cancellation" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" --data-binary @-
```
**200**: `{ "pnr": "DZ5675184138", "seats": ["11U"], "cancelled": 1 }`. If the response says the cancellation failed: `{ "ignored": true, "reason": "…" }`, and nothing changes.

**What we take from `GetTicket`** (everything else, such as fares, payment, card and email, is ignored):

| Our field | AbhiBus field |
|---|---|
| Bus run (room key) | `api` + `travelerPartnerId` + `ServiceKey` → `2291_7_150`, plus `JourneyDate` (`08-10-2026` → `2026-10-08`). The same id track.abhibus.com uses |
| PNR | `PNR` |
| Live or cancelled | `Status`: starts with "Cancel" = whole PNR cancelled; anything else = live |
| Seats | `SelectedSeats` = the **remaining** seats. A seat that disappears on a later `GetTicket` (partial cancellation) is removed from the room; a ticket first seen as `Cancelled` adds nobody |
| Name + gender per seat | `passengerdetails[]` when filled; else `additional_info.haltEvents.charged.bus_name<i>` / `bus_gender<i>`, matched to seats through the **original** seat order `asf.onw.allPolicies[0].seatNos` (these don't change after a partial cancellation, so seat 16 stays passenger 3 even when 8U is cancelled); `Passenger1..N` only when there is one per seat. Unknown gender = no women-only access |
| Room opens (30/45 min before) | the **earliest `boardingDateTime` among all passengers on that bus**, so it opens before the first person gets on. Recomputed on every booking, cancellation and reschedule |
| Chat deleted (3 h after) | the **latest `droppingDateTime`** among the passengers (or the actual arrival, if later) |
| Boarding point | `bpId`, `Boarding_At`, `Landmark`, `boardingLatLong`, `boardingDateTime` |
| Dropping point | `DP` id, `droppingPlace`, `droppingLatLong`, `droppingDateTime` |
| Contact phone (encrypted, Ops only) | `CustPhoneNumber` |
| Account (ownership check) | `additional_info.accountId` |
| Operator / service label | `Operator_Name` / `Service_Number` |
| Operator helpline (SOS sheet "Call Fresh Bus helpline", SOS webhook) | `busPartnerDetails[]` entry titled "…helpline" |
| Route shown in chat | `From` → `To` |
| GPS tracking id | `trackBusURL` → `service=` value |

The route is built automatically from every passenger's boarding and dropping coordinates, so "near KPHB", progress and pickup cards work without a route API.

The rest of this page is the **generic API** (our own field names). Use it if you'd rather send a clean payload.

---

## When to call what

| Event in AbhiBus | Call |
|---|---|
| Ticket **booked** (confirmed) | [1. Booking confirmed](#1-booking-confirmed) |
| Ticket **modified** (seat change, passenger change, partial cancel) | [2. Booking modified](#2-booking-modified): send the full new state |
| Ticket **cancelled** (all seats) | [3. Booking cancelled](#3-booking-cancelled) |
| Some seats cancelled | [4. Partial cancellation](#4-partial-cancellation) |
| Bus **delayed** / bus swapped / route changed | [6. Journey update](#6-journey-update-delay-bus-swap-route) |
| Bus GPS (every 15–60 s per running bus) | [8. GPS](#8-bus-gps-bulk) |
| Bus arrived / cancelled / crew announcement / rest stop | [9. Trip events](#9-trip-events) |
| Passenger taps **Trip chat** in the app | [10. Chat session](#10-chat-session-app-opens-the-chat) |
| Passenger changed phone (support) | [11. Release seat](#11-release-a-seat-support) |

The room is created automatically **`CHAT_OPEN_BEFORE_START_MIN` (30 or 45) minutes before `startTime`**. There's no call for it. You get a [`room.opened` webhook](#webhooks-we-send-you) when it happens.

---

## 1. Booking confirmed

```bash
curl -sS -X POST "$CHAT_URL/v1/partner/bookings" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  -d '{
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
    "seats": [
      { "seat": "12L", "gender": "F", "name": "Asha" },
      { "seat": "12U", "gender": "M", "name": "Ravi" }
    ],
    "boarding": { "id": "6", "name": "KPHB", "landmark": "Pillar No: A738", "lat": 17.446, "lng": 78.376, "at": "2026-10-08T20:50:00+05:30" },
    "dropping": { "id": "34", "name": "HSR Layout", "lat": 12.9165, "lng": 77.6322, "at": "2026-10-09T11:00:00+05:30" }
  }'
```
**200**
```json
{ "journeyId": "45821:2026-10-08", "seats": ["12L", "12U"], "added": 2, "removed": 0 }
```

- `serviceId` + `journeyDate` is the **unique key of the bus run**. Every PNR on the same bus must send the same pair, or they land in different rooms.
- `customerId`, `mobile`, `busNumber`, `operatorName`, `route`, `seats[].name`, `boarding` and `dropping` are optional. `mobile` and names are **stored encrypted** and shown only to Ops (10b), never to other passengers. Never send ages, emails or payment data.
- `seats[].gender`: `F` / `M` / `O`. It decides who can enter the women-only room.

---

## 2. Booking modified

Send the **complete current state** of the PNR. Here seat `12U` was changed to `14U`:

```bash
curl -sS -X POST "$CHAT_URL/v1/partner/bookings" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  -d '{
    "pnr": "AB7X2K9Q",
    "status": "CONFIRMED",
    "customerId": "u_1029384",
    "journey": {
      "serviceId": "45821", "journeyDate": "2026-10-08",
      "sourceCity": "Hyderabad", "destinationCity": "Bengaluru",
      "startTime": "2026-10-08T21:30:00+05:30", "estimatedEndTime": "2026-10-09T06:00:00+05:30"
    },
    "seats": [
      { "seat": "12L", "gender": "F" },
      { "seat": "14U", "gender": "M" }
    ]
  }'
```
**200**: `{ "journeyId": "45821:2026-10-08", "seats": ["12L","14U"], "added": 1, "removed": 1 }`

A seat that's missing from the list is treated as cancelled. If that passenger was in the chat, they're disconnected.

---

## 3. Booking cancelled

```bash
curl -sS -X POST "$CHAT_URL/v1/partner/bookings/AB7X2K9Q/cancel" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" -d '{}'
```
**200**: `{ "cancelled": 2 }` (seats removed; `0` if nothing was there, which is still a success)

## 4. Partial cancellation

```bash
curl -sS -X POST "$CHAT_URL/v1/partner/bookings/AB7X2K9Q/cancel" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  -d '{ "seats": ["14U"] }'
```
**200**: `{ "cancelled": 1 }`

---

## 5. Bulk / backfill (up to 500 bookings)

Use this at go-live for trips already booked, and to replay after an outage on your side.

```bash
curl -sS -X POST "$CHAT_URL/v1/partner/bookings/batch" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  -d '{
    "bookings": [
      { "pnr": "AB1111AA", "journey": { "serviceId": "45821", "journeyDate": "2026-10-08", "sourceCity": "Hyderabad", "destinationCity": "Bengaluru", "startTime": "2026-10-08T21:30:00+05:30", "estimatedEndTime": "2026-10-09T06:00:00+05:30" }, "seats": [ { "seat": "1L", "gender": "M" } ] },
      { "pnr": "AB2222BB", "journey": { "serviceId": "45821", "journeyDate": "2026-10-08", "sourceCity": "Hyderabad", "destinationCity": "Bengaluru", "startTime": "2026-10-08T21:30:00+05:30", "estimatedEndTime": "2026-10-09T06:00:00+05:30" }, "seats": [ { "seat": "2L", "gender": "F" } ] }
    ]
  }'
```
**200**: each item succeeds or fails on its own.
```json
{ "results": [ { "ok": true, "pnr": "AB1111AA", "journeyId": "45821:2026-10-08", "seats": ["1L"], "added": 1, "removed": 0 },
               { "ok": true, "pnr": "AB2222BB", "journeyId": "45821:2026-10-08", "seats": ["2L"], "added": 1, "removed": 0 } ],
  "failed": 0 }
```

---

## 6. Journey update (delay, bus swap, route)

```bash
curl -sS -X POST "$CHAT_URL/v1/partner/journeys" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  -d '{
    "serviceId": "45821", "journeyDate": "2026-10-08",
    "busNumber": "TS09UB9999", "operatorName": "Orange Travels",
    "sourceCity": "Hyderabad", "destinationCity": "Bengaluru",
    "startTime": "2026-10-08T22:15:00+05:30",
    "estimatedEndTime": "2026-10-09T06:45:00+05:30"
  }'
```
**200**: `{ "journeyId": "45821:2026-10-08", "status": "SCHEDULED" }`

This sets the times **explicitly**: from then on, bookings no longer move them (normally the start follows the earliest boarding passenger). Use it for delays. Leaving `route` out keeps the existing route; `"route": null` clears it. Optional: `"operatorHelpline": "9676266294"`.

## 7. Journey status

```bash
curl -sS "$CHAT_URL/v1/partner/journeys/45821%3A2026-10-08" -H "x-api-key: $PARTNER_KEY"
```
**200**
```json
{ "journeyId": "2291_7_150:2026-10-08", "status": "SCHEDULED",
  "startTime": "2026-10-08T15:05:00.000Z", "estimatedEndTime": "2026-10-09T05:30:00.000Z",
  "opensAt": "2026-10-08T14:35:00.000Z", "roomsOpenedAt": null, "closesAt": "2026-10-09T07:30:00.000Z",
  "lastFixAt": null, "seatsBooked": 3, "seatsJoined": 0,
  "operatorName": "Fresh Bus", "operatorHelpline": "9676266294",
  "scheduleSource": "bookings", "routeSource": "bookings", "routeStops": 3, "trackingRef": "MjI5MV83XzE1MA_20261008",
  "firstBoarding": { "name": "Ameerpet", "landmark": "Metro pillar 1102", "at": "2026-10-08T15:05:00.000Z", "seats": 1, "bookings": 1 },
  "boardingPoints": [ { "name": "Ameerpet", "at": "…", "seats": 1, "bookings": 1 }, { "name": "KPHB", "at": "…", "seats": 2, "bookings": 1 } ],
  "droppingPoints": [ { "name": "HSR Layout", "at": "…", "seats": 3, "bookings": 2 } ] }
```
Times in responses are UTC. `status`: `SCHEDULED` → `IN_TRANSIT` → `ARRIVED` → `PURGED`.
`firstBoarding` is the earliest pickup on the bus; the room opens `CHAT_OPEN_BEFORE_START_MIN` before it (`opensAt`).
`scheduleSource: "bookings"` means the times follow the passengers. It becomes `"partner"` once you send a journey update (section 6), after which bookings no longer move the times.

---

## 8. Bus GPS (bulk)

Up to 2,000 fixes per call. Send them for buses whose room is open (from `opensAt` until arrival).

```bash
curl -sS -X POST "$CHAT_URL/v1/partner/locations" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  -d '{
    "fixes": [
      { "journeyId": "45821:2026-10-08", "lat": 15.8281, "lng": 78.0373, "speedKmph": 64, "recordedAt": "2026-10-08T23:41:10+05:30" }
    ]
  }'
```
**200**: `{ "updated": 1 }` (fixes older than the last stored one are skipped and not counted)

---

## 9. Trip events

`POST /v1/partner/journeys/{journeyId}/events`. These work once the room is open (except `CANCELLED`, which works any time).

```bash
# Crew announcement in every room on the bus
curl -sS -X POST "$CHAT_URL/v1/partner/journeys/45821%3A2026-10-08/events" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  -d '{ "type": "ANNOUNCEMENT", "text": "Dinner stop in 20 minutes" }'

# Rest stop: pinned countdown on every phone
curl -sS -X POST "$CHAT_URL/v1/partner/journeys/45821%3A2026-10-08/events" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  -d '{ "type": "REST_STOP", "label": "Dinner stop", "durationMin": 15, "place": "Hotel Highway Treat, Kurnool" }'

# End the rest stop early
curl -sS -X POST "$CHAT_URL/v1/partner/journeys/45821%3A2026-10-08/events" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  -d '{ "type": "REST_STOP_END" }'

# Bus arrived (also detected automatically from GPS / timetable)
curl -sS -X POST "$CHAT_URL/v1/partner/journeys/45821%3A2026-10-08/events" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  -d '{ "type": "ARRIVED" }'

# Bus run cancelled: passengers are told, the room closes in about 1 minute
curl -sS -X POST "$CHAT_URL/v1/partner/journeys/45821%3A2026-10-08/events" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  -d '{ "type": "CANCELLED" }'
```
**200**: `{ "ok": true }`. `CANCELLED` returns `{ "closingAt": "..." }`. Before the room opens, other events return `409 TRIP_NOT_LIVE`.

---

## 10. Chat session (app opens the chat)

Your backend calls this **after checking the signed-in user owns the PNR**, then returns the response to the app, which passes it into the WebView.

```bash
curl -sS -X POST "$CHAT_URL/v1/partner/chat-sessions" \
  -H "x-api-key: $PARTNER_KEY" -H "content-type: application/json" \
  -d '{
    "pnr": "AB7X2K9Q",
    "seat": "12L",
    "deviceId": "ios-6F1C2D3E-1111-2222-3333-444455556666",
    "customerId": "u_1029384"
  }'
```
**200**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "me": { "seat": "12L", "handle": "Asha", "name": "Asha", "avatar": null, "guest": false, "pnrMasked": "AB7X••Q", "gender": "F" },
  "journey": { "journeyId": "45821:2026-10-08", "busNumber": "TS09UB1234", "operatorName": "Orange Travels",
               "routeName": "Hyderabad to Bengaluru", "sourceCity": "Hyderabad", "destinationCity": "Bengaluru",
               "startTime": "...", "estimatedEndTime": "...", "status": "IN_TRANSIT", "purgeAt": "...", "totalSeatsBooked": 36 },
  "supportPhone": "+91..."
}
```
| Error | Body `code` | Meaning |
|---|---|---|
| 403 | `TRIP_NOT_LIVE` | Room not open yet. `meta.opensAt` says when |
| 404 | `NOT_FOUND` | No active booking for this PNR and seat |
| 409 | `SEAT_CLAIMED` | Seat already open on another phone (see 11) |
| 410 | `JOURNEY_CLOSED` | Chat deleted |
| 403 | `REMOVED` | Removed after reports |
| 400 | `INVALID` | Name must be letters only (max 24), or a bad field |

- `deviceId` must be **stable per app install**: on iOS, `identifierForVendor` saved in the Keychain; on Android, a UUID in secure storage. The seat is bound to it.
- No name or avatar is sent: the chat assigns a random trip name such as "Snoring Hulk" (see `shared/personas.ts`). The response `me.name` / `me.avatar` holds it.

## 10b. Passenger contact (Ops only)

Ops follow-up or SOS call-back: decrypts the passenger's name and booking contact phone for one seat. Every call is logged with the reason and who asked. Uses the **Ops key**, not the partner key.

```bash
curl -sS "$CHAT_URL/v1/ops/journeys/2291_7_150%3A2026-10-08/seats/11U/contact?reason=issue%20follow-up" \
  -H "x-api-key: $OPS_API_KEY" -H "x-ops-user: agent@abhibus.com"
```
**200**: `{ "seat": "11U", "pnr": "DZ…", "name": "…", "phone": "…", "boarding": { "name": "KPHB", "landmark": "…", "at": "…" }, "dropping": { … } }`. Returns `404` once the chat is purged (the data is gone).

## 11. Release a seat (support)

The passenger changed or reinstalled their phone and gets `SEAT_CLAIMED`. After support verifies them:

```bash
curl -sS -X POST "$CHAT_URL/v1/partner/journeys/45821%3A2026-10-08/seats/12L/release" \
  -H "x-api-key: $PARTNER_KEY"
```
**200**: `{ "released": true }`. The old phone is disconnected, and the next chat session for that seat binds the new phone.

---

## 12. Called by the chat (not by the backend)

These are made by the WebView chat with the passenger's chat token. They're listed so you know they exist.

```bash
# Silent SOS: alerts the safety desk (sos.raised webhook) with the bus GPS position
curl -sS -X POST "$CHAT_URL/v1/journey-chat/sos" -H "authorization: Bearer <chat token>"
```
**200**: `{ "incidentId": "…", "placeLabel": "Kurnool", "supportPhone": "+91…", "operatorHelpline": "9676266294", "emergencyNumber": "112" }`. The `sos.raised` webhook also carries `operatorHelpline`.

Realtime chat runs over the WebSocket at `wss://<host>/ws` (see the WebView plan).

## 13. Health

```bash
curl -sS "$CHAT_URL/healthz"                                        # process up
curl -sS "$CHAT_URL/readyz"                                         # ready (DB reachable); load balancer target
curl -sS "$CHAT_URL/metrics" -H "authorization: Bearer <OPS_API_KEY>" # Prometheus metrics (ops only)
```

---

## Errors (all endpoints)

```json
{ "code": "INVALID", "issues": [ { "path": ["journey", "journeyDate"], "message": "YYYY-MM-DD" } ] }
{ "code": "UNAUTHORIZED", "message": "Missing or invalid x-api-key." }
{ "code": "INTERNAL", "message": "Something went wrong. Retry with the same payload." }
```
`400` means fix the payload, don't retry. `401` means a bad key. `5xx` or a timeout means retry with backoff (1s, 5s, 30s).

---

## Webhooks we send you

`POST <your PARTNER_WEBHOOK_URL>`. Reply `2xx` within 5 s and dedupe on `id`. We retry 4 times (1s, 5s, 30s, 2m).

Headers:
```
content-type: application/json
x-journeychat-event: room.opened
x-journeychat-id: 4b0e0b9e-...           (same id on retries)
x-journeychat-signature: t=1791356150,v1=5f2c...  (HMAC-SHA256 of "<t>.<raw body>" with the shared secret)
```

**`room.opened`**: send each passenger the "Your trip chat is open" push.
```json
{ "id": "4b0e0b9e-…", "event": "room.opened", "createdAt": "2026-10-08T15:45:00.120Z",
  "data": { "journeyId": "45821:2026-10-08", "serviceId": "45821", "journeyDate": "2026-10-08", "busNumber": "TS09UB1234",
            "routeName": "Hyderabad to Bengaluru", "startTime": "2026-10-08T16:00:00.000Z", "closesAt": "2026-10-09T02:30:00.000Z",
            "passengers": [ { "pnr": "AB7X2K9Q", "seat": "12L", "customerId": "u_1029384" } ] } }
```
It's sent again with just the new passengers for anyone who books after the room opened.

**`sos.raised`**: page the safety desk (P1).
```json
{ "id": "…", "event": "sos.raised", "createdAt": "…",
  "data": { "type": "JOURNEY_SOS", "incidentId": "2ce78fb5-…", "priority": "P1", "journeyId": "45821:2026-10-08",
            "busNumber": "TS09UB1234", "operator": "Orange Travels", "seat": "12L", "pnr": "AB7X2K9Q",
            "location": { "lat": 15.83, "lng": 78.04, "label": "Kurnool", "at": "…" }, "raisedAt": "…" } }
```

**`journey.closed`**: hide the "Trip chat" entry point.
```json
{ "id": "…", "event": "journey.closed", "createdAt": "…", "data": { "journeyId": "45821:2026-10-08" } }
```

### Verifying the signature

Reject the request if the signature doesn't match or `t` is more than 5 minutes old. Use the **raw** request body, not re-serialised JSON.

**Node.js**
```js
const [t, v1] = req.headers['x-journeychat-signature'].split(',').map((p) => p.split('=')[1]);
const expected = crypto.createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) && Math.abs(Date.now() / 1000 - Number(t)) < 300;
```

**PHP**
```php
[$tPart, $vPart] = explode(',', $_SERVER['HTTP_X_JOURNEYCHAT_SIGNATURE']);
$t = explode('=', $tPart)[1]; $v1 = explode('=', $vPart)[1];
$raw = file_get_contents('php://input');
$ok = hash_equals(hash_hmac('sha256', "$t.$raw", $secret), $v1) && abs(time() - (int)$t) < 300;
```

**Java**
```java
String[] parts = header.split(",");
String t = parts[0].split("=")[1], v1 = parts[1].split("=")[1];
Mac mac = Mac.getInstance("HmacSHA256");
mac.init(new SecretKeySpec(secret.getBytes(UTF_8), "HmacSHA256"));
String expected = HexFormat.of().formatHex(mac.doFinal((t + "." + rawBody).getBytes(UTF_8)));
boolean ok = MessageDigest.isEqual(expected.getBytes(UTF_8), v1.getBytes(UTF_8))
          && Math.abs(Instant.now().getEpochSecond() - Long.parseLong(t)) < 300;
```

### Test your webhook endpoint locally

```bash
SECRET="<webhook secret>"; BODY='{"id":"test-1","event":"journey.closed","createdAt":"2026-10-08T00:00:00Z","data":{"journeyId":"45821:2026-10-08"}}'
T=$(date +%s); SIG=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -sS -X POST "<your webhook URL>" -H "content-type: application/json" \
  -H "x-journeychat-event: journey.closed" -H "x-journeychat-id: test-1" \
  -H "x-journeychat-signature: t=$T,v1=$SIG" -d "$BODY"
```
