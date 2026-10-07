import type { Server as HttpServer } from 'http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db/prisma';
import { logger } from '../lib/logger';
import { limits } from '../lib/rateLimit';
import { verifyChatToken } from '../auth/tokens';
import { hub, REMOVED_REASON } from './hub';
import { getPinned } from '../features/restStop';
import { getProgress } from '../features/progress';
import { currentGame, submitGuess } from '../features/etaGame';
import { blockedSeats, isMuted, muteNote, reportMessage, reportPerson, setBlock } from '../features/moderationService';
import { tracker } from '../tracking/gpsProvider';
import { makeMove, startGame } from '../features/miniGames';
import { notifyCare } from '../features/careMentions';
import { tripInfo } from '../features/tripInfo';
import { platformBridge } from '../platform/bridge';
import { createQrInvite, JoinError } from '../features/journeyService';
import { haversineKm } from '../lib/geo';
import { checkMessage, BLOCK_REASON_COPY } from '../shared/moderation';
import {
  C2S, S2C, REPORT_REASONS, STICKER_IDS, handleForSeat, roomKey, seatKey,
  type Ack, type BusLocationPayload, type ErrorCode, type LandmarkPayload, type RoomSnapshot, type RoomType,
  POLL_LIMITS, POLL_VOTE_PREFIX, isReactionEmoji, isSystemReactionKey, mentionsIn,
} from '../shared/protocol';

/**
 * ============================================================================
 *  WebSocket gateway
 * ============================================================================
 *  Connection lifecycle
 *   1. Handshake carries the seat-scoped JWT in `auth.token`.
 *   2. Middleware verifies the JWT, then re-reads the seat from MySQL to
 *      confirm it still belongs to that PNR and the journey isn't purged.
 *   3. Socket joins its private seat channel. Chat rooms are joined explicitly
 *      via `room:join`, which is where the women-only gate lives.
 *
 *  Every handler:  validate (zod) -> authorise (room membership / gate)
 *                  -> rate-limit -> moderate -> persist -> fan out -> ack.
 *
 *  Low-bandwidth tuning: websocket-only transport (no long-poll upgrade dance),
 *  16 KB max frame, permessage-deflate above 1 KB, 25s heartbeat.
 * ============================================================================
 */
interface SocketData { journeyId: string; pnr: string; seat: string; handle: string }
type ChatSocket = Socket<any, any, any, SocketData>;

const RoomTypeZ = z.enum(['MAIN_COMMON', 'WOMEN_ONLY']);
const fail = (code: ErrorCode, message: string, meta?: Record<string, unknown>): Ack<never> => ({ ok: false, code, message, meta });
const ok = <T>(data: T): Ack<T> => ({ ok: true, data });

/**
 * Event payload schemas. Built ONCE at module load and shared by every socket:
 * building them inside the connection handler cost ~200 KB of heap per connected socket.
 */
const SendZ = z.discriminatedUnion('contentType', [
  z.object({ roomType: RoomTypeZ, clientMsgId: z.string().min(6).max(64), contentType: z.literal('TEXT'), payload: z.object({ text: z.string().max(2000), ask: z.literal('LOCATION').optional() }) }),
  z.object({ roomType: RoomTypeZ, clientMsgId: z.string().min(6).max(64), contentType: z.literal('STICKER'), payload: z.object({ stickerId: z.string() }) }),
]);
const CoordsZ = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).nullable() });
const MoveZ = z.discriminatedUnion('type', [
  z.object({ type: z.literal('answer'), option: z.number().int().min(0).max(9) }),
  z.object({ type: z.literal('join') }),
  z.object({ type: z.literal('cell'), cell: z.number().int().min(0).max(8) }),
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('roll') }),
  z.object({ type: z.literal('pick'), pick: z.number().int().min(0).max(2) }),
]);
const In = {
  ROOM_JOIN: z.object({ roomType: RoomTypeZ, since: z.string().datetime().optional() }),
  ROOM_LEAVE: z.object({ roomType: RoomTypeZ }),
  ROOM_HISTORY: z.object({ roomType: RoomTypeZ, before: z.string().datetime() }),
  LOCATION_SHARE: z.object({
    roomType: RoomTypeZ, clientMsgId: z.string().min(6).max(64), coords: CoordsZ.optional(),
    live: z.object({ minutes: z.union([z.literal(10), z.literal(15), z.literal(20)]) }).optional(),
  }),
  LOCATION_UPDATE: z.object({ messageId: z.string().uuid(), coords: CoordsZ }),
  LOCATION_STOP: z.object({ messageId: z.string().uuid() }),
  LANDMARK_SHARE: z.object({ roomType: RoomTypeZ, clientMsgId: z.string().min(6).max(64), landmarkId: z.string().max(64) }),
  MSG_SEEN: z.object({ roomType: RoomTypeZ, messageIds: z.array(z.string().uuid()).min(1).max(100) }),
  MSG_REACT: z.object({ messageId: z.string().uuid(), emoji: z.string().max(16).refine(isReactionEmoji) }),
  POLL_CREATE: z.object({
    roomType: RoomTypeZ, clientMsgId: z.string().min(6).max(64),
    question: z.string().max(POLL_LIMITS.questionMax), multi: z.boolean(),
    options: z.array(z.string().max(POLL_LIMITS.optionMax)).min(POLL_LIMITS.minOptions).max(POLL_LIMITS.maxOptions),
  }),
  QR_CREATE: z.object({ coords: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }) }),
  GAME_START: z.object({ roomType: RoomTypeZ, clientMsgId: z.string().min(6).max(64), kind: z.enum(['QUIZ', 'EMOJI', 'TTT', 'SNL', 'RPS']), pick: z.number().int().min(0).max(2).optional() }),
  GAME_MOVE: z.object({ messageId: z.string().uuid(), move: MoveZ }),
  POLL_VOTE: z.object({ messageId: z.string().uuid(), options: z.array(z.number().int().min(0).max(POLL_LIMITS.maxOptions - 1)).max(POLL_LIMITS.maxOptions) }),
  MSG_REPORT: z.object({ messageId: z.string().uuid(), reason: z.enum(REPORT_REASONS) }),
  PERSON_REPORT: z.object({ seat: z.string().max(8), roomType: RoomTypeZ, reason: z.enum(REPORT_REASONS) }),
  SEAT_BLOCK: z.object({ seat: z.string().max(6), blocked: z.boolean() }),
  GAME_GUESS: z.object({ gameId: z.string().uuid(), guessAt: z.string().datetime() }),
  TYPING: z.object({ roomType: RoomTypeZ, isTyping: z.boolean() }),
  TRIP_INFO: z.object({}).passthrough(),
};

export function createSocketServer(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    path: '/ws',
    cors: { origin: config.corsOrigins },
    transports: ['websocket'],
    maxHttpBufferSize: 16 * 1024,
    // Off by default: a zlib context per socket costs ~200 KB of RAM (2 GB per 10k sockets) for chat frames that are mostly < 1 KB.
    perMessageDeflate: config.WS_COMPRESSION ? { threshold: 1024 } : false,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000 }, // tunnels & ghats
  });
  hub.attach(io);

  // ------------------------------------------------------------ auth ------
  io.use(async (socket: ChatSocket, next) => {
    try {
      const claims = verifyChatToken(String(socket.handshake.auth?.token ?? ''));
      // `?jid=` is only a routing hint for the load balancer (journey affinity); it must match the token.
      const jid = socket.handshake.query?.jid;
      if (jid !== undefined && jid !== claims.jid) return next(new Error('UNAUTHORIZED'));
      const [booking, journey] = await Promise.all([
        prisma.passengerBooking.findUnique({ where: { journeyId_seatNumber: { journeyId: claims.jid, seatNumber: claims.seat } } }),
        prisma.busJourney.findUnique({ where: { journeyId: claims.jid } }),
      ]);
      if (!booking || booking.pnrNumber !== claims.pnr) return next(new Error('UNAUTHORIZED'));
      if (!journey || journey.status === 'PURGED') return next(new Error('JOURNEY_CLOSED'));
      const ban = await prisma.seatMute.findUnique({ where: { journeyId_seatNumber: { journeyId: claims.jid, seatNumber: claims.seat } } });
      if (ban?.reason === REMOVED_REASON) return next(new Error('REMOVED'));
      const name = booking.displayName ?? handleForSeat(claims.seat);
      hub.setProfile(claims.jid, claims.seat, { name, avatar: booking.avatarId, guest: booking.channel === 'QR', boardAt: booking.boardingAt?.getTime() ?? null });
      socket.data = { journeyId: claims.jid, pnr: claims.pnr, seat: claims.seat, handle: name };
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: ChatSocket) => {
    const { journeyId, seat, pnr } = socket.data;
    socket.join(seatKey(journeyId, seat));
    const key = (rt: RoomType) => roomKey(journeyId, rt);
    const inRoom = (rt: RoomType) => socket.rooms.has(key(rt));
    const rl = (bucket: keyof typeof limits) => limits[bucket].take(`${journeyId}:${seat}:${bucket}`);

    /** Wraps a handler: zod validation + uniform error acks + crash safety. */
    function on<S extends z.ZodTypeAny>(event: string, schema: S, fn: (input: z.infer<S>) => Promise<Ack<any>>) {
      socket.on(event, async (raw: unknown, ack?: (a: Ack<any>) => void) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        const parsed = schema.safeParse(raw);
        if (!parsed.success) return reply(fail('INVALID', 'Invalid request.'));
        try { reply(await fn(parsed.data)); }
        catch (err) { logger.error({ err, event, journeyId, seat }, 'socket handler failed'); reply(fail('INTERNAL', 'Something went wrong. Try again.')); }
      });
    }

    // ------------------------------------------------------ room:join ----
    on(C2S.ROOM_JOIN, In.ROOM_JOIN, async ({ roomType, since }) => {
      // ============== WOMEN-ONLY SECURITY GATE (server-authoritative) ==============
      // The app hides the toggle for non-female bookings, but a client can be
      // modified. The real gate is here: gender is read from the PNR booking
      // projection on EVERY join, never from the token or the client.
      if (roomType === 'WOMEN_ONLY') {
        const booking = await prisma.passengerBooking.findUnique({ where: { journeyId_seatNumber: { journeyId, seatNumber: seat } }, select: { gender: true } });
        if (booking?.gender !== 'F') {
          logger.warn({ journeyId, seat }, 'SECURITY: blocked women-only room join for non-F booking');
          return fail('FORBIDDEN', 'This room is only for passengers booked as women on this trip.');
        }
      }
      // ===========================================================================

      await hub.roomId(journeyId, roomType);
      await hub.warmProfiles(journeyId);
      socket.join(key(roomType));

      const journey = await prisma.busJourney.findUniqueOrThrow({ where: { journeyId } });
      const page = since
        ? { ...(await hub.loadMessages(journeyId, roomType, { after: new Date(since), limit: 200, viewerSeat: seat })), hasMore: true }
        : await hub.loadMessages(journeyId, roomType, { limit: 50, viewerSeat: seat });
      const progress = await getProgress(journey);

      const snapshot: RoomSnapshot = {
        roomType,
        messages: page.messages,
        hasMore: page.hasMore,
        presence: await hub.presence(journeyId, roomType),
        pinned: await getPinned(journeyId, roomType),
        game: await currentGame(journeyId, { seat }),
        progress,
        landmarks: tracker.getLandmarks(journey, progress?.progress ?? 0),
        muted: await isMuted(journeyId, seat),
        mutedNote: await muteNote(journeyId, seat),
        blockedSeats: await blockedSeats(journeyId, seat),
        serverNow: new Date().toISOString(),
      };
      hub.schedulePresence(journeyId, roomType);
      return ok(snapshot);
    });

    on(C2S.ROOM_LEAVE, In.ROOM_LEAVE, async ({ roomType }) => {
      socket.leave(key(roomType));
      hub.schedulePresence(journeyId, roomType);
      return ok(null);
    });

    on(C2S.ROOM_HISTORY, In.ROOM_HISTORY, async ({ roomType, before }) => {
      if (!inRoom(roomType)) return fail('NOT_IN_ROOM', 'Join the room first.');
      return ok(await hub.loadMessages(journeyId, roomType, { before: new Date(before), limit: 40, viewerSeat: seat }));
    });

    // ---------------------------------------------------- message:send ---
    on(C2S.MSG_SEND, SendZ, async (input) => {
      if (!inRoom(input.roomType)) return fail('NOT_IN_ROOM', 'Join the room first.');
      if (await isMuted(journeyId, seat)) return fail('MUTED', 'You’ve been muted for the rest of this trip.');
      if (!rl('message')) return fail('RATE_LIMITED', 'Slow down a little.');

      let payload: object;
      if (input.contentType === 'TEXT') {
        const verdict = checkMessage(input.payload.text);
        if (!verdict.ok) return fail('BLOCKED_CONTENT', BLOCK_REASON_COPY[verdict.reason], { reason: verdict.reason });
        const mentions = mentionsIn(verdict.text);
        payload = mentions.length ? { text: verdict.text, mentions } : { text: verdict.text };
        // "Where is the bus?" from someone still waiting: name their stop so riders on board can help.
        if (input.payload.ask === 'LOCATION') {
          const b = await prisma.passengerBooking.findUnique({ where: { journeyId_seatNumber: { journeyId, seatNumber: seat } }, select: { boardingName: true, boardingAt: true } });
          const waiting = !!b?.boardingName && (!b.boardingAt || b.boardingAt.getTime() > Date.now() - 10 * 60_000);
          payload = { ...payload, ask: 'LOCATION', waitingAt: waiting ? b!.boardingName : null };
        }
      } else {
        if (!STICKER_IDS.includes(input.payload.stickerId as any)) return fail('INVALID', 'Unknown sticker.');
        payload = { stickerId: input.payload.stickerId };
      }
      const message = await hub.createMessage(journeyId, input.roomType, {
        senderSeat: seat, senderHandle: socket.data.handle, contentType: input.contentType, payload, clientMsgId: input.clientMsgId,
      });
      platformBridge.mirrorMessage(journeyId, seat, input.roomType, message); // Console + support desk (async, never blocks)
      if ((payload as { mentions?: string[] }).mentions?.includes('CARE')) void notifyCare(journeyId, { seat, name: socket.data.handle }, message.id, (payload as { text: string }).text);
      return ok(message);
    });

    // -------------------------------------------------- location:share ---
    // Three kinds, always chosen explicitly on the phone:
    //  - no coords        → bus GPS (the phone sends nothing)
    //  - coords           → one-time snapshot of the passenger's own position
    //  - coords + live    → live sharing for 10/15/20 min; the phone sends
    //                       LOCATION_UPDATE ticks while the app is open, and can stop early.
    // We only add a coarse "near <town>" label and the distance to the bus.
    const passengerFix = async (coords: z.infer<typeof CoordsZ>) => {
      const journey = await prisma.busJourney.findUniqueOrThrow({ where: { journeyId } });
      const pos = await tracker.getPosition(journey);
      return {
        lat: coords.lat, lng: coords.lng, placeLabel: tracker.nearestPlace(journey, coords) ?? 'Shared location', highway: '',
        speedKmph: null, recordedAt: new Date().toISOString(), progress: pos?.progress ?? 0, nextStop: null,
        source: 'PASSENGER' as const, accuracyM: coords.accuracyM != null ? Math.round(coords.accuracyM) : null,
        distanceFromBusM: pos ? Math.round(haversineKm(coords, pos) * 1000) : null,
      };
    };
    on(C2S.LOCATION_SHARE, In.LOCATION_SHARE, async ({ roomType, clientMsgId, coords, live }) => {
      if (!inRoom(roomType)) return fail('NOT_IN_ROOM', 'Join the room first.');
      if (await isMuted(journeyId, seat)) return fail('MUTED', 'You’ve been muted for the rest of this trip.');
      if (!rl('location')) return fail('RATE_LIMITED', 'A location was just shared. Try again in a bit.');
      let payload: BusLocationPayload;
      if (coords) {
        payload = { ...(await passengerFix(coords)), live: live ? { minutes: live.minutes, until: new Date(Date.now() + live.minutes * 60_000).toISOString(), stoppedAt: null } : null };
      } else {
        const journey = await prisma.busJourney.findUniqueOrThrow({ where: { journeyId } });
        const pos = await tracker.getPosition(journey);
        if (!pos) return fail('NOT_FOUND', 'Bus GPS isn’t reporting right now.');
        payload = {
          lat: pos.lat, lng: pos.lng, placeLabel: pos.placeLabel, highway: pos.highway, speedKmph: pos.speedKmph,
          recordedAt: pos.recordedAt.toISOString(), progress: pos.progress, nextStop: pos.nextStop, source: 'BUS',
        };
      }
      const message = await hub.createMessage(journeyId, roomType, { senderSeat: seat, senderHandle: socket.data.handle, contentType: 'BUS_LOCATION', payload, clientMsgId });
      if (payload.live) setTimeout(() => void hub.pushUpdate(message.id), live!.minutes * 60_000 + 500); // flip to "ended" for everyone
      return ok(message);
    });

    /** Live share ticks: sender only, while active; throttled to one per 8s. */
    const liveOwned = async (messageId: string) => {
      const m = await prisma.message.findUnique({ where: { messageId }, include: { room: true } });
      const p = m?.payload as BusLocationPayload | undefined;
      if (!m || m.room.journeyId !== journeyId || m.senderSeat !== seat || p?.source !== 'PASSENGER' || !p.live) return null;
      return { m, p };
    };
    let lastTick = 0;
    on(C2S.LOCATION_UPDATE, In.LOCATION_UPDATE, async ({ messageId, coords }) => {
      if (Date.now() - lastTick < 8000) return ok(null); // drop silently; next tick will carry the newer fix
      const own = await liveOwned(messageId);
      if (!own) return fail('NOT_FOUND', 'Live location not found.');
      if (own.p.live!.stoppedAt || Date.now() >= Date.parse(own.p.live!.until)) return fail('GAME_CLOSED', 'Live location has ended.');
      lastTick = Date.now();
      await prisma.message.update({ where: { messageId }, data: { payload: { ...own.p, ...(await passengerFix(coords)), live: own.p.live } as object } });
      await hub.pushUpdate(messageId);
      return ok(null);
    });
    on(C2S.LOCATION_STOP, In.LOCATION_STOP, async ({ messageId }) => {
      const own = await liveOwned(messageId);
      if (!own) return fail('NOT_FOUND', 'Live location not found.');
      if (!own.p.live!.stoppedAt) {
        await prisma.message.update({ where: { messageId }, data: { payload: { ...own.p, live: { ...own.p.live!, stoppedAt: new Date().toISOString() } } as object } });
        await hub.pushUpdate(messageId);
      }
      return ok(null);
    });

    on(C2S.LANDMARK_SHARE, In.LANDMARK_SHARE, async ({ roomType, clientMsgId, landmarkId }) => {
      if (!inRoom(roomType)) return fail('NOT_IN_ROOM', 'Join the room first.');
      if (await isMuted(journeyId, seat)) return fail('MUTED', 'You’ve been muted for the rest of this trip.');
      if (!rl('message')) return fail('RATE_LIMITED', 'Slow down a little.');
      const journey = await prisma.busJourney.findUniqueOrThrow({ where: { journeyId } });
      const lm = tracker.getLandmarks(journey, 0).find((l) => l.id === landmarkId);
      if (!lm) return fail('NOT_FOUND', 'That pickup point isn’t on this route.');
      const payload: LandmarkPayload = { landmarkId: lm.id, pointName: lm.pointName, title: lm.title, caption: lm.caption, imageUrl: lm.imageUrl };
      return ok(await hub.createMessage(journeyId, roomType, { senderSeat: seat, senderHandle: socket.data.handle, contentType: 'LANDMARK', payload, clientMsgId }));
    });

    // --------------------------------------------------- message:seen ----
    on(C2S.MSG_SEEN, In.MSG_SEEN, async ({ roomType, messageIds }) => {
      if (!inRoom(roomType)) return fail('NOT_IN_ROOM', 'Join the room first.');
      if (!rl('seen')) return ok(null); // silently drop; receipts are best-effort
      const roomId = await hub.roomId(journeyId, roomType);
      const candidates = await prisma.message.findMany({
        where: { messageId: { in: messageIds }, roomId, senderSeat: { not: seat } },
        select: { messageId: true, receipts: { where: { seatNumber: seat }, select: { seatNumber: true } } },
      });
      const fresh = candidates.filter((m) => m.receipts.length === 0).map((m) => m.messageId);
      if (!fresh.length) return ok(null);
      await prisma.readReceipt.createMany({ data: fresh.map((messageId) => ({ messageId, pnrNumber: pnr, seatNumber: seat })), skipDuplicates: true });
      hub.queueReceipts(journeyId, roomType, fresh, seat);
      return ok(null);
    });

    // ------------------------------------------------------- reactions ---
    // One reaction per person per message (WhatsApp/Instagram): same emoji = remove, new emoji = replace.
    on(C2S.MSG_REACT, In.MSG_REACT, async ({ messageId, emoji }) => {
      if (!rl('reaction')) return fail('RATE_LIMITED', 'Slow down a little.');
      const msg = await prisma.message.findUnique({ where: { messageId }, include: { room: true } });
      if (!msg || msg.room.journeyId !== journeyId) return fail('NOT_FOUND', 'Message not found.');
      const roomType = msg.room.roomType as RoomType;
      if (!inRoom(roomType)) return fail('NOT_IN_ROOM', 'Join the room first.');
      const mine = await prisma.messageReaction.findMany({ where: { messageId, seatNumber: seat } });
      const emojiRows = mine.filter((r) => !isSystemReactionKey(r.emoji));
      const had = emojiRows.some((r) => r.emoji === emoji);
      await prisma.$transaction([
        prisma.messageReaction.deleteMany({ where: { messageId, seatNumber: seat, emoji: { in: emojiRows.map((r) => r.emoji) } } }),
        ...(had ? [] : [prisma.messageReaction.create({ data: { messageId, seatNumber: seat, emoji } })]),
      ]);
      await broadcastReactions(roomType, messageId);
      return ok(null);
    });

    const broadcastReactions = (roomType: RoomType, messageId: string) => hub.emitReactions(journeyId, roomType, messageId);

    // ----------------------------------------------------------- polls ---
    // Same content filter as messages: no phone numbers / UPI / links smuggled in options.
    on(C2S.POLL_CREATE, In.POLL_CREATE, async ({ roomType, clientMsgId, question, options, multi }) => {
      if (!inRoom(roomType)) return fail('NOT_IN_ROOM', 'Join the room first.');
      if (await isMuted(journeyId, seat)) return fail('MUTED', 'You’ve been muted for the rest of this trip.');
      if (!rl('message')) return fail('RATE_LIMITED', 'Slow down a little.');
      const texts = [question, ...options].map((t) => t.trim());
      if (texts.some((t) => !t)) return fail('INVALID', 'Fill in the question and every option.');
      if (new Set(texts.slice(1).map((t) => t.toLowerCase())).size !== options.length) return fail('INVALID', 'Options must be different.');
      const clean: string[] = [];
      for (const t of texts) {
        const verdict = checkMessage(t);
        if (!verdict.ok) return fail('BLOCKED_CONTENT', BLOCK_REASON_COPY[verdict.reason], { reason: verdict.reason });
        clean.push(verdict.text);
      }
      const poll = { question: clean[0], options: clean.slice(1), multi };
      return ok(await hub.createMessage(journeyId, roomType, {
        senderSeat: seat, senderHandle: socket.data.handle, contentType: 'TEXT', payload: { text: `📊 Poll: ${poll.question}`, poll }, clientMsgId,
      }));
    });

    // ------------------------------------------------------- QR invite ---
    on(C2S.QR_CREATE, In.QR_CREATE, async ({ coords }) => {
      if (!rl('qr')) return fail('RATE_LIMITED', 'Wait a few seconds and try again.');
      try { return ok(await createQrInvite(journeyId, seat, coords)); }
      catch (e) { if (e instanceof JoinError) return fail(e.code === 'TOO_FAR' ? 'TOO_FAR' : 'INVALID', e.message); throw e; }
    });

    // ------------------------------------------------------ mini games ---
    on(C2S.TRIP_INFO, In.TRIP_INFO, async () => {
      if (!rl('reaction')) return fail('RATE_LIMITED', 'Slow down a little.');
      const info = await tripInfo(journeyId, seat);
      return info ? ok(info) : fail('NOT_FOUND', 'Trip not found.');
    });

    on(C2S.GAME_START, In.GAME_START, async ({ roomType, clientMsgId, kind, pick }) => {
      if (!inRoom(roomType)) return fail('NOT_IN_ROOM', 'Join the room first.');
      if (await isMuted(journeyId, seat)) return fail('MUTED', 'You’ve been muted for the rest of this trip.');
      if (!rl('message')) return fail('RATE_LIMITED', 'Slow down a little.');
      const res = await startGame(journeyId, roomType, seat, kind, clientMsgId, { pick });
      return res.ok ? ok(res.data) : fail(res.code, res.message);
    });

    on(C2S.GAME_MOVE, In.GAME_MOVE, async ({ messageId, move }) => {
      if (!rl('reaction')) return fail('RATE_LIMITED', 'Slow down a little.');
      const res = await makeMove(journeyId, seat, messageId, move, inRoom);
      return res.ok ? ok(null) : fail(res.code, res.message);
    });

    on(C2S.POLL_VOTE, In.POLL_VOTE, async ({ messageId, options }) => {
      if (!rl('reaction')) return fail('RATE_LIMITED', 'Slow down a little.');
      const msg = await prisma.message.findUnique({ where: { messageId }, include: { room: true } });
      const poll = (msg?.payload as any)?.poll as { options: string[]; multi: boolean } | undefined;
      if (!msg || msg.room.journeyId !== journeyId || !poll) return fail('NOT_FOUND', 'Poll not found.');
      const roomType = msg.room.roomType as RoomType;
      if (!inRoom(roomType)) return fail('NOT_IN_ROOM', 'Join the room first.');
      const picked = [...new Set(options)].filter((i) => i < poll.options.length);
      if (!poll.multi && picked.length > 1) return fail('INVALID', 'This poll allows one answer.');
      // Replace this seat's vote atomically: one row per (seat, option), purged with the message.
      await prisma.$transaction([
        prisma.messageReaction.deleteMany({ where: { messageId, seatNumber: seat, emoji: { startsWith: POLL_VOTE_PREFIX } } }),
        prisma.messageReaction.createMany({ data: picked.map((i) => ({ messageId, seatNumber: seat, emoji: `${POLL_VOTE_PREFIX}${i}` })) }),
      ]);
      await broadcastReactions(roomType, messageId);
      return ok(null);
    });

    // ------------------------------------------------- report / block ----
    on(C2S.MSG_REPORT, In.MSG_REPORT, async ({ messageId, reason }) => {
      if (!rl('report')) return fail('RATE_LIMITED', 'You’ve sent several reports. Our team is reviewing them.');
      const res = await reportMessage(journeyId, { pnr, seat }, messageId, reason);
      return res.ok ? ok(null) : fail(res.code, res.code === 'INVALID' ? 'You can’t report this message.' : 'Message not found.');
    });

    on(C2S.PERSON_REPORT, In.PERSON_REPORT, async (input) => {
      if (!inRoom(input.roomType)) return fail('NOT_IN_ROOM', 'Join the room first.');
      if (!rl('report')) return fail('RATE_LIMITED', 'You’ve sent several reports. Our team is reviewing them.');
      const res = await reportPerson(journeyId, { pnr, seat }, input.roomType, input.seat, input.reason);
      return res.ok ? ok(null) : fail(res.code, 'You can’t report yourself.');
    });

    on(C2S.SEAT_BLOCK, In.SEAT_BLOCK, async (input) => {
      if (input.seat === seat) return fail('INVALID', 'You can’t block yourself.');
      return ok(await setBlock(journeyId, seat, input.seat, input.blocked));
    });

    // -------------------------------------------------------- ETA game ---
    on(C2S.GAME_GUESS, In.GAME_GUESS, async ({ gameId, guessAt }) => {
      const res = await submitGuess(journeyId, { pnr, seat }, gameId, new Date(guessAt));
      if (res.ok) return ok(res.data);
      const copy: Record<string, string> = { GAME_CLOSED: 'Guesses are closed for this toll.', ALREADY_GUESSED: 'You’ve already locked in a guess.', INVALID: 'Pick a time later today.', NOT_FOUND: 'This game has ended.' };
      return fail(res.code, copy[res.code]);
    });

    // ---------------------------------------------------------- typing ---
    socket.on(C2S.TYPING, (raw: unknown) => {
      const p = In.TYPING.safeParse(raw);
      if (!p.success || !inRoom(p.data.roomType) || !rl('typing')) return;
      socket.to(key(p.data.roomType)).emit(S2C.TYPING, { roomType: p.data.roomType, seat, isTyping: p.data.isTyping });
    });

    // ------------------------------------------------------ disconnect ---
    socket.on('disconnecting', () => {
      for (const r of socket.rooms) {
        const rt = r.split(':').pop();
        if (r.startsWith('j:') && (rt === 'MAIN_COMMON' || rt === 'WOMEN_ONLY')) setTimeout(() => hub.schedulePresence(journeyId, rt), 0);
      }
    });
  });

  return io;
}
