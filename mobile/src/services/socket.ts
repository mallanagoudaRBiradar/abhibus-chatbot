import type { GameMoveInput } from '../components/GameCard';
import { uuid } from '../utils/uuid';
import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';
import { useChat, type UiMessage } from '../store/chatStore';
import { checkMessage, BLOCK_REASON_COPY } from '../shared/moderation';
import { host } from './host';
import { saveSession } from './session';
import { type TripInfo,
  C2S, S2C,
  type Ack, type ChatMessage, type EtaGameState, type PresenceState, type ProgressState, type ReactionEmoji,
  type ReportReason, type RoomSnapshot, type RoomType, type StickerId, type PinnedState,
  isPollKey, POLL_VOTE_PREFIX, GAME_MOVE_PREFIX, type PollPayload, type GameKind, type LiveMinutes, type QrInvite,
} from '../shared/protocol';

/**
 * ============================================================================
 *  Realtime client
 * ============================================================================
 *  - websocket-only transport with backoff up to 8s (highway dead zones).
 *  - On every (re)connect: join rooms with `since=<last server message>` so we
 *    only download the gap, then flush the outbox of pending messages.
 *  - Read receipts are collected from the list's viewability callback and
 *    flushed in one batch every 700ms.
 *  - Content is pre-checked locally with the same filter the server runs,
 *    so a blocked phone number is explained instantly, offline or not.
 * ============================================================================
 */
type SendResult = { ok: true } | { ok: false; reason: string };

class ChatSocketService {
  private socket: Socket | null = null;
  private seenQueue = new Map<RoomType, Set<string>>();
  private seenTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTypingSent = 0;

  get connected() { return !!this.socket?.connected; }

  connect() {
    const { session } = useChat.getState();
    if (!session || this.socket) return;
    const store = useChat.getState;
    store().setConnection('connecting');

    const s = io(API_URL, {
      path: '/ws',
      transports: ['websocket'],
      auth: { token: session.token },
      // Lets the load balancer keep every phone on one bus on the same server.
      query: { jid: session.journey.journeyId },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
      timeout: 15_000,
    });
    this.socket = s;

    s.on('connect', async () => {
      store().setConnection('online');
      await this.joinRooms();
      void this.flushOutbox();
    });
    s.on('disconnect', () => store().setConnection('offline'));
    s.on('connect_error', (err) => {
      if (err.message === 'UNAUTHORIZED' && host.embedded) {
        // Inside the app: ask it for a fresh session (it calls chat-sessions again).
        // A new session remounts the chat with a new socket; no answer = chat over.
        this.disconnect();
        store().setConnection('offline');
        host.post('sessionExpired');
        void host.next('session', 10_000).then((fresh) => { if (!fresh) store().setClosed('UNAUTHORIZED'); });
        return;
      }
      if (err.message === 'UNAUTHORIZED' || err.message === 'JOURNEY_CLOSED' || err.message === 'REMOVED') {
        store().setClosed(err.message === 'JOURNEY_CLOSED' ? 'ENDED' : err.message === 'REMOVED' ? 'REMOVED' : 'UNAUTHORIZED');
        this.disconnect();
      } else store().setConnection('offline');
    });

    s.on(S2C.MSG_NEW, (m: ChatMessage) => store().upsertMessage(m));
    s.on(S2C.MSG_UPDATE, (m: ChatMessage) => store().upsertMessage(m)); // game revealed / solved / expired
    s.on(S2C.MSG_REMOVED, ({ roomType, messageId }: { roomType: RoomType; messageId: string }) => store().dropMessage(roomType, messageId));
    s.on(S2C.RECEIPTS, ({ roomType, updates }: { roomType: RoomType; updates: { messageId: string; seats: string[] }[] }) => store().applyReceipts(roomType, updates));
    s.on(S2C.REACTIONS, ({ roomType, messageId, reactions }: { roomType: RoomType; messageId: string; reactions: Record<string, string[]> }) => store().applyReactions(roomType, messageId, reactions));
    s.on(S2C.PRESENCE, (p: PresenceState) => store().setPresence(p));
    s.on(S2C.PINNED, ({ pinned }: { pinned: PinnedState | null }) => {
      // PINNED is emitted per room; resolve which room by message ownership, else apply to both joined rooms.
      const st = store();
      (['MAIN_COMMON', 'WOMEN_ONLY'] as RoomType[]).forEach((rt) => {
        if (!st.rooms[rt].joined) return;
        if (!pinned || st.rooms[rt].messages.some((m) => m.id === pinned.messageId)) st.setPinned(rt, pinned);
      });
    });
    s.on(S2C.GAME, (g: EtaGameState) => store().setGame(g));
    s.on(S2C.PROGRESS, (p: ProgressState) => store().setProgress(p));
    s.on(S2C.TYPING, ({ roomType, seat, isTyping }: { roomType: RoomType; seat: string; isTyping: boolean }) => store().setTyping(roomType, seat, isTyping));
    s.on(S2C.MUTED, ({ reason }: { reason?: string | null }) => store().setMuted(true, reason ?? null));
    s.on(S2C.UNMUTED, () => store().setMuted(false));
    s.on(S2C.REMOVED, ({ reason }: { reason?: string }) => { store().setClosed('REMOVED', reason ?? null); this.disconnect(); });
    s.on(S2C.JOURNEY_ENDING, ({ purgeAt }: { purgeAt: string }) => store().setPurgeAt(purgeAt));
    s.on(S2C.JOURNEY_CLOSED, () => { store().setClosed('ENDED'); this.disconnect(); });
  }

  /** App back in the foreground (WebViews pause timers in the background): reconnect now instead of waiting for backoff. */
  wake() {
    if (this.socket && !this.socket.connected) this.socket.connect();
  }

  disconnect() {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
  }

  private request<T>(event: string, payload: unknown, timeoutMs = 8000): Promise<Ack<T>> {
    const s = this.socket;
    if (!s?.connected) return Promise.resolve({ ok: false, code: 'INTERNAL', message: 'offline' });
    return new Promise((resolve) => {
      s.timeout(timeoutMs).emit(event, payload, (err: Error | null, ack: Ack<T>) =>
        resolve(err ? { ok: false, code: 'INTERNAL', message: 'timeout' } : ack));
    });
  }

  // ---------------------------------------------------------------- rooms --
  private async joinRooms() {
    const st = useChat.getState();
    const rooms: RoomType[] = ['MAIN_COMMON'];
    // UI convenience only: server re-checks booking gender on every join.
    if (st.session?.me.gender === 'F') rooms.push('WOMEN_ONLY');
    await Promise.all(rooms.map(async (roomType) => {
      const room = useChat.getState().rooms[roomType];
      const lastSent = [...room.messages].reverse().find((m) => m.status === 'sent');
      const since = room.joined && lastSent ? lastSent.createdAt : undefined;
      const ack = await this.request<RoomSnapshot>(C2S.ROOM_JOIN, { roomType, since }, 15_000);
      if (ack.ok) {
        useChat.getState().applySnapshot(ack.data, !!since);
        this.adoptIdentity(ack.data.you);
      }
    }));
  }

  /** The server replaced an old-style trip name: show the new name + avatar now, and remember it. */
  private adoptIdentity(you: RoomSnapshot['you']) {
    const s = useChat.getState().session;
    if (!you || !s || (s.me.name === you.name && s.me.avatar === you.avatar)) return;
    const next = { ...s, me: { ...s.me, name: you.name, handle: you.name, avatar: you.avatar } };
    useChat.setState({ session: next });
    if (!host.embedded) void saveSession(next);
  }

  /** Trip panel data (traveller counts, stops, bus position) from the server's DB. */
  tripInfo() { return this.request<TripInfo>(C2S.TRIP_INFO, {}); }

  async loadOlder(roomType: RoomType) {
    const room = useChat.getState().rooms[roomType];
    const oldest = room.messages.find((m) => m.status === 'sent');
    if (!room.hasMore || !oldest) return;
    const ack = await this.request<{ messages: ChatMessage[]; hasMore: boolean }>(C2S.ROOM_HISTORY, { roomType, before: oldest.createdAt });
    if (ack.ok) useChat.getState().prependHistory(roomType, ack.data.messages, ack.data.hasMore);
  }

  // ------------------------------------------------------------- sending --
  private makePending(roomType: RoomType, contentType: UiMessage['contentType'], payload: any): UiMessage {
    const me = useChat.getState().session!.me;
    const clientMsgId = uuid();
    return {
      id: `local-${clientMsgId}`, clientMsgId, roomType, senderSeat: me.seat, senderHandle: me.handle,
      contentType, payload, createdAt: new Date().toISOString(), seenBy: [], reactions: {}, status: 'pending',
    };
  }

  sendText(roomType: RoomType, raw: string, opts: { ask?: 'LOCATION' } = {}): SendResult {
    const verdict = checkMessage(raw);
    if (!verdict.ok) return { ok: false, reason: BLOCK_REASON_COPY[verdict.reason] };
    const msg = this.makePending(roomType, 'TEXT', opts.ask ? { text: verdict.text, ask: opts.ask } : { text: verdict.text });
    useChat.getState().addPending(msg);
    void this.deliver(msg);
    return { ok: true };
  }

  sendSticker(roomType: RoomType, stickerId: StickerId) {
    const msg = this.makePending(roomType, 'STICKER', { stickerId });
    useChat.getState().addPending(msg);
    void this.deliver(msg);
  }

  shareBusLocation(roomType: RoomType) {
    const msg = this.makePending(roomType, 'BUS_LOCATION', null);
    useChat.getState().addPending(msg);
    void this.deliver(msg);
  }

  /** One-time snapshot of the passenger's own position. Only called after they confirm in the location sheet. */
  shareMyLocation(roomType: RoomType, coords: { lat: number; lng: number; accuracyM: number | null }) {
    const msg = this.makePending(roomType, 'BUS_LOCATION', { source: 'PASSENGER', coords });
    useChat.getState().addPending(msg);
    void this.deliver(msg);
  }

  /** Validates locally first (same filter as the server) so a blocked option explains itself instantly. */
  createPoll(roomType: RoomType, poll: PollPayload): { ok: true } | { ok: false; reason: string } {
    const texts = [poll.question, ...poll.options].map((t) => t.trim());
    const clean: string[] = [];
    for (const t of texts) {
      const verdict = checkMessage(t);
      if (!verdict.ok) return { ok: false, reason: BLOCK_REASON_COPY[verdict.reason] };
      clean.push(verdict.text);
    }
    const msg = this.makePending(roomType, 'POLL', { question: clean[0], options: clean.slice(1), multi: poll.multi });
    useChat.getState().addPending(msg);
    void this.deliver(msg);
    return { ok: true };
  }

  /** Sets this seat's poll vote to exactly `options` ([] = retract). Optimistic; reverts if the server says no. */
  async votePoll(m: UiMessage, options: number[]) {
    const st = useChat.getState();
    const seat = st.session!.me.seat;
    const before = m.reactions;
    const next: Record<string, string[]> = {};
    for (const [k, seats] of Object.entries(before)) {
      const kept = isPollKey(k) ? seats.filter((x) => x !== seat) : seats;
      if (kept.length) next[k] = kept;
    }
    for (const i of options) (next[`${POLL_VOTE_PREFIX}${i}`] ??= []).push(seat);
    st.applyReactions(m.roomType, m.id, next);
    const ack = await this.request<null>(C2S.POLL_VOTE, { messageId: m.id, options });
    if (!ack.ok) useChat.getState().applyReactions(m.roomType, m.id, before);
    return ack;
  }

  /** Live location: posts the card and resolves with the server message (needed for the update ticks). */
  async startLiveLocation(roomType: RoomType, coords: { lat: number; lng: number; accuracyM: number | null }, minutes: LiveMinutes): Promise<ChatMessage | string> {
    const msg = this.makePending(roomType, 'BUS_LOCATION', { source: 'PASSENGER', coords, live: { minutes } });
    useChat.getState().addPending(msg);
    const ack = await this.request<ChatMessage>(C2S.LOCATION_SHARE, { roomType, clientMsgId: msg.clientMsgId, coords, live: { minutes } });
    if (ack.ok) { useChat.getState().upsertMessage(ack.data); return ack.data; }
    useChat.getState().failPending(roomType, msg.clientMsgId!, ack.message);
    return ack.message;
  }
  liveLocationTick(messageId: string, coords: { lat: number; lng: number; accuracyM: number | null }) { return this.request<null>(C2S.LOCATION_UPDATE, { messageId, coords }); }
  liveLocationStop(messageId: string) { return this.request<null>(C2S.LOCATION_STOP, { messageId }); }
  createQrInvite(coords: { lat: number; lng: number }) { return this.request<QrInvite>(C2S.QR_CREATE, { coords }); }

  /** Start a mini game; the server picks the question / puzzle. Shows a placeholder card until it lands. */
  startGame(roomType: RoomType, kind: GameKind, opts: { pick?: number } = {}) {
    const msg = this.makePending(roomType, 'GAME', { kind, pending: true, ...opts });
    useChat.getState().addPending(msg);
    void this.deliver(msg);
  }

  /** Game move with an optimistic local echo; reverts (and returns the reason) if the server refuses. */
  async gameMove(m: UiMessage, move: GameMoveInput) {
    const st = useChat.getState();
    const seat = st.session!.me.seat;
    const before = m.reactions;
    // Dice are rolled on the server, so a roll has no optimistic echo.
    const echo = move.type === 'answer' ? `a${move.option}` : move.type === 'cell' ? `m${move.cell}` : move.type === 'pick' ? `p${move.pick}` : move.type === 'roll' ? null : move.type;
    if (echo) st.applyReactions(m.roomType, m.id, { ...before, [`${GAME_MOVE_PREFIX}${echo}`]: [...(before[`${GAME_MOVE_PREFIX}${echo}`] ?? []), seat] });
    const ack = await this.request<null>(C2S.GAME_MOVE, { messageId: m.id, move });
    if (!ack.ok) useChat.getState().applyReactions(m.roomType, m.id, before);
    return ack;
  }

  shareLandmark(roomType: RoomType, landmarkId: string) {
    const lm = useChat.getState().landmarks.find((l) => l.id === landmarkId);
    const msg = this.makePending(roomType, 'LANDMARK', lm ? { landmarkId, pointName: lm.pointName, title: lm.title, caption: lm.caption, imageUrl: lm.imageUrl } : { landmarkId });
    useChat.getState().addPending(msg);
    void this.deliver(msg);
  }

  retry(msg: UiMessage) {
    useChat.getState().dropMessage(msg.roomType, msg.clientMsgId!);
    const fresh = { ...msg, status: 'pending' as const, failReason: undefined, createdAt: new Date().toISOString() };
    useChat.getState().addPending(fresh);
    void this.deliver(fresh);
  }

  private async deliver(msg: UiMessage) {
    if (!this.connected) return; // stays pending; flushed on reconnect
    const base = { roomType: msg.roomType, clientMsgId: msg.clientMsgId };
    const ack =
      msg.contentType === 'BUS_LOCATION' ? await this.request<ChatMessage>(C2S.LOCATION_SHARE, msg.payload?.coords ? { ...base, coords: msg.payload.coords } : base)
      : msg.contentType === 'GAME' ? await this.request<ChatMessage>(C2S.GAME_START, { ...base, kind: msg.payload.kind, ...(msg.payload.pick != null ? { pick: msg.payload.pick } : {}) })
      : msg.contentType === 'POLL' ? await this.request<ChatMessage>(C2S.POLL_CREATE, { ...base, ...msg.payload })
      : msg.contentType === 'LANDMARK' ? await this.request<ChatMessage>(C2S.LANDMARK_SHARE, { ...base, landmarkId: msg.payload.landmarkId })
      : await this.request<ChatMessage>(C2S.MSG_SEND, { ...base, contentType: msg.contentType, payload: msg.payload });

    if (ack.ok) return useChat.getState().upsertMessage(ack.data);
    if (ack.code === 'INTERNAL') return; // transient: keep pending, outbox will retry
    if (ack.code === 'MUTED') useChat.getState().setMuted(true);
    useChat.getState().failPending(msg.roomType, msg.clientMsgId!, ack.message);
  }

  private async flushOutbox() {
    const { rooms } = useChat.getState();
    const pending = [...rooms.MAIN_COMMON.messages, ...rooms.WOMEN_ONLY.messages].filter((m) => m.status === 'pending');
    for (const m of pending) await this.deliver(m);
  }

  // ------------------------------------------------------------ receipts --
  markSeen(roomType: RoomType, ids: string[]) {
    if (!ids.length) return;
    const set = this.seenQueue.get(roomType) ?? new Set<string>();
    ids.forEach((id) => set.add(id));
    this.seenQueue.set(roomType, set);
    this.seenTimer ??= setTimeout(() => {
      this.seenTimer = null;
      for (const [rt, q] of this.seenQueue) {
        const messageIds = [...q].slice(0, 100);
        if (messageIds.length) void this.request(C2S.MSG_SEEN, { roomType: rt, messageIds });
      }
      this.seenQueue.clear();
    }, 700);
  }

  // ------------------------------------------------------- interactions --
  react(messageId: string, emoji: ReactionEmoji) { return this.request(C2S.MSG_REACT, { messageId, emoji }); }
  report(messageId: string, reason: ReportReason) { return this.request(C2S.MSG_REPORT, { messageId, reason }); }
  reportPerson(seat: string, roomType: RoomType, reason: ReportReason) { return this.request(C2S.PERSON_REPORT, { seat, roomType, reason }); }
  async block(seat: string, blocked: boolean) {
    const ack = await this.request<string[]>(C2S.SEAT_BLOCK, { seat, blocked });
    if (ack.ok) useChat.getState().setBlocked(ack.data);
    return ack;
  }
  async guess(gameId: string, guessAt: Date) {
    const ack = await this.request<EtaGameState>(C2S.GAME_GUESS, { gameId, guessAt: guessAt.toISOString() });
    if (ack.ok) useChat.getState().setGame(ack.data);
    return ack;
  }
  typing(roomType: RoomType, isTyping: boolean) {
    const now = Date.now();
    if (isTyping && now - this.lastTypingSent < 3000) return;
    this.lastTypingSent = isTyping ? now : 0;
    this.socket?.emit(C2S.TYPING, { roomType, isTyping });
  }
}

export const chatSocket = new ChatSocketService();
