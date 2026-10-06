import type { EtaGame } from '@prisma/client';
import { prisma } from '../db/prisma';
import { config } from '../config';
import { hub } from '../realtime/hub';
import { haversineKm } from '../lib/geo';
import { tracker, type BusPosition } from '../tracking/gpsProvider';
import { creditRewardPoints } from './rewards';
import { S2C,  type EtaGameState } from '../shared/protocol';

/**
 * Asynchronous ETA guessing game — designed for 2G:
 *  - One tiny guess per passenger, no live leaderboard traffic.
 *  - Guesses lock 15 minutes before the bus is expected at the toll, so
 *    nobody can "guess" by watching the bus approach.
 *  - Resolved by the bus GPS crossing a 2 km geofence around the toll plaza.
 *  - Closest guess wins; ties go to whoever guessed first.
 */
const LOCK_BEFORE_MS = 15 * 60_000;
const GEOFENCE_KM = 2;
const fmt = (d: Date) => d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });

export function gameDto(g: EtaGame, guessCount: number, myGuess?: Date | null): EtaGameState {
  const winnerDeltaMin = null as number | null;
  return {
    id: g.id, checkpointName: g.checkpointName, status: g.status, closesAt: g.closesAt.toISOString(), guessCount,
    ...(myGuess !== undefined ? { myGuess: myGuess?.toISOString() ?? null } : {}),
    actualAt: g.actualAt?.toISOString() ?? null, winnerSeat: g.winnerSeat, winnerDeltaMin, rewardPoints: g.rewardPoints,
  };
}

async function publish(g: EtaGame, extra: Partial<EtaGameState> = {}) {
  const guessCount = await prisma.etaGuess.count({ where: { gameId: g.id } });
  hub.emitToJourney(g.journeyId, S2C.GAME, { ...gameDto(g, guessCount), ...extra });
}

export async function currentGame(journeyId: string, me?: { seat: string }): Promise<EtaGameState | null> {
  const g = await prisma.etaGame.findFirst({ where: { journeyId }, orderBy: { createdAt: 'desc' } });
  if (!g) return null;
  if (g.status === 'RESOLVED' && g.actualAt && Date.now() - +g.actualAt > 45 * 60_000) return null;
  const [guessCount, mine] = await Promise.all([
    prisma.etaGuess.count({ where: { gameId: g.id } }),
    me ? prisma.etaGuess.findUnique({ where: { gameId_seatNumber: { gameId: g.id, seatNumber: me.seat } } }) : null,
  ]);
  const winnerDeltaMin = await winnerDelta(g);
  return { ...gameDto(g, guessCount, me ? mine?.guessAt ?? null : undefined), winnerDeltaMin };
}

async function winnerDelta(g: EtaGame) {
  if (!g.winnerSeat || !g.actualAt) return null;
  const w = await prisma.etaGuess.findUnique({ where: { gameId_seatNumber: { gameId: g.id, seatNumber: g.winnerSeat } } });
  return w ? Math.round(Math.abs(+w.guessAt - +g.actualAt) / 60_000) : null;
}

export async function createEtaGameForNextToll(journeyId: string) {
  const open = await prisma.etaGame.findFirst({ where: { journeyId, status: { in: ['OPEN', 'LOCKED'] } } });
  if (open) return open;
  const j = await prisma.busJourney.findUniqueOrThrow({ where: { journeyId } });
  const pos = await tracker.getPosition(j);
  const toll = tracker.nextToll(j, pos?.progress ?? 0);
  if (!toll) return null;
  const closesAt = new Date(Math.max(Date.now() + 5 * 60_000, +toll.etaAt - LOCK_BEFORE_MS));
  const g = await prisma.etaGame.create({
    data: { journeyId, checkpointName: toll.name, checkpointLat: toll.lat, checkpointLng: toll.lng, closesAt, rewardPoints: config.ETA_GAME_REWARD_POINTS },
  });
  await publish(g);
  return g;
}

export async function submitGuess(journeyId: string, who: { pnr: string; seat: string }, gameId: string, guessAt: Date) {
  const g = await prisma.etaGame.findFirst({ where: { id: gameId, journeyId } });
  if (!g) return { ok: false as const, code: 'NOT_FOUND' as const };
  if (g.status !== 'OPEN' || +g.closesAt <= Date.now()) return { ok: false as const, code: 'GAME_CLOSED' as const };
  if (+guessAt < Date.now() || +guessAt > Date.now() + 24 * 3600_000) return { ok: false as const, code: 'INVALID' as const };
  try {
    await prisma.etaGuess.create({ data: { gameId, pnrNumber: who.pnr, seatNumber: who.seat, guessAt } });
  } catch (e: any) {
    if (e?.code === 'P2002') return { ok: false as const, code: 'ALREADY_GUESSED' as const };
    throw e;
  }
  await publish(g);
  return { ok: true as const, data: { ...(await currentGame(journeyId, { seat: who.seat }))! } };
}

export async function resolveGame(gameId: string, actualAt: Date) {
  const g = await prisma.etaGame.findUnique({ where: { id: gameId }, include: { guesses: true } });
  if (!g || g.status === 'RESOLVED') return g;
  const ranked = [...g.guesses].sort((a, b) =>
    Math.abs(+a.guessAt - +actualAt) - Math.abs(+b.guessAt - +actualAt) || +a.createdAt - +b.createdAt);
  const winner = ranked[0];
  const updated = await prisma.etaGame.update({
    where: { id: g.id },
    data: { status: 'RESOLVED', actualAt, winnerSeat: winner?.seatNumber ?? null, winnerPnr: winner?.pnrNumber ?? null },
  });
  const delta = winner ? Math.round(Math.abs(+winner.guessAt - +actualAt) / 60_000) : null;
  if (winner) await creditRewardPoints(winner.pnrNumber, g.rewardPoints, `ETA game ${g.id}`);
  await hub.broadcastToJourney(g.journeyId, 'SYSTEM', {
    text: winner
      ? `We crossed ${g.checkpointName} at ${fmt(actualAt)}. ${hub.nameOf(g.journeyId, winner.seatNumber)} was closest (${delta === 0 ? 'spot on' : `off by ${delta} min`}) and wins ${g.rewardPoints} AbhiBus points.`
      : `We crossed ${g.checkpointName} at ${fmt(actualAt)}. Nobody guessed this time.`,
  }, 'AbhiBus');
  await publish(updated, { winnerDeltaMin: delta });
  return updated;
}

/** Ticker hook: lock on time, resolve on geofence. */
export async function tickGame(journeyId: string, pos: BusPosition) {
  const g = await prisma.etaGame.findFirst({ where: { journeyId, status: { in: ['OPEN', 'LOCKED'] } } });
  if (!g) return;
  if (g.status === 'OPEN' && +g.closesAt <= Date.now()) await publish(await prisma.etaGame.update({ where: { id: g.id }, data: { status: 'LOCKED' } }));
  if (haversineKm(pos, { lat: g.checkpointLat, lng: g.checkpointLng }) <= GEOFENCE_KM) await resolveGame(g.id, new Date());
}
