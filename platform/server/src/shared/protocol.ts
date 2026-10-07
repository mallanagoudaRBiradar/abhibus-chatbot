/**
 * ============================================================================
 *  Trip Rooms realtime protocol (hosted chat screen <-> platform)
 * ============================================================================
 *  Internal to the platform's own chat screen; tenants never call it directly
 *  (they use the REST API + a member token). Evolved from the AbhiBus journey
 *  chat protocol so the chat screen ports with minimal change.
 *
 *  Naming debt, kept on purpose for compatibility: `seat` everywhere in this
 *  file means the opaque MEMBER ID (mem_…), not a seat number. Seat numbers
 *  are Ops-only data and never reach the chat screen.
 *  `RoomType` = channel inside a trip room: MAIN_COMMON (everyone) or
 *  WOMEN_ONLY (members the tenant marked as F).
 * ============================================================================
 */

export type RoomType = 'MAIN_COMMON' | 'WOMEN_ONLY';
export type ContentType =
  | 'TEXT' | 'STICKER' | 'BUS_LOCATION' | 'BROADCAST' | 'LANDMARK' | 'SYSTEM' | 'POLL' | 'GAME'
  | 'ALERT' | 'TARA' | 'PRIVATE' | 'SURVEY' | 'AD' | 'ISSUE' | 'VOUCHER' | 'TIMER' | 'LOST' | 'CREW' | 'RATE';
export type Vertical = 'bus' | 'train' | 'flight' | 'custom';
export type RoomStateName = 'scheduled' | 'dormant' | 'open' | 'onboard' | 'read_only' | 'closed';
export type IdentityMode = 'handle' | 'profile';
export type Gender = 'M' | 'F' | 'O' | 'U';

// ---------------------------------------------------------------- stickers --
export const STICKERS = [
  { id: 'ac_cold', emoji: '🥶', label: 'AC too cold', tone: 'ice' },
  { id: 'dinner', emoji: '🍽️', label: 'When is dinner?', tone: 'warm' },
  { id: 'plug', emoji: '🔌', label: 'Is there a plug point?', tone: 'neutral' },
  { id: 'stop', emoji: '🛑', label: 'Driver Uncle, please stop', tone: 'alert' },
  { id: 'washroom', emoji: '🚻', label: 'Washroom break?', tone: 'neutral' },
  { id: 'chai', emoji: '☕', label: 'Chai stop please', tone: 'warm' },
  { id: 'volume', emoji: '🔇', label: 'Volume down please', tone: 'neutral' },
  { id: 'lights', emoji: '💡', label: 'Lights off?', tone: 'ice' },
  { id: 'water', emoji: '💧', label: 'Anyone have water?', tone: 'ice' },
  { id: 'eta', emoji: '⏳', label: 'Are we there yet?', tone: 'warm' },
  { id: 'night', emoji: '🌙', label: 'Good night, all', tone: 'neutral' },
  { id: 'thanks', emoji: '🙏', label: 'Thank you, anna', tone: 'warm' },
] as const;
export type StickerId = (typeof STICKERS)[number]['id'];
export const STICKER_IDS = STICKERS.map((s) => s.id) as StickerId[];

/** Quick-reaction bar (WhatsApp-style). Any single emoji is allowed via the full picker. */
export const REACTIONS = ['❤️', '😂', '😮', '😢', '🙏', '👍'] as const;
export type ReactionEmoji = string;
/** One emoji (incl. ZWJ sequences, skin tones, flags), no letters/digits. */
export const isReactionEmoji = (e: string) =>
  e.length > 0 && e.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(e) && !/[\p{L}\p{N}]/u.test(e.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}#*0-9]/gu, ''));

// ------------------------------------------------------------- identity --
/**
 * Passengers appear as a first name + avatar they choose when joining (never
 * the booking name). Default avatar = their initial. 38 avatars: mostly animals
 * and playful characters, a few people across ages.
 */
export const AVATAR_GROUPS = [
  { key: 'animal', label: 'Animals', avatars: ['🐯', '🦁', '🐼', '🐨', '🦊', '🐸', '🐵', '🐶', '🐱', '🐰', '🐻', '🦉', '🐧', '🐘', '🐢', '🐙'] },
  { key: 'fun', label: 'Fun', avatars: ['🤖', '👽', '👻', '🦄', '🦖', '🐲', '🤠', '😎', '🥸', '🤓', '🧙', '🦸', '🧜', '🧞'] },
  { key: 'people', label: 'People', avatars: ['🧒🏽', '🧑🏽', '👩🏽', '👨🏽', '🧕🏽', '👳🏽‍♂️', '👵🏽', '👴🏽'] },
] as const;
/** Avatar id = "<group>-<index>", e.g. "animal-3". */
export const AVATARS: Record<string, string> = Object.fromEntries(
  AVATAR_GROUPS.flatMap((g) => g.avatars.map((emoji, i) => [`${g.key}-${i}`, emoji])),
);
export const DISPLAY_NAME_RE = /^[\p{L}][\p{L}\p{M} .'-]{0,23}$/u; // letters only: no phone numbers smuggled into names
export const initialOf = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

export interface Member {
  seat: string;                // internal id (never shown)
  name: string;
  avatar: string | null;       // AVATARS key; null = initial
  online: boolean;
  guest: boolean;              // joined via QR (ticket not verified on AbhiBus)
  invitedBy?: string | null;   // guests: display name of the passenger whose QR they scanned
}

export const REPORT_REASONS = ['HARASSMENT', 'ABUSE', 'CONTACT_SHARING', 'SPAM', 'OTHER'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

// ---------------------------------------------------------------- payloads --
export interface TextPayload { text: string }
export interface StickerPayload { stickerId: StickerId }
export interface BusLocationPayload {
  lat: number;
  lng: number;
  placeLabel: string;          // "Kurnool Highway"
  highway: string;             // "NH 44"
  speedKmph: number | null;
  recordedAt: string;          // GPS fix time (ISO)
  progress: number;            // 0..1 along route
  nextStop: { name: string; distanceKm: number } | null;
  /** 'BUS' = bus GPS (default, older messages). 'PASSENGER' = a one-time snapshot of the sender's own phone location. */
  source?: 'BUS' | 'PASSENGER';
  accuracyM?: number | null;
  distanceFromBusM?: number | null; // PASSENGER only: how far the sender is from the bus
  /** Live sharing (PASSENGER only): position updates until `until`, unless stopped early. */
  live?: { until: string; stoppedAt: string | null; minutes: number } | null;
}
export type BroadcastPayload =
  | { kind: 'REST_STOP'; label: string; place: string | null; startedAt: string; endsAt: string; durationSec: number }
  | { kind: 'REST_STOP_ENDED'; label: string }
  | { kind: 'ANNOUNCEMENT'; text: string };
export interface LandmarkPayload {
  landmarkId: string;
  pointName: string;           // "Kurnool"
  title: string;               // "Opposite HP Petrol Pump"
  caption: string;
  imageUrl: string | null;
}
export interface SystemPayload { text: string }

// ------------------------------------------------- platform message kinds --
export type Severity = 'info' | 'warning' | 'critical';
/** Ops announcement. Pinned by default; `translations` keyed by language (hi, ta, …). */
export interface AlertPayload { text: string; severity: Severity; pin: boolean; translations?: Record<string, string>; author?: string }
export interface TaraPayload { text: string; source?: 'rules' | 'bot' }
/** Visible to one member only (SOS / wait-for-me / Ops private reply). */
export interface PrivatePayload { text: string; from: string }
export interface IssuePayload { label: string; count: number; escalated: boolean; threshold: number }
export interface VoucherPayload { amount: number; currency: 'INR'; validDays: number; note: string }
export interface TimerPayload { stop: string; leaveAt: string; startedAt: string }
export interface LostPayload { text: string }
export interface CrewPayload { text: string; role: string }
export interface RatePayload { prompt: string }
export interface SurveyQuestion { type: 'rating' | 'choice' | 'text'; q: string; options?: string[] }
export interface SurveyPayload { campaignId?: string; by: string; questions: SurveyQuestion[] }
export interface AdPayload {
  campaignId: string; advertiser: string; format: 'card' | 'stop_offer' | 'sponsored_game';
  title: string; body: string; cta: string; tile: string; stop?: string | null; coupon?: string | null;
}
/** Per-member state the server adds to some cards (my vote, my answer, claimed…). */
export interface MineState { claimed?: boolean; answered?: boolean; metoo?: boolean; clicked?: boolean; rated?: number }

// --------------------------------------------------------------- mentions --
/** @-mentionable handles. Mentioning AbhiBus Care flags the message for the support desk. */
export const MENTIONABLES = [
  { id: 'CARE', handle: 'AbhiBus Care', title: 'AbhiBus Customer Care', subtitle: 'Get help from our support team' },
] as const;
export type MentionId = (typeof MENTIONABLES)[number]['id'];
export const mentionsIn = (text: string): MentionId[] =>
  MENTIONABLES.filter((m) => text.toLowerCase().includes(`@${m.handle.toLowerCase()}`)).map((m) => m.id);

// ---------------------------------------------------------- live location --
export const LIVE_LOCATION_MINUTES = [10, 15, 20] as const;
export type LiveMinutes = (typeof LIVE_LOCATION_MINUTES)[number];

// --------------------------------------------------------------------- QR --
/** Bus, QR provider and scanner must all be within this distance (km). */
export const QR_RADIUS_KM = 2;
export interface QrInvite { token: string; link: string; expiresAt: string; check: { providerKm: number | null; skipped: boolean } }
/** QR content is a plain web link: any phone camera opens it, no app needed. */
export interface QrJoinCheck { busKm: number | null; providerKm: number | null; skipped: boolean }

// ------------------------------------------------------------ mini games --
/**
 * In-chat mini games. Like polls they're messages; every move is a reaction
 * row keyed `g:<move>` (answers `g:a<i>`, tic-tac-toe `g:join` / `g:m<cell>`),
 * so moves ride S2C.REACTIONS. Time-based state (reveal, hint, expiry) is
 * computed by the server when it builds the message and pushed via S2C.MSG_UPDATE.
 */
export const GAME_MOVE_PREFIX = 'g:';
export type GameKind = 'QUIZ' | 'EMOJI' | 'TTT';

export interface QuizGame {
  kind: 'QUIZ';
  category: string;            // "Bollywood", "Cricket", "On this route"
  question: string;
  options: string[];
  revealAt: string;            // answers lock + reveal
  correct: number | null;      // null until revealAt (never sent early)
}
export interface EmojiGame {
  kind: 'EMOJI';
  category: string;            // "Bollywood movie"
  emojis: string;
  wordCount: number;
  hint: string | null;         // "S _ _ _ _ _" after hintAt
  hintAt: string;
  expiresAt: string;
  solvedBy: string | null;     // seat
  solvedAt: string | null;
  answer: string | null;       // revealed once solved or expired
}
export interface TttGame {
  kind: 'TTT';
  challenger: string;          // plays X, moves first
  expiresAt: string;           // open challenge expires if nobody accepts
}
export type GamePayload = QuizGame | EmojiGame | TttGame;

export const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]] as const;
/** Derive tic-tac-toe state from the move rows (shared by client + server, so they always agree). */
export function tttState(g: TttGame, reactions: Record<string, string[]>) {
  const opponent = (reactions[`${GAME_MOVE_PREFIX}join`] ?? [])[0] ?? null;
  const board: (string | null)[] = Array.from({ length: 9 }, (_, i) => (reactions[`${GAME_MOVE_PREFIX}m${i}`] ?? [])[0] ?? null);
  const xs = board.filter((c) => c === g.challenger).length;
  const os = board.filter((c) => c && c !== g.challenger).length;
  let winner: string | null = null;
  let line: readonly number[] | null = null;
  for (const l of TTT_LINES) {
    const [a, b, c] = l;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) { winner = board[a]; line = l; break; }
  }
  const full = board.every(Boolean);
  const turn = !opponent || winner || full ? null : xs === os ? g.challenger : opponent;
  return { opponent, board, winner, line, draw: !winner && full, turn };
}
/** Quiz: who answered what. */
export function quizAnswers(reactions: Record<string, string[]>, optionCount: number): string[][] {
  return Array.from({ length: optionCount }, (_, i) => reactions[`${GAME_MOVE_PREFIX}a${i}`] ?? []);
}

// ------------------------------------------------------------------ polls --
/**
 * WhatsApp-style poll. Votes are not in the payload: each vote is a reaction
 * row keyed `poll:<optionIndex>`, so they ride the existing reactions channel
 * (S2C.REACTIONS) and are purged with the message. Use `pollVotes()` to read.
 */
export interface PollPayload { question: string; options: string[]; multi: boolean }
export const POLL_LIMITS = { questionMax: 200, optionMax: 80, minOptions: 2, maxOptions: 12 } as const;
export const POLL_VOTE_PREFIX = 'poll:';
export const isPollKey = (k: string) => k.startsWith(POLL_VOTE_PREFIX);
/** Reaction keys used as poll votes / game moves — never shown as emoji chips. */
export const isSystemReactionKey = (k: string) => k.startsWith(POLL_VOTE_PREFIX) || k.startsWith(GAME_MOVE_PREFIX);
/** Seats per option, in option order. */
export function pollVotes(reactions: Record<string, string[]>, optionCount: number): string[][] {
  return Array.from({ length: optionCount }, (_, i) => reactions[`${POLL_VOTE_PREFIX}${i}`] ?? []);
}

export interface ChatMessage {
  id: string;
  roomType: RoomType;
  senderSeat: string | null;   // null => conductor / system
  senderHandle: string;        // "Seat 12U" | "Conductor" | "AbhiBus"
  contentType: ContentType;
  payload: any;
  createdAt: string;
  clientMsgId?: string | null;
  senderAvatar?: string | null; // AVATARS key of the sender (null = initial of senderHandle)
  senderGuest?: boolean;       // sender joined via QR
  seenBy: string[];            // seat handles' seat codes, e.g. ["4W","18L"]
  reactions: Record<string, string[]>; // emoji -> seats
}

export interface PresenceState {
  roomType: RoomType;
  onlineSeats: string[];
  count: number;               // people in this room (joined), not just online
  members: Member[];           // everyone who has joined this room
  men: number;                 // counts only — per-person gender is never sent to other passengers
  women: number;
  guests: number;
}

/** Room facts the chat screen shows (header, strip, phases). Named JourneyInfo for compatibility. */
export interface JourneyInfo {
  tenantId: string;
  tenantName: string;
  vertical: Vertical;
  state: RoomStateName;
  subtitle: string;
  delayMin: number;
  opsOnly: boolean;
  slowMode: boolean;
  meta: Record<string, string>; // platform, gate, terminal, belt, vehicle_no …
  stops: { code: string; name: string; eta: string; type?: string }[];
  boardingCode: string | null;
  dropCode: string | null;
  opensAt: string;
  readOnlyAt: string;
  journeyId: string;
  busNumber: string;
  operatorName: string;
  routeName: string;
  sourceCity: string;
  destinationCity: string;
  startTime: string;
  estimatedEndTime: string;
  status: 'SCHEDULED' | 'IN_TRANSIT' | 'ARRIVED' | 'PURGED';
  purgeAt: string | null;
  totalSeatsBooked: number;
}

export interface ProgressState {
  progress: number;            // 0..1
  placeLabel: string;
  highway: string;
  nextStop: { name: string; distanceKm: number } | null;
  etaToDestination: string | null;
  updatedAt: string;
}

export interface EtaGameState {
  id: string;
  checkpointName: string;
  status: 'OPEN' | 'LOCKED' | 'RESOLVED';
  closesAt: string;
  guessCount: number;
  myGuess?: string | null;     // only present on personalised payloads
  actualAt: string | null;
  winnerSeat: string | null;
  winnerDeltaMin: number | null;
  rewardPoints: number;
}

export interface PinnedState { messageId: string; payload: Extract<BroadcastPayload, { kind: 'REST_STOP' }> }

export interface Landmark {
  id: string;
  pointName: string;
  title: string;
  caption: string;
  imageUrl: string | null;
  passed: boolean;
}

export interface RoomSnapshot {
  roomType: RoomType;
  messages: ChatMessage[];     // oldest -> newest
  hasMore: boolean;
  presence: PresenceState;
  pinned: PinnedState | null;
  game: EtaGameState | null;
  progress: ProgressState | null;
  landmarks: Landmark[];
  muted: boolean;
  blockedSeats: string[];
  serverNow: string;
  // ---- platform additions ----
  alert: ChatMessage | null;          // the pinned Ops alert, if any
  timer: ChatMessage | null;          // the running rest-stop timer, if any
  location: LocationEstimate | null;
  journey: JourneyInfo;               // fresh room facts on every (re)join
  sharingLocation: boolean;           // am I sharing anonymously (crowd)?
}

export interface Me {
  seat: string;                // member id (see naming note at the top)
  profileNeeded: boolean;      // profile mode and the traveller hasn't picked a name yet
  handle: string;              // display name
  name: string;
  avatar: string | null;
  guest: boolean;
  pnrMasked: string;           // the traveller's own booking ref, masked for display
  gender: Gender;              // own gender only; server re-checks on every women-room join
}

/** What the chat screen needs to brand itself and switch features on/off. */
export interface TenantClientConfig {
  id: string;
  name: string;
  theme: { brand: string; brandInk: string; font?: string; logoText?: string };
  identityMode: IdentityMode;
  features: Record<string, boolean>;
  socialMin: number;
  slowModeSec: number;
  quiet: { from: string; to: string; active: boolean };
  careHandle: string;
  supportPhone: string | null;
  quickAsks: string[];
  issues: string[];
}

export interface JoinResponse {
  tenant: TenantClientConfig;
  token: string;
  me: Me;
  journey: JourneyInfo;
  supportPhone: string | null;
}

// ------------------------------------------------------------------- acks --
export type ErrorCode =
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_IN_ROOM' | 'MUTED' | 'RATE_LIMITED'
  | 'BLOCKED_CONTENT' | 'INVALID' | 'NOT_FOUND' | 'GAME_CLOSED' | 'ALREADY_GUESSED'
  | 'TRIP_NOT_LIVE' | 'SEAT_CLAIMED' | 'JOURNEY_CLOSED' | 'REMOVED' | 'TOO_FAR' | 'INTERNAL' | 'FEATURE_OFF' | 'OPS_ONLY' | 'SLOW_MODE';

export type Ack<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; meta?: Record<string, unknown> };

// ----------------------------------------------------------------- events --
/** Client -> Server */
export const C2S = {
  ROOM_JOIN: 'room:join',            // { roomType, since? } -> Ack<RoomSnapshot>
  ROOM_LEAVE: 'room:leave',          // { roomType } -> Ack<null>
  ROOM_HISTORY: 'room:history',      // { roomType, before } -> Ack<{messages, hasMore}>
  MSG_SEND: 'message:send',          // { roomType, clientMsgId, contentType: TEXT|STICKER, payload } -> Ack<ChatMessage>
  LOCATION_UPDATE: 'location:update', // { messageId, coords } -> Ack<null>. Live share position tick (sender only)
  LOCATION_STOP: 'location:stop',    // { messageId } -> Ack<null>
  QR_CREATE: 'qr:create',            // { coords } -> Ack<QrInvite>. Verified (PNR) passengers only
  LOCATION_SHARE: 'location:share',  // { roomType, clientMsgId, coords? } -> Ack<ChatMessage>. No coords = bus GPS; coords = sender's own phone (opt-in)
  LANDMARK_SHARE: 'landmark:share',  // { roomType, clientMsgId, landmarkId } -> Ack<ChatMessage>
  MSG_SEEN: 'message:seen',          // { roomType, messageIds[] } -> Ack<null>
  MSG_REACT: 'message:react',        // { messageId, emoji } -> Ack<null>
  POLL_CREATE: 'poll:create',        // { roomType, clientMsgId, question, options[], multi } -> Ack<ChatMessage>
  GAME_START: 'game:start',          // { roomType, clientMsgId, kind } -> Ack<ChatMessage>. Server picks the content
  GAME_MOVE: 'game:move',            // { messageId, move: {type:'answer',option} | {type:'join'} | {type:'cell',cell} } -> Ack<null>
  POLL_VOTE: 'poll:vote',            // { messageId, options: number[] } -> Ack<null>. Replaces your vote; [] = retract. Result arrives as REACTIONS
  MSG_REPORT: 'message:report',      // { messageId, reason } -> Ack<null>
  PERSON_REPORT: 'person:report',    // { seat, roomType, reason } -> Ack<null>. Report someone from the people list (counts toward removal)
  SEAT_BLOCK: 'seat:block',          // { seat, blocked } -> Ack<string[]>
  GAME_GUESS: 'game:guess',          // { gameId, guessAt } -> Ack<EtaGameState>
  TYPING: 'typing',                  // { roomType, isTyping } (fire & forget)
  // ---- platform additions ----
  PROFILE_SET: 'profile:set',        // { name, avatar } -> Ack<Me>   (profile identity mode)
  ISSUE_REPORT: 'issue:report',      // { label } -> Ack<ChatMessage>  creates or joins the issue card
  ISSUE_METOO: 'issue:metoo',        // { messageId } -> Ack<null>
  SOS_RAISE: 'sos:raise',            // { reason, coords? } -> Ack<{ actionId }>  never shown in the room
  WAIT_REQUEST: 'wait:request',      // { minutes } -> Ack<{ actionId }>
  LOST_POST: 'lost:post',            // { text } -> Ack<ChatMessage>
  SURVEY_ANSWER: 'survey:answer',    // { messageId, answers[] } -> Ack<null>
  VOUCHER_CLAIM: 'voucher:claim',    // { messageId } -> Ack<{ code }>
  AD_CLICK: 'ad:click',              // { messageId } -> Ack<{ coupon? }>
  RATE_TRIP: 'trip:rate',            // { messageId, stars } -> Ack<null>
  CATCH_UP: 'tara:catchup',          // {} -> Ack<null>  Tara posts a catch-up for you (private)
  ASK_TARA: 'tara:ask',              // { question } -> Ack<null>  (also triggered by @Tara in a message)
  CROWD_SHARE: 'location:crowd',     // { on, coords? } -> Ack<null>  share position anonymously while on board
  CROWD_PING: 'location:ping',       // { coords } -> Ack<null>  every ~60s while sharing
} as const;

/** Server -> Client */
export const S2C = {
  MSG_NEW: 'message:new',            // ChatMessage
  MSG_REMOVED: 'message:removed',    // { roomType, messageId }
  MSG_UPDATE: 'message:update',      // ChatMessage (a game card changed: revealed, solved, hint, expired)
  RECEIPTS: 'receipts:batch',        // { roomType, updates: [{ messageId, seats[] }] }
  REACTIONS: 'reactions:update',     // { roomType, messageId, reactions }
  PRESENCE: 'presence:update',       // PresenceState
  PINNED: 'pinned:update',           // { pinned: PinnedState | null }
  GAME: 'game:update',               // EtaGameState
  PROGRESS: 'progress:update',       // ProgressState
  TYPING: 'typing',                  // { roomType, seat, isTyping }
  MUTED: 'moderation:muted',         // { reason }
  REMOVED: 'moderation:removed',     // { reason } — reported by more than half the room; removed for good
  JOURNEY_ENDING: 'journey:ending',  // { purgeAt }
  JOURNEY_CLOSED: 'journey:closed',  // {}
  // ---- platform additions ----
  ROOM_UPDATE: 'room:update',        // JourneyInfo (state, delay, ops-only, slow mode, meta changed)
  LOCATION: 'location:estimate',     // LocationEstimate
  PRIVATE_NEW: 'private:new',        // ChatMessage visible only to you
} as const;

/** Fused position: official feed when fresh, else on-board travellers, else timetable. */
export interface LocationEstimate {
  near: string;
  progress: number;               // 0..1 along the route
  source: string;                 // "Bus GPS" | "Running status" | "3 travellers on board" | "Timetable + last known point"
  confidence: 'high' | 'medium' | 'estimated';
  contributors: number;
  nextStop: { code: string; name: string; eta: string } | null;
  updatedAt: string;
}

export const roomKey = (roomId: string, roomType: RoomType) => `r:${roomId}:${roomType}`;
export const seatKey = (roomId: string, memberId: string) => `m:${roomId}:${memberId}`;
export const tripKey = (roomId: string) => `t:${roomId}`; // every connected member of the trip
