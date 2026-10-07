# Journey Chat: deployment and operations

For whoever runs the service in production (infra and on-call).

## Topology

```
   app WebViews ──▶ web chat (static, nginx: mobile/Dockerfile.web) ──┐ loads the page; the page then connects to ▼
             ┌──────────────── load balancer (TLS) ────────────────┐
  phones ──▶ │  /ws/*   hash($arg_jid)  → same instance per bus     │
  backend ─▶ │  /*      round robin / least-conn                    │
             └──────┬───────────────┬───────────────┬──────────────┘
                    ▼               ▼               ▼
               instance A      instance B      instance C      (stateless containers)
                    └───────┬───────┴───────┬───────┘
                            ▼               ▼
                       MySQL 8+         Redis 7
                     (chat store)       (socket.io fan-out between instances)
```

- **Instances** are identical. Background jobs (room opener, ticker, purge) run on **one** instance at a time through a lease in MySQL (`job_lease`). If that instance dies, another takes over within about 2 minutes, and a graceful shutdown hands over immediately.
- **Redis** carries broadcasts between instances. It's required as soon as there's more than one instance, and holds no durable data.
- **MySQL** holds everything else: the chat tables live in the **shared `abrs_new` database, all prefixed `chat_`**, next to the `ABHI_*` tables (utf8mb4). `bus-online` writes only `chat_abhibus_inbox`; the chat service owns the rest. Journey data is hard-deleted 3 h after the last passenger's drop time, so the database stays small (a day of 2,000 trips is a few hundred thousand short-lived rows).

## Database: chat tables in abrs_new

1. **DBA runs, once each, in this order**, on `abrs_new`:
   - `server/prisma/sql/abrs_new_chat_tables.sql`: the 14 journey-chat tables (`chat_*`)
   - `server/prisma/sql/abrs_new_chat_tables1.sql`: the 23 Ops-console tables (`chat_console_*`). Then load console logins + API keys: `cd platform/server && npm run setup:real` (with `USE_DEMO_DB=yes`).

   Later schema changes ship as new numbered files (`…2.sql`, …), so nothing already applied is run again. On the shared database, prefer this over `prisma migrate deploy`, which would also create an unprefixed `_prisma_migrations` table. Future schema changes ship as new files next to it.
2. **Grants (least privilege):**
   - chat service user: `SELECT, INSERT, UPDATE, DELETE ON abrs_new.chat_*` (one grant per table). It never touches `ABHI_*` or ticket tables.
   - `bus-online`'s existing user: needs `INSERT` on `chat_abhibus_inbox` only.
3. `CHAT_DATABASE_URL=mysql://<chat user>:<pw>@<abrs_new writer endpoint>:3306/abrs_new?connection_limit=20`

**Load on the booking database:** chat writes (messages, receipts, reactions, the inbox) now land on the same Aurora writer as bookings. At the load-test peak (500 msg/s) that is roughly 1–2k small writes/s. Watch writer CPU and commit latency during the pilot. If it ever competes with bookings, the `chat_*` tables can move to their own schema or cluster by changing only `CHAT_DATABASE_URL` (and `bus-online`'s insert connection).

## Local setup (no Docker)

- **MySQL**: your local server. Create `journey_chat` + user (README §1), set `CHAT_DATABASE_URL=mysql://journey_chat:<pw>@127.0.0.1:3306/journey_chat?connection_limit=20`, then run `npx prisma migrate deploy`.
- **Redis**: only to test 2+ instances locally: `brew services start redis`, `REDIS_URL=redis://127.0.0.1:6379`. Leave it empty for a single instance.

## When Redis is needed

| Setup | Redis |
|---|---|
| One server instance (local dev, pilot) | **Not needed.** Leave `REDIS_URL` empty; the `ioredis` / redis-adapter packages are only loaded when it's set |
| 2+ instances (production at 2,000 rooms a day, zero-downtime deploys, surviving a crash) | **Required.** Without it, a message only reaches phones on the same instance as the sender |

One instance handled 10,000 sockets in the load test, so a pilot can run without Redis. Production needs at least 2 instances so a crash or a deploy doesn't take every chat down, and that means Redis.

## Load balancer: journey affinity

Phones connect with `?jid=<journeyId>`. Route `/ws/` by a consistent hash of that parameter, so every phone on one bus reaches the same instance. Chat works without affinity (cross-instance delivery measured at 100%), but with it the per-room game locks and rate limits are exact, and Redis traffic drops.

**nginx**
```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
upstream chat_ws   { hash $arg_jid consistent; server a:4000; server b:4000; server c:4000; }
upstream chat_http { least_conn;              server a:4000; server b:4000; server c:4000; }
server {
  listen 443 ssl http2;
  location /ws/ {
    proxy_pass http://chat_ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;          # > pingInterval (25s) + pingTimeout (20s)
  }
  location / { proxy_pass http://chat_http; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
}
```
**Kubernetes (ingress-nginx):** add the annotation `nginx.ingress.kubernetes.io/upstream-hash-by: "$arg_jid"` on the `/ws` ingress.
**AWS ALB** can't hash on a query parameter. Put nginx or Envoy behind it (or use ingress-nginx). Use `/readyz` as the target health check.

## Sizing

Measured on one instance with the load test (`npm run loadtest`), client and server on the same 10-core laptop, against a local MySQL 9.7:

| Scenario | Result |
|---|---|
| Ingest 2,000 journeys × 36 seats (36,000 bookings, batches of 500) | ~1,000 bookings/s, 0 failures |
| All 2,000 rooms due in the same tick | all opened within one tick |
| 10,000 chat sessions minted | ~6 s, p95 ~40 ms |
| 10,000 sockets connect + join | ~7 s, p95 ~90 ms, 0 errors |
| 500 messages/s for 60 s across 2,000 rooms | ack p50 2 ms, p99 57 ms, fan-out 100% |
| Ticker over 2,000 live journeys | ~350 ms per run (interval 30 s) |
| GPS push for 2,000 buses (one call) | ~140 ms |
| Memory with 10,000 sockets | ~250 MB heap, ~520 MB RSS |
| 2 instances + Redis, each bus split across both | fan-out 100%, every job ran once |

**Recommended start for 2,000 trips a day.** The peak is around 1,500 buses live overnight, which at 30–50% adoption is roughly 15–27k sockets.
- **3 instances × (2 vCPU, 2 GB)**. Each one comfortably carries 10k sockets, and losing one leaves enough headroom.
- **MySQL 8+**: managed (e.g. RDS/Aurora MySQL), 2 vCPU / 8 GB, `max_connections` ≥ 100, utf8mb4. Set `connection_limit=20` in `CHAT_DATABASE_URL` (3 × 20 = 60). Use a **separate database and user** from `abrs_new`; the chat store is write-heavy and short-lived.
- **Redis**: the smallest managed tier (it's only pub/sub). Not needed while you run a single instance.
- Scale out on CPU above 60% or more than 10k sockets per instance (`journeychat_sockets`).

Rerun the load test against **staging** with production-sized databases before launch. The numbers above are from a laptop.

## Configuration checklist (production)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (enables the checks below and a 10 s graceful drain) |
| `BOOKING_SOURCE` / `TRACKING_SOURCE` | `partner` / `push` (boot fails on `mock`) |
| `DEMO_MODE` | `false` (boot fails otherwise) |
| `CORS_ORIGINS` | real origins, **including the web chat** (e.g. `https://chat.abhibus.com`); boot fails on `*` |
| `CHAT_DATABASE_URL` | `mysql://user:pass@host:3306/journey_chat?connection_limit=20` |
| `REDIS_URL` | required when running more than one instance |
| `CHAT_OPEN_BEFORE_START_MIN` | `30` or `45`: when rooms open before departure |
| `JWT_SECRET`, `PHONE_HASH_PEPPER`, `CONDUCTOR_API_KEY`, `OPS_API_KEY` | `openssl rand -hex 32` each, from a secret manager |
| `PARTNER_API_KEYS` | two keys (≥ 32 chars), comma-separated |
| `PARTNER_WEBHOOK_URL`, `PARTNER_WEBHOOK_SECRET` | AbhiBus backend endpoint and secret |
| `APP_AUTH_MODE` | `partner` (recommended) |
| `SUPPORT_WEBHOOK_URL`, `SUPPORT_PHONE` | safety desk |
| `WS_COMPRESSION` | `false` (per-socket zlib costs ~200 KB RAM per socket and adds tail latency) |
| `PLATFORM_*` | **leave unset at launch.** The Trip Rooms bridge mirrors every message to an API capped at 50 req/s and keeps its state per instance. |

## Deploy

```bash
docker build -t journey-chat .                                 # app image
docker build -t journey-chat-migrate --target migrate .        # migrations
docker run --rm -e CHAT_DATABASE_URL=... journey-chat-migrate  # once per release, before the rollout
# then roll the app instances one at a time
```

On `SIGTERM` an instance fails `/readyz` and waits 10 s for the load balancer, then closes. Phones reconnect to another instance and resync with `since`. Give the orchestrator a termination grace period of at least 20 s.

Endpoints: `/healthz` (liveness), `/readyz` (readiness, checks MySQL), `/metrics` (Prometheus; requires `Authorization: Bearer <OPS_API_KEY>`).

## Web chat (the screen inside the app WebViews)

A second, static service: `mobile/Dockerfile.web` (nginx, port 8080, non-root).

```bash
cd mobile
docker build -f Dockerfile.web -t trip-chat-web .
docker run -p 8080:8080 -e API_URL=https://chat-api.abhibus.com trip-chat-web                       # production
docker run -p 8080:8080 -e API_URL=https://chat-api.staging.abhibus.com -e ENABLE_HARNESS=true trip-chat-web   # staging
```

| Setting | Notes |
|---|---|
| `API_URL` | The journey-chat server's public URL. Written to `/config.js` at start-up, and the CSP only allows connections there. One image serves every environment |
| `ENABLE_HARNESS` | `true` on **staging only**: serves `/harness/`, the WebView test page. Removed from the container otherwise |
| Domain | e.g. `chat.abhibus.com` (TLS at the load balancer). Add it to the API's `CORS_ORIGINS` |
| Health | `GET /healthz` |
| Caching | `/_expo/*` and `/assets/*` are content-hashed (`immutable`, 1 year); `/`, `/config.js` and `/harness/*` are `no-cache`. A CDN in front is fine with these headers |
| Size | First open is 710 KB (pre-compressed). The build fails if code uses an icon missing from the subset fonts; run `npm run icons:subset` |

Releases are independent of app store releases: deploy the container, and phones get the new UI the next time they open the chat.

## Monitoring and alerts

| Signal | Alert when |
|---|---|
| `/readyz` failing | any instance for 1 min |
| `journeychat_job_last_run_ms{job="journey-ticker"}` | > 20,000 (ticks are about to overlap). Raise `TICK_CONCURRENCY` or check the DB |
| `journeychat_sockets` (sum) | sudden drop of > 30% (LB or deploy issue) |
| `journeychat_heap_used_bytes` | > 1.2 GB on an instance |
| Logs `level>=50` (`"job failed"`, `"purge failed"`, `"partner webhook failed after retries"`, `"SOS webhook failed"`) | any SOS failure pages someone immediately; otherwise more than 10 in 5 min |
| `job_lease` holder | no row with `expires_at` in the future for 3 min (no leader) |
| Partner side | bookings pushed vs `seatsBooked` from `GET /v1/partner/journeys/:id` (sampled) |

## Runbook

- **"Chat says my seat is open on another phone."** Verify the person, then `POST /v1/partner/journeys/{journeyId}/seats/{seat}/release`.
- **Bus cancelled.** `POST /v1/partner/journeys/{journeyId}/events {"type":"CANCELLED"}`. Passengers are told and the room is purged within about 1 minute.
- **Delay.** Resend the journey with new times (`POST /v1/partner/journeys`). Arrival and purge follow the new times.
- **Room didn't open.** Check `GET /v1/partner/journeys/{id}`. If `startTime` is wrong, resend the journey. Rooms open on the next 30 s tick.
- **Backend outage, bookings missed.** Replay them with `POST /v1/partner/bookings/batch`. It's idempotent.
- **Leader instance died.** Nothing to do. Another instance takes over the jobs within about 2 minutes.
- **Redis down.** Instances keep serving their own sockets, but broadcasts from other instances (ticker progress, conductor events) don't arrive. With journey affinity, chat inside a bus keeps working. Restore Redis.

## Tests to run per release

```bash
cd server
npm run typecheck && npm run test:moderation
BASE=https://staging... PARTNER_KEY=... npm run test:partner     # 13 functional checks
BASE=https://staging... PARTNER_KEY=... JOURNEYS=2000 SOCKETS_PER_JOURNEY=5 npm run loadtest   # staging only, creates data
```
