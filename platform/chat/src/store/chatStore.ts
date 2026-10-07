import { chatEvents } from '../services/events';
import { create } from 'zustand';
import type {
  ChatMessage, EtaGameState, JoinResponse, JourneyInfo, Landmark, LocationEstimate, PinnedState, PresenceState, ProgressState, RoomSnapshot, RoomType, TenantClientConfig,
} from '../shared/protocol';

/**
 * ============================================================================
 *  Chat state (Zustand)
 * ============================================================================
 *  Why Zustand: socket events arrive outside React. A plain store with
 *  selector subscriptions lets each component re-render only for the slice it
 *  reads (the header doesn't re-render when a receipt arrives).
 *
 *  Message lifecycle (optimistic UI):
 *    pending  -> created locally with a clientMsgId, shown immediately
 *    sent     -> server ack replaced it with the canonical message
 *    failed   -> server rejected it (blocked content / muted). Stays visible
 *                with the reason so the passenger knows what happened.
 *  Pending messages survive disconnects and are re-sent on reconnect; the
 *  server dedupes on clientMsgId, so retries can never double-post.
 * ============================================================================
 */
export type MsgStatus = 'pending' | 'sent' | 'failed';
export interface UiMessage extends ChatMessage { status: MsgStatus; failReason?: string }

export interface RoomState {
  messages: UiMessage[];          // oldest -> newest
  hasMore: boolean;
  presence: PresenceState;
  pinned: PinnedState | null;
  joined: boolean;
  unread: number;
  typing: Record<string, number>; // seat -> expiresAt
  alert: ChatMessage | null;      // pinned Ops alert
  timer: ChatMessage | null;      // running rest-stop timer
}

const emptyRoom = (roomType: RoomType): RoomState => ({
  messages: [], hasMore: false, presence: { roomType, onlineSeats: [], count: 0, members: [], men: 0, women: 0, guests: 0 }, pinned: null, joined: false, unread: 0, typing: {}, alert: null, timer: null,
});

interface ChatState {
  session: JoinResponse | null;
  /** Shortcut to session.tenant: brand, features, identity mode, care handle… */
  tenant: TenantClientConfig | null;
  location: LocationEstimate | null;
  sharingLocation: boolean;
  /** Unread messages while the screen is in the background (sent to the host app as tr:unread). */
  backgroundUnread: number;
  setJourney(j: JourneyInfo): void;
  setLocation(l: LocationEstimate): void;
  setSharingLocation(v: boolean): void;
  setAlert(roomType: RoomType, m: ChatMessage | null): void;
  setMe(patch: Partial<JoinResponse['me']>): void;
  bumpBackgroundUnread(reset?: boolean): void;
  connection: 'connecting' | 'online' | 'offline';
  closed: null | { reason: 'ENDED' | 'UNAUTHORIZED' | 'REMOVED' };
  activeRoom: RoomType;
  /** Cards the passenger tucked away (by id). The rest-stop timer comes back by itself in the last 2 minutes. */
  hiddenPins: string[];
  hidePin(id: string, hidden: boolean): void;
  /** My live-location share in progress (one at a time). */
  liveShare: { messageId: string; roomType: RoomType; until: string } | null;
  setLiveShare(v: { messageId: string; roomType: RoomType; until: string } | null): void;
  rooms: Record<RoomType, RoomState>;
  game: EtaGameState | null;
  progress: ProgressState | null;
  landmarks: Landmark[];
  muted: boolean;
  blockedSeats: string[];
  clockOffsetMs: number;          // serverNow - deviceNow
  purgeAt: string | null;

  setSession(s: JoinResponse | null): void;
  setConnection(c: ChatState['connection']): void;
  setClosed(reason: 'ENDED' | 'UNAUTHORIZED' | 'REMOVED'): void;
  setActiveRoom(r: RoomType): void;
  applySnapshot(snap: RoomSnapshot, merge: boolean): void;
  prependHistory(roomType: RoomType, msgs: ChatMessage[], hasMore: boolean): void;
  upsertMessage(m: ChatMessage): void;
  addPending(m: UiMessage): void;
  failPending(roomType: RoomType, clientMsgId: string, reason: string): void;
  dropMessage(roomType: RoomType, idOrClientId: string): void;
  applyReceipts(roomType: RoomType, updates: { messageId: string; seats: string[] }[]): void;
  applyReactions(roomType: RoomType, messageId: string, reactions: Record<string, string[]>): void;
  setPresence(p: PresenceState): void;
  setPinned(roomType: RoomType, p: PinnedState | null): void;
  setGame(g: EtaGameState): void;
  setProgress(p: ProgressState): void;
  setTyping(roomType: RoomType, seat: string, isTyping: boolean): void;
  setMuted(m: boolean): void;
  setBlocked(seats: string[]): void;
  setPurgeAt(iso: string): void;
  reset(): void;
}

const sortByTime = (a: UiMessage, b: UiMessage) =>
  a.status === 'pending' && b.status !== 'pending' ? 1 : b.status === 'pending' && a.status !== 'pending' ? -1 : Date.parse(a.createdAt) - Date.parse(b.createdAt);

function mergeMessages(existing: UiMessage[], incoming: ChatMessage[]): UiMessage[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  const pendingByClient = new Map(existing.filter((m) => m.status === 'pending' && m.clientMsgId).map((m) => [m.clientMsgId!, m]));
  for (const m of incoming) {
    if (m.clientMsgId && pendingByClient.has(m.clientMsgId)) byId.delete(pendingByClient.get(m.clientMsgId)!.id);
    byId.set(m.id, { ...m, status: 'sent' });
  }
  return [...byId.values()].sort(sortByTime);
}

const patchRoom = (s: ChatState, roomType: RoomType, patch: Partial<RoomState> | ((r: RoomState) => Partial<RoomState>)) => ({
  rooms: { ...s.rooms, [roomType]: { ...s.rooms[roomType], ...(typeof patch === 'function' ? patch(s.rooms[roomType]) : patch) } },
});

const initial = {
  session: null, tenant: null, location: null, sharingLocation: false, backgroundUnread: 0, connection: 'connecting' as const, closed: null, activeRoom: 'MAIN_COMMON' as RoomType, liveShare: null, hiddenPins: [] as string[],
  rooms: { MAIN_COMMON: emptyRoom('MAIN_COMMON'), WOMEN_ONLY: emptyRoom('WOMEN_ONLY') },
  game: null, progress: null, landmarks: [], muted: false, blockedSeats: [], clockOffsetMs: 0, purgeAt: null,
};

export const useChat = create<ChatState>()((set, get) => ({
  ...initial,

  setSession: (session) => set({ session, tenant: session?.tenant ?? null, purgeAt: session?.journey.purgeAt ?? null }),
  setJourney: (journey) => set((s) => (s.session ? { session: { ...s.session, journey: { ...s.session.journey, ...journey } }, purgeAt: journey.purgeAt ?? s.purgeAt } : {})),
  setLocation: (location) => set({ location }),
  setSharingLocation: (sharingLocation) => set({ sharingLocation }),
  setAlert: (roomType, alert) => set((s) => patchRoom(s, roomType, { alert })),
  setMe: (patch) => set((s) => (s.session ? { session: { ...s.session, me: { ...s.session.me, ...patch } } } : {})),
  bumpBackgroundUnread: (reset) => set((s) => ({ backgroundUnread: reset ? 0 : s.backgroundUnread + 1 })),
  setConnection: (connection) => set({ connection }),
  setClosed: (reason) => set({ closed: { reason } }),
  setLiveShare: (liveShare) => set({ liveShare }),
  hidePin: (id, hidden) => set((s) => ({ hiddenPins: hidden ? [...new Set([...s.hiddenPins, id])] : s.hiddenPins.filter((x) => x !== id) })),
  setActiveRoom: (activeRoom) => set((s) => ({ activeRoom, ...patchRoom(s, activeRoom, { unread: 0 }) })),

  applySnapshot: (snap, merge) => set((s) => ({
    ...patchRoom(s, snap.roomType, (r) => ({
      messages: merge ? mergeMessages(r.messages, snap.messages) : mergeMessages(r.messages.filter((m) => m.status !== 'sent'), snap.messages),
      hasMore: merge ? r.hasMore : snap.hasMore,
      presence: snap.presence, pinned: snap.pinned, joined: true,
      alert: snap.alert ?? null, timer: snap.timer ?? null,
    })),
    location: snap.location ?? s.location,
    sharingLocation: snap.sharingLocation ?? s.sharingLocation,
    session: s.session && snap.journey ? { ...s.session, journey: { ...s.session.journey, ...snap.journey } } : s.session,
    game: snap.game ? { ...snap.game, myGuess: snap.game.myGuess ?? s.game?.myGuess ?? null } : s.game,
    progress: snap.progress ?? s.progress,
    landmarks: snap.landmarks.length ? snap.landmarks : s.landmarks,
    muted: snap.muted,
    blockedSeats: snap.blockedSeats,
    clockOffsetMs: Date.parse(snap.serverNow) - Date.now(),
  })),

  prependHistory: (roomType, msgs, hasMore) => set((s) => patchRoom(s, roomType, (r) => ({ messages: mergeMessages(r.messages, msgs), hasMore }))),

  upsertMessage: (m) => set((s) => {
    const mine = m.senderSeat === s.session?.me.seat;
    const background = m.roomType !== s.activeRoom;
    return patchRoom(s, m.roomType, (r) => ({
      ...(m.contentType === 'TIMER' ? { timer: m } : null),
      messages: mergeMessages(r.messages, [m]),
      unread: background && !mine && !r.messages.some((x) => x.id === m.id) ? r.unread + 1 : r.unread,
      typing: m.senderSeat ? Object.fromEntries(Object.entries(r.typing).filter(([seat]) => seat !== m.senderSeat)) : r.typing,
    }));
  }),

  addPending: (m) => {
    set((s) => patchRoom(s, m.roomType, (r) => ({ messages: [...r.messages, m] })));
    chatEvents.emit('sent', { roomType: m.roomType }); // whatever I send, the list jumps to it
  },

  failPending: (roomType, clientMsgId, reason) => set((s) => patchRoom(s, roomType, (r) => ({
    messages: r.messages.map((m) => (m.clientMsgId === clientMsgId && m.status === 'pending' ? { ...m, status: 'failed', failReason: reason } : m)),
  }))),

  dropMessage: (roomType, key) => set((s) => patchRoom(s, roomType, (r) => ({
    messages: r.messages.filter((m) => m.id !== key && m.clientMsgId !== key),
  }))),

  applyReceipts: (roomType, updates) => set((s) => {
    const map = new Map(updates.map((u) => [u.messageId, u.seats]));
    return patchRoom(s, roomType, (r) => ({
      messages: r.messages.map((m) => {
        const seats = map.get(m.id);
        return seats ? { ...m, seenBy: [...new Set([...m.seenBy, ...seats])] } : m;
      }),
    }));
  }),

  applyReactions: (roomType, messageId, reactions) => set((s) => patchRoom(s, roomType, (r) => ({
    messages: r.messages.map((m) => (m.id === messageId ? { ...m, reactions } : m)),
  }))),

  setPresence: (p) => set((s) => patchRoom(s, p.roomType, { presence: p })),
  setPinned: (roomType, pinned) => set((s) => patchRoom(s, roomType, { pinned })),
  setGame: (g) => set((s) => ({ game: { ...g, myGuess: g.myGuess !== undefined ? g.myGuess : s.game?.id === g.id ? s.game.myGuess : null } })),
  setProgress: (progress) => set({ progress }),
  setTyping: (roomType, seat, isTyping) => set((s) => patchRoom(s, roomType, (r) => {
    const typing = { ...r.typing };
    if (isTyping) typing[seat] = Date.now() + 5000; else delete typing[seat];
    return { typing };
  })),
  setMuted: (muted) => set({ muted }),
  setBlocked: (blockedSeats) => set({ blockedSeats }),
  setPurgeAt: (purgeAt) => set({ purgeAt }),
  reset: () => set({ ...initial, rooms: { MAIN_COMMON: emptyRoom('MAIN_COMMON'), WOMEN_ONLY: emptyRoom('WOMEN_ONLY') } }),
}));

export const serverNow = () => Date.now() + useChat.getState().clockOffsetMs;
