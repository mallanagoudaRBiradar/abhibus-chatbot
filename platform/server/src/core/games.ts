import type { Member, Room } from '@prisma/client';
import { prisma } from '../db';
import { ApiError } from '../lib/errors';
import { logger } from '../lib/logger';
import { createMessage, pushUpdate, emitReactions, messageListeners, channelOf } from './messages';
import { getTenant, requireFeature } from './tenants';
import { display } from './identity';
import { EMOJI_BANK, QUIZ_BANK, normalise, pickRandom } from './gameBank';
import type { StoredGame } from './gamesView';
import { GAME_MOVE_PREFIX, tttState, type ChatMessage, type GameKind, type RoomType, type TttGame } from '../shared/protocol';
import { emitEvent } from './events';

/**
 * Room games: Bus Quiz (everyone, 25 s), Guess the Movie (type guesses in chat),
 * Tic-tac-toe (1v1, others watch). A game is a GAME message; each move is a
 * reaction row keyed `g:…`. Secrets (quiz answer, movie title) are stripped
 * by publicGame() until revealed.
 */
const QUIZ_SECONDS = 25, EMOJI_HINT = 45, EMOJI_SECONDS = 150, TTT_ACCEPT = 300;
const live = new Map<string, { id: string; until: number }>(); // one quiz/emoji round per channel
const locks = new Map<string, Promise<unknown>>();
const withLock = <T,>(id: string, fn: () => Promise<T>): Promise<T> => { const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn); locks.set(id, run.catch(() => undefined)); return run; };
const later = (ms: number, fn: () => Promise<unknown>) => setTimeout(() => { fn().catch((err) => logger.warn({ err }, 'game timer')); }, ms).unref();

const nameOf = async (room: Room, id: string) => {
  const m = await prisma.member.findUnique({ where: { id } });
  return m ? display(m, (await getTenant(room.tenantId)).cfg.identity.mode).name : 'Someone';
};
const sys = (room: Room, rt: RoomType, text: string) => createMessage(room.id, rt, { senderName: 'Tara', contentType: 'SYSTEM', payload: { text } });

export async function startGame(room: Room, rt: RoomType, m: Member | null, kind: GameKind, clientMsgId?: string, sponsor?: string) {
  await requireFeature(room, 'games');
  const key = `${room.id}:${rt}`;
  const now = Date.now();
  if ((kind === 'QUIZ' || kind === 'EMOJI') && (live.get(key)?.until ?? 0) > now) throw new ApiError('room_state', 'A game is already running in this chat. Join that one!');
  let game: StoredGame; let label: string;
  if (kind === 'QUIZ') {
    const q = pickRandom(QUIZ_BANK);
    const order = q.options.map((_, i) => i).sort(() => Math.random() - 0.5);
    game = { kind, category: q.category, question: q.question, options: order.map((i) => q.options[i]), correct: order.indexOf(q.answer), revealAt: new Date(now + QUIZ_SECONDS * 1000).toISOString() };
    label = 'Bus Quiz';
  } else if (kind === 'EMOJI') {
    const e = pickRandom(EMOJI_BANK);
    game = { kind, category: e.category, emojis: e.emojis, title: e.title, answers: e.answers, solvedBy: null, solvedAt: null, hintAt: new Date(now + EMOJI_HINT * 1000).toISOString(), expiresAt: new Date(now + EMOJI_SECONDS * 1000).toISOString() };
    label = 'Guess the Movie';
  } else {
    if (!m) throw new ApiError('invalid_request', 'Tic-tac-toe needs a challenger.');
    game = { kind, challenger: m.id, expiresAt: new Date(now + TTT_ACCEPT * 1000).toISOString() };
    label = 'Tic-tac-toe';
  }
  const msg = await createMessage(room.id, rt, { senderId: m?.id ?? null, senderName: m ? await nameOf(room, m.id) : sponsor ?? 'Tara', contentType: 'GAME', payload: { game, sponsor: sponsor ?? null }, clientMsgId });
  if (game.kind === 'QUIZ') { live.set(key, { id: msg.id, until: Date.parse(game.revealAt) }); later(QUIZ_SECONDS * 1000 + 300, () => pushUpdate(msg.id)); }
  if (game.kind === 'EMOJI') {
    const g = game;
    live.set(key, { id: msg.id, until: Date.parse(g.expiresAt) });
    later(EMOJI_HINT * 1000 + 300, () => pushUpdate(msg.id));
    later(EMOJI_SECONDS * 1000 + 300, async () => { const cur = await load(msg.id); if (cur?.game.kind === 'EMOJI' && !cur.game.solvedBy) { live.delete(key); await pushUpdate(msg.id); await sys(room, rt, `⏰ Nobody got it — the movie was ${g.title}`); } });
  }
  if (game.kind === 'TTT') later(TTT_ACCEPT * 1000 + 300, () => pushUpdate(msg.id));
  await emitEvent(room.tenantId, room.id, 'game.started', { room_id: room.id, game: kind, label, message_id: msg.id, sponsor: sponsor ?? null });
  return msg;
}

async function load(id: string) {
  const m = await prisma.message.findUnique({ where: { id }, include: { reactions: { orderBy: { createdAt: 'asc' } } } });
  const game = (m?.payload as any)?.game as StoredGame | undefined;
  if (!m || !game) return null;
  const reactions: Record<string, string[]> = {};
  for (const r of m.reactions) (reactions[r.key] ??= []).push(r.memberId);
  return { m, game, reactions };
}

export type GameMove = { type: 'answer'; option: number } | { type: 'join' } | { type: 'cell'; cell: number };
export function makeMove(room: Room, member: Member, messageId: string, move: GameMove) {
  return withLock(messageId, async () => {
    const g = await load(messageId);
    if (!g) throw new ApiError('not_found', 'Game not found.');
    const add = (k: string) => prisma.reaction.create({ data: { messageId, memberId: member.id, key: `${GAME_MOVE_PREFIX}${k}` } });
    if (g.game.kind === 'QUIZ' && move.type === 'answer') {
      if (Date.now() >= Date.parse(g.game.revealAt)) throw new ApiError('room_state', 'Answers are closed.');
      if (Object.entries(g.reactions).some(([k, s]) => k.startsWith(`${GAME_MOVE_PREFIX}a`) && s.includes(member.id))) throw new ApiError('invalid_request', 'You’ve already locked in an answer.');
      await add(`a${move.option}`);
    } else if (g.game.kind === 'TTT' && (move.type === 'join' || move.type === 'cell')) {
      const st = tttState(g.game as TttGame, g.reactions);
      if (move.type === 'join') {
        if (member.id === g.game.challenger) throw new ApiError('invalid_request', 'You can’t accept your own challenge.');
        if (st.opponent) throw new ApiError('room_state', 'Someone already accepted.');
        await add('join');
      } else {
        if (st.turn !== member.id) throw new ApiError('invalid_request', st.turn ? 'Wait for your turn.' : 'This game is over.');
        if (st.board[move.cell]) throw new ApiError('invalid_request', 'That square is taken.');
        await add(`m${move.cell}`);
        const after = tttState(g.game as TttGame, { ...g.reactions, [`${GAME_MOVE_PREFIX}m${move.cell}`]: [member.id] });
        const ch = await prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: { channel: true } });
        const rt: RoomType = ch.channel.kind === 'MAIN' ? 'MAIN_COMMON' : 'WOMEN_ONLY';
        if (after.winner) { const loser = after.winner === g.game.challenger ? after.opponent! : g.game.challenger; void sys(room, rt, `🏆 ${await nameOf(room, after.winner)} beat ${await nameOf(room, loser)} at tic-tac-toe`); }
        else if (after.draw) void sys(room, rt, `🤝 ${await nameOf(room, g.game.challenger)} and ${await nameOf(room, after.opponent!)} drew at tic-tac-toe`);
      }
    } else throw new ApiError('invalid_request', 'That move doesn’t fit this game.');
    await emitReactions(messageId);
  });
}

/** Every chat message is a possible guess for the channel's running movie puzzle. */
messageListeners.push((roomId, msg: ChatMessage) => {
  if (msg.contentType !== 'TEXT' || !msg.senderSeat) return;
  const key = `${roomId}:${msg.roomType}`;
  const cur = live.get(key);
  if (!cur || cur.until < Date.now()) return;
  void withLock(cur.id, async () => {
    const g = await load(cur.id);
    if (!g || g.game.kind !== 'EMOJI' || g.game.solvedBy) return;
    const guess = ` ${normalise(String(msg.payload?.text ?? ''))} `;
    const squashed = guess.replace(/ /g, '');
    const hit = g.game.answers.some((a) => { const n = normalise(a); return guess.includes(` ${n} `) || (n.length >= 5 && squashed.includes(n.replace(/ /g, ''))); });
    if (!hit) return;
    live.delete(key);
    const game = { ...g.game, solvedBy: msg.senderSeat, solvedAt: new Date().toISOString() };
    await prisma.message.update({ where: { id: cur.id }, data: { payload: { ...(g.m.payload as object), game } } });
    await pushUpdate(cur.id);
    const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    const secs = Math.round((Date.now() - g.m.createdAt.getTime()) / 1000);
    await sys(room, msg.roomType, `🎉 ${msg.senderHandle} got it in ${secs}s — ${game.title}`);
  }).catch((err) => logger.warn({ err }, 'emoji guess'));
});

export const GAMES_CATALOG = [
  { id: 'QUIZ', name: 'Bus Quiz (trip trivia)', players: '1–50', duration: '25 s' },
  { id: 'EMOJI', name: 'Guess the Movie', players: '1–50', duration: '2.5 min' },
  { id: 'TTT', name: 'Tic-tac-toe', players: '2 (others watch)', duration: '~2 min' },
];
export { channelOf };
