import { prisma } from '../db/prisma';
import { hub } from '../realtime/hub';
import { logger } from '../lib/logger';
import { GAME_MOVE_PREFIX,  roomKey, tttState, type ChatMessage, type GameKind, type RoomType, type TttGame } from '../shared/protocol';
import { EMOJI_BANK, QUIZ_BANK, normalise, pickRandom } from './gameBank';
import type { StoredGame } from './gamesView';

/**
 * In-chat mini games: Bus Quiz, Guess the Movie (emoji), Tic-tac-toe.
 *
 * Storage: a game is a TEXT message whose payload carries `game` (StoredGame,
 * with secrets) plus a fallback `text`; every move is a message_reaction row
 * keyed `g:…`. Nothing new in the schema, and everything is hard-deleted with
 * the chat at purge time.
 *
 * Timers only *push* changes (reveal / hint / expiry); the state itself is
 * derived from timestamps in publicGame(), so a restart or reconnect still
 * shows the right thing. One-active-game guards and move locks are in memory
 * (fine with sticky sessions; a multi-node deploy would move them to Redis).
 */
const QUIZ_SECONDS = 25;
const EMOJI_HINT_SECONDS = 45;
const EMOJI_SECONDS = 150;
const TTT_ACCEPT_SECONDS = 300;

type Fail = { ok: false; code: 'INVALID' | 'NOT_FOUND' | 'GAME_CLOSED' | 'ALREADY_GUESSED'; message: string };
type Ok<T> = { ok: true; data: T };

/** One quiz / emoji round at a time per room, so games don't drown the conversation. */
const activeRound = new Map<string, { messageId: string; until: number }>();
/** One open tic-tac-toe challenge per seat. */
const openChallenge = new Map<string, { messageId: string; until: number }>();
/** Serialise moves per game message (two taps in the same instant can't both land). */
const locks = new Map<string, Promise<unknown>>();
const withLock = <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
  const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
  locks.set(id, run.catch(() => undefined));
  return run;
};
const solved = new Set<string>();

/** Demo hook: called after any tic-tac-toe move so a simulated passenger can reply. */
export const tttListeners: ((journeyId: string, roomType: RoomType, messageId: string) => void)[] = [];

const later = (ms: number, fn: () => Promise<unknown>) => setTimeout(() => { fn().catch((err) => logger.warn({ err }, 'game timer')); }, ms);

async function loadGame(messageId: string, journeyId: string) {
  const m = await prisma.message.findUnique({ where: { messageId }, include: { room: true, reactions: { orderBy: { createdAt: 'asc' } } } });
  const game = (m?.payload as any)?.game as StoredGame | undefined;
  if (!m || !game || m.room.journeyId !== journeyId) return null;
  const reactions: Record<string, string[]> = {};
  for (const r of m.reactions) (reactions[r.emoji] ??= []).push(r.seatNumber);
  return { m, game, roomType: m.room.roomType as RoomType, reactions };
}

const sys = (journeyId: string, roomType: RoomType, text: string) =>
  hub.createMessage(journeyId, roomType, { senderSeat: null, senderHandle: 'AbhiBus', contentType: 'SYSTEM', payload: { text } });

// ------------------------------------------------------------------ start ---
export async function startGame(journeyId: string, roomType: RoomType, seat: string, kind: GameKind, clientMsgId: string): Promise<Ok<ChatMessage> | Fail> {
  const now = Date.now();
  const rk = roomKey(journeyId, roomType);

  if (kind === 'QUIZ' || kind === 'EMOJI') {
    const live = activeRound.get(rk);
    if (live && live.until > now) return { ok: false, code: 'INVALID', message: 'A game is already running in this chat. Join that one!' };
  } else {
    const live = openChallenge.get(`${rk}:${seat}`);
    if (live && live.until > now) return { ok: false, code: 'INVALID', message: 'You already have an open challenge.' };
  }

  let game: StoredGame;
  let text: string;
  if (kind === 'QUIZ') {
    const q = pickRandom(QUIZ_BANK);
    // Shuffle options so the answer isn't always in the same slot.
    const order = q.options.map((_, i) => i).sort(() => Math.random() - 0.5);
    game = { kind, category: q.category, question: q.question, options: order.map((i) => q.options[i]), correct: order.indexOf(q.answer), revealAt: new Date(now + QUIZ_SECONDS * 1000).toISOString() };
    text = `🧠 Bus Quiz: ${q.question}`;
  } else if (kind === 'EMOJI') {
    const e = pickRandom(EMOJI_BANK);
    game = {
      kind, category: e.category, emojis: e.emojis, title: e.title, answers: e.answers, solvedBy: null, solvedAt: null,
      hintAt: new Date(now + EMOJI_HINT_SECONDS * 1000).toISOString(), expiresAt: new Date(now + EMOJI_SECONDS * 1000).toISOString(),
    };
    text = `🎬 Guess the movie: ${e.emojis}`;
  } else {
    game = { kind, challenger: seat, expiresAt: new Date(now + TTT_ACCEPT_SECONDS * 1000).toISOString() };
    text = `❌⭕ ${hub.nameOf(journeyId, seat)} challenged the bus to tic-tac-toe`;
  }

  const msg = await hub.createMessage(journeyId, roomType, { senderSeat: seat, senderHandle: hub.nameOf(journeyId, seat), contentType: 'TEXT', payload: { text, game }, clientMsgId });

  if (game.kind === 'QUIZ') {
    activeRound.set(rk, { messageId: msg.id, until: Date.parse(game.revealAt) });
    later(QUIZ_SECONDS * 1000 + 300, () => hub.pushUpdate(msg.id));
  } else if (game.kind === 'EMOJI') {
    activeRound.set(rk, { messageId: msg.id, until: Date.parse(game.expiresAt) });
    later(EMOJI_HINT_SECONDS * 1000 + 300, async () => { if (!solved.has(msg.id)) await hub.pushUpdate(msg.id); });
    later(EMOJI_SECONDS * 1000 + 300, async () => {
      if (solved.has(msg.id)) return;
      activeRound.delete(rk);
      await hub.pushUpdate(msg.id);
      await sys(journeyId, roomType, `⏰ Nobody got it — the movie was ${(game as Extract<StoredGame, { kind: 'EMOJI' }>).title}`);
    });
  } else {
    openChallenge.set(`${rk}:${seat}`, { messageId: msg.id, until: Date.parse(game.expiresAt) });
    later(TTT_ACCEPT_SECONDS * 1000 + 300, () => hub.pushUpdate(msg.id));
  }
  return { ok: true, data: msg };
}

// ------------------------------------------------------------------ moves ---
export type GameMove = { type: 'answer'; option: number } | { type: 'join' } | { type: 'cell'; cell: number };

export function makeMove(journeyId: string, seat: string, messageId: string, move: GameMove, canAccess: (rt: RoomType) => boolean): Promise<Ok<null> | Fail> {
  return withLock(messageId, async (): Promise<Ok<null> | Fail> => {
    const g = await loadGame(messageId, journeyId);
    if (!g || !canAccess(g.roomType)) return { ok: false, code: 'NOT_FOUND', message: 'Game not found.' };
    const now = Date.now();
    const add = (key: string) => prisma.messageReaction.create({ data: { messageId, seatNumber: seat, emoji: `${GAME_MOVE_PREFIX}${key}` } });

    if (g.game.kind === 'QUIZ' && move.type === 'answer') {
      if (now >= Date.parse(g.game.revealAt)) return { ok: false, code: 'GAME_CLOSED', message: 'Answers are closed.' };
      if (move.option < 0 || move.option >= g.game.options.length) return { ok: false, code: 'INVALID', message: 'Pick an option.' };
      if (Object.entries(g.reactions).some(([k, seats]) => k.startsWith(`${GAME_MOVE_PREFIX}a`) && seats.includes(seat)))
        return { ok: false, code: 'ALREADY_GUESSED', message: 'You’ve already locked in an answer.' };
      await add(`a${move.option}`);
    } else if (g.game.kind === 'TTT' && (move.type === 'join' || move.type === 'cell')) {
      const st = tttState(g.game as TttGame, g.reactions);
      if (move.type === 'join') {
        if (seat === g.game.challenger) return { ok: false, code: 'INVALID', message: 'You can’t accept your own challenge.' };
        if (st.opponent) return { ok: false, code: 'GAME_CLOSED', message: `${hub.nameOf(journeyId, st.opponent)} already accepted.` };
        if (now >= Date.parse(g.game.expiresAt)) return { ok: false, code: 'GAME_CLOSED', message: 'This challenge expired.' };
        await add('join');
        openChallenge.delete(`${roomKey(journeyId, g.roomType)}:${g.game.challenger}`);
      } else {
        if (st.turn !== seat) return { ok: false, code: 'INVALID', message: st.turn ? 'Wait for your turn.' : 'This game is over.' };
        if (move.cell < 0 || move.cell > 8 || st.board[move.cell]) return { ok: false, code: 'INVALID', message: 'That square is taken.' };
        await add(`m${move.cell}`);
        const after = tttState(g.game as TttGame, { ...g.reactions, [`${GAME_MOVE_PREFIX}m${move.cell}`]: [seat] });
        if (after.winner) {
          const loser = after.winner === g.game.challenger ? after.opponent : g.game.challenger;
          void sys(journeyId, g.roomType, `🏆 ${hub.nameOf(journeyId, after.winner)} beat ${hub.nameOf(journeyId, loser!)} at tic-tac-toe`);
        } else if (after.draw) {
          void sys(journeyId, g.roomType, `🤝 ${hub.nameOf(journeyId, g.game.challenger)} and ${hub.nameOf(journeyId, after.opponent!)} drew at tic-tac-toe`);
        }
      }
      await hub.emitReactions(journeyId, g.roomType, messageId);
      for (const l of tttListeners) l(journeyId, g.roomType, messageId);
      return { ok: true, data: null };
    } else {
      return { ok: false, code: 'INVALID', message: 'That move doesn’t fit this game.' };
    }
    await hub.emitReactions(journeyId, g.roomType, messageId);
    return { ok: true, data: null };
  });
}

// ------------------------------------------------- emoji guesses via chat ---
/** Every chat message is a possible guess for the room's running emoji puzzle. */
export async function onChatMessage(journeyId: string, msg: ChatMessage) {
  if (msg.contentType !== 'TEXT' || !msg.senderSeat) return;
  const live = activeRound.get(roomKey(journeyId, msg.roomType));
  if (!live || live.until < Date.now() || solved.has(live.messageId)) return;
  const guess = ` ${normalise(String(msg.payload?.text ?? ''))} `;
  await withLock(live.messageId, async () => {
    if (solved.has(live.messageId)) return;
    const g = await loadGame(live.messageId, journeyId);
    if (!g || g.game.kind !== 'EMOJI' || g.game.solvedBy) return;
    // Whole-word match ("is it sholay?"), or for longer titles a spacing-insensitive one ("3idiots", "chakde").
    const squashed = guess.replace(/ /g, '');
    const hit = g.game.answers.some((a) => {
      const n = normalise(a);
      return guess.includes(` ${n} `) || (n.length >= 5 && squashed.includes(n.replace(/ /g, '')));
    });
    if (!hit) return;
    solved.add(live.messageId);
    activeRound.delete(roomKey(journeyId, msg.roomType));
    const game = { ...g.game, solvedBy: msg.senderSeat, solvedAt: new Date().toISOString() };
    await prisma.message.update({ where: { messageId: live.messageId }, data: { payload: { ...(g.m.payload as object), game } } });
    await hub.pushUpdate(live.messageId);
    const secs = Math.round((Date.now() - g.m.createdAt.getTime()) / 1000);
    await sys(journeyId, msg.roomType, `🎉 ${hub.nameOf(journeyId, msg.senderSeat!)} got it in ${secs}s — ${game.title}`);
  });
}

export function initMiniGames() {
  hub.onPassengerMessage.push((journeyId, msg) => { onChatMessage(journeyId, msg).catch((err) => logger.warn({ err }, 'emoji guess')); });
}
