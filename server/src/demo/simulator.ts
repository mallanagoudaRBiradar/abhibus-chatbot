import { prisma } from '../db/prisma';
import { hub } from '../realtime/hub';
import { logger } from '../lib/logger';
import { DEMO } from './demoData';
import { journeyIdFor } from '../booking/types';
import { startRestStop } from '../features/restStop';
import { createEtaGameForNextToll } from '../features/etaGame';
import { roomKey, STICKER_IDS, REACTIONS, TTT_LINES, tttState, type RoomType, type TttGame } from '../shared/protocol';
import { makeMove, startGame, tttListeners } from '../features/miniGames';
import { checkMajorityRemoval, reportListeners } from '../features/moderationService';
import { EMOJI_BANK } from '../features/gameBank';
import type { StoredGame } from '../features/gamesView';

/**
 * DEMO ONLY. Brings the bus to life with simulated co-passengers so a single
 * phone in a boardroom shows a believable, busy trip. Only runs while at least
 * one real passenger is connected. Never enabled in production (config guard).
 */
const MAIN_LINES = [
  'Anyone know if we stop at Kurnool for dinner?',
  'AC is freezing at the back 🥶',
  'Charging point near 14L isn’t working, fyi',
  'Roads are super smooth after Jadcherla 👌',
  'How long till Anantapur?',
  'Can we get the music a bit lower please',
  'Thanks conductor anna for the extra blanket 🙏',
  'Anyone getting down at Hebbal?',
  'First time on this route. Is it always this quick?',
  'Window seat views are 🔥 under this moon',
];
const WOMEN_LINES = [
  'Travelling solo tonight. Glad this room exists',
  'Washroom at the last stop was clean, fyi',
  'Which drop point is best late at night in Bengaluru?',
  'I’m in 6L, I have a spare charger if anyone needs',
  'Bus feels safe, the conductor checked on all of us 🙏',
];
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export async function startDemoSimulator() {
  const journeyId = journeyIdFor(DEMO.serviceId, DEMO.journeyDate());
  const women = DEMO.crowd.filter((c) => c.gender === 'F').map((c) => c.seat);
  const all = DEMO.crowd.map((c) => c.seat);
  const realOnline = async () => (await hub.io.in(roomKey(journeyId, 'MAIN_COMMON')).fetchSockets()).length > 0;

  hub.virtualSeats = (jid, rt) => (jid !== journeyId ? [] : rt === 'WOMEN_ONLY' ? women.slice(0, 3) : all.slice(0, 10));
  hub.virtualMembers = (jid, rt) => (jid !== journeyId ? [] : DEMO.crowd
    .filter((c) => rt !== 'WOMEN_ONLY' || c.gender === 'F')
    .map((c) => ({ seat: c.seat, gender: c.gender, name: c.name, avatar: c.avatar, guest: false })));
  for (const c of DEMO.crowd) hub.setProfile(journeyId, c.seat, { name: c.name, avatar: c.avatar, guest: false });

  let kickedOff = false;
  const post = async (roomType: RoomType, seat: string) => {
    const sticker = Math.random() < 0.25;
    await hub.createMessage(journeyId, roomType, {
      senderSeat: seat, senderHandle: hub.nameOf(journeyId, seat),
      contentType: sticker ? 'STICKER' : 'TEXT',
      payload: sticker ? { stickerId: pick(STICKER_IDS) } : { text: pick(roomType === 'WOMEN_ONLY' ? WOMEN_LINES : MAIN_LINES) },
    });
  };

  // Real passenger messages get "seen" and sometimes reacted to by the crowd.
  hub.onPassengerMessage.push((jid, msg) => {
    if (jid !== journeyId || all.includes(msg.senderSeat!)) return;
    const pool = msg.roomType === 'WOMEN_ONLY' ? women : all;
    const readers = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.ceil(rand(2, pool.length * 0.8)));
    readers.forEach((seat, i) => setTimeout(async () => {
      try {
        await prisma.readReceipt.create({ data: { messageId: msg.id, pnrNumber: 'DEMO', seatNumber: seat } });
        hub.queueReceipts(journeyId, msg.roomType, [msg.id], seat);
        if (msg.contentType === 'GAME') return; // games get their own crowd behaviour below
        if (msg.contentType === 'POLL' && Math.random() < 0.8) {
          // Most readers vote on a poll, so a demo poll fills up like a real bus would.
          const n = (msg.payload as { options: string[] }).options.length;
          await prisma.messageReaction.create({ data: { messageId: msg.id, seatNumber: seat, emoji: `poll:${Math.floor(Math.random() * n)}` } });
          const rs = await prisma.messageReaction.findMany({ where: { messageId: msg.id } });
          const reactions: Record<string, string[]> = {};
          rs.forEach((r) => (reactions[r.emoji] ??= []).push(r.seatNumber));
          hub.io.to(roomKey(journeyId, msg.roomType)).emit('reactions:update', { roomType: msg.roomType, messageId: msg.id, reactions });
        } else if (i === 0 && msg.contentType !== 'POLL' && Math.random() < 0.5) {
          const emoji = pick(REACTIONS);
          await prisma.messageReaction.create({ data: { messageId: msg.id, seatNumber: seat, emoji } });
          const rs = await prisma.messageReaction.findMany({ where: { messageId: msg.id } });
          const reactions: Record<string, string[]> = {};
          rs.forEach((r) => (reactions[r.emoji] ??= []).push(r.seatNumber));
          hub.io.to(roomKey(journeyId, msg.roomType)).emit('reactions:update', { roomType: msg.roomType, messageId: msg.id, reactions });
        }
      } catch { /* message may be gone */ }
    }, rand(1200, 6000) * (i + 1) * 0.6));
  });

  // ---- mini games: the crowd plays along so a demo game never sits empty ----
  const stored = async (messageId: string) => ((await prisma.message.findUnique({ where: { messageId } }))?.payload as any)?.game as StoredGame | undefined;
  const say = (roomType: RoomType, seat: string, text: string) =>
    hub.createMessage(journeyId, roomType, { senderSeat: seat, senderHandle: hub.nameOf(journeyId, seat), contentType: 'TEXT', payload: { text } });

  hub.onPassengerMessage.push((jid, msg) => {
    if (jid !== journeyId || msg.contentType !== 'GAME') return;
    const pool = msg.roomType === 'WOMEN_ONLY' ? women : all;
    const players = [...pool].filter((s) => s !== msg.senderSeat).sort(() => Math.random() - 0.5);
    const g = msg.payload as { kind: string };
    if (g.kind === 'QUIZ') {
      players.slice(0, Math.ceil(rand(3, Math.min(7, players.length)))).forEach((seat) => setTimeout(async () => {
        const game = await stored(msg.id);
        if (game?.kind !== 'QUIZ') return;
        const option = Math.random() < 0.65 ? game.correct : Math.floor(Math.random() * game.options.length);
        await makeMove(journeyId, seat, msg.id, { type: 'answer', option }, () => true).catch(() => {});
      }, rand(3000, 20000)));
    } else if (g.kind === 'EMOJI') {
      setTimeout(async () => {
        const game = await stored(msg.id);
        if (game?.kind !== 'EMOJI' || game.solvedBy) return;
        const wrong = EMOJI_BANK.find((e) => e.title !== game.title)!;
        await say(msg.roomType, players[0], `Is it ${wrong.title}? 🤔`);
      }, rand(15000, 30000));
      if (Math.random() < 0.7) setTimeout(async () => {
        const game = await stored(msg.id);
        if (game?.kind !== 'EMOJI' || game.solvedBy) return;
        await say(msg.roomType, players[1] ?? players[0], `${game.title}!!`);
      }, rand(55000, 85000));
    } else if (g.kind === 'TTT' && !all.includes(msg.senderSeat!)) {
      setTimeout(() => void makeMove(journeyId, players[0], msg.id, { type: 'join' }, () => true).catch(() => {}), rand(3000, 6000));
    }
  });

  // Simple tic-tac-toe bot: win if it can, block if it must, else centre / corner / anything.
  tttListeners.push((jid, roomType, messageId) => {
    if (jid !== journeyId) return;
    setTimeout(async () => {
      const m = await prisma.message.findUnique({ where: { messageId }, include: { reactions: { orderBy: { createdAt: 'asc' } } } });
      const game = (m?.payload as any)?.game as TttGame | undefined;
      if (!m || game?.kind !== 'TTT') return;
      const reactions: Record<string, string[]> = {};
      for (const r of m.reactions) (reactions[r.emoji] ??= []).push(r.seatNumber);
      const st = tttState(game, reactions);
      if (!st.turn || !all.includes(st.turn)) return;
      const me = st.turn;
      const free = st.board.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
      const finishing = (who: (c: string | null) => boolean) => {
        for (const l of TTT_LINES) {
          const cells = l.map((i) => st.board[i]);
          if (cells.filter(who).length === 2 && cells.includes(null)) return l[cells.indexOf(null)];
        }
        return -1;
      };
      let cell = finishing((c) => c === me);
      if (cell < 0) cell = finishing((c) => !!c && c !== me);
      if (cell < 0) cell = [4, 0, 2, 6, 8].find((i) => free.includes(i)) ?? free[0];
      if (cell == null || cell < 0) return;
      await makeMove(journeyId, me, messageId, { type: 'cell', cell }, () => true).catch(() => {});
    }, rand(1200, 2600));
  });

  // ---- moderation demo: one passenger misbehaves; if a real user reports it, the crowd backs them up ----
  const TROLL = '8W';
  const removedCrowd = new Set<string>();
  reportListeners.push((jid, roomType, reportedSeat) => {
    if (jid !== journeyId || reportedSeat !== TROLL || removedCrowd.has(TROLL)) return;
    void (async () => {
      const members = (await hub.presence(journeyId, roomType)).count;
      const needed = Math.floor(members / 2) + 1;
      const backers = all.filter((x) => x !== TROLL).slice(0, Math.max(0, needed - 1));
      const lastTroll = await prisma.message.findFirst({ where: { senderSeat: TROLL, room: { journeyId } }, orderBy: { createdAt: 'desc' }, include: { room: true } });
      if (!lastTroll) return;
      for (const [i, seat] of backers.entries()) {
        await new Promise((r) => setTimeout(r, 400 + i * 250));
        await prisma.messageReport.create({
          data: {
            journeyId, messageId: lastTroll.messageId, reporterPnr: `DEMO-${seat}`, reporterSeat: seat, reportedSeat: TROLL, reason: 'HARASSMENT',
            contentSnapshot: { contentType: lastTroll.contentType, payload: lastTroll.payload as object, sentAt: lastTroll.createdAt.toISOString(), room: lastTroll.room.roomType },
            retainUntil: new Date(Date.now() + 30 * 24 * 3600_000),
          },
        }).catch(() => {});
      }
      await checkMajorityRemoval(journeyId, roomType, TROLL);
      removedCrowd.add(TROLL);
    })().catch((err) => logger.debug({ err }, 'demo co-report failed'));
  });

  const loop = async () => {
    try {
      if (await realOnline()) {
        if (!kickedOff) {
          kickedOff = true;
          // A short scripted opening so the first impression is a living bus.
          setTimeout(() => hub.broadcastToJourney(journeyId, 'BROADCAST', { kind: 'ANNOUNCEMENT', text: 'Good evening, everyone. Dinner stop in about 20 minutes. Please keep your tickets handy.' }), 3000);
          setTimeout(() => startRestStop(journeyId, { label: 'Dinner stop', durationMin: 15, place: 'Hotel Highway Treat, Kurnool' }), 25_000);
          setTimeout(async () => {
            const g = await createEtaGameForNextToll(journeyId);
            if (g) for (const seat of all.slice(0, 5)) {
              const guess = new Date(+g.closesAt + rand(5, 30) * 60_000);
              await prisma.etaGuess.create({ data: { gameId: g.id, pnrNumber: `DEMO-${seat}`, seatNumber: seat, guessAt: guess } }).catch(() => {});
            }
          }, 8000);
          setTimeout(() => void say('MAIN_COMMON', TROLL, 'Any girls travelling alone tonight? Come sit near 8W, I’ll keep you company 😏'), 70_000);
          // A passenger kicks off "Guess the movie" so the demo shows games without a tap.
          setTimeout(() => void startGame(journeyId, 'MAIN_COMMON', pick(all), 'EMOJI', `demo-emoji-${Date.now()}`).catch(() => {}), 40_000);
        }
        await post('MAIN_COMMON', pick(all.filter((x) => !removedCrowd.has(x))));
        if (Math.random() < 0.35) await post('WOMEN_ONLY', pick(women));
      }
    } catch (err) {
      logger.debug({ err }, 'simulator tick skipped');
    }
    setTimeout(() => void loop(), rand(9000, 18000));
  };
  setTimeout(() => void loop(), 6000);
  logger.info({ journeyId }, '🎬 demo simulator running');
}
