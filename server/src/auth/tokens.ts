import jwt from 'jsonwebtoken';
import { config } from '../config';

/**
 * Chat token = short-lived capability scoped to ONE seat on ONE journey.
 * It expires at the journey's purge time, so a leaked token dies with the chat.
 * Gender is intentionally NOT trusted from the token: women-room access is
 * re-checked against the database on every join (see realtime/gates.ts).
 */
export interface ChatClaims { jid: string; pnr: string; seat: string }

const ISSUER = 'abhibus-journey-chat';
const AUDIENCE = 'journey-chat-client';

export function signChatToken(claims: ChatClaims, expiresAt: Date): string {
  const expSec = Math.max(60, Math.floor((+expiresAt - Date.now()) / 1000));
  return jwt.sign(claims, config.JWT_SECRET, { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, expiresIn: expSec, subject: `${claims.jid}:${claims.seat}` });
}

export function verifyChatToken(token: string): ChatClaims {
  const p = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE }) as jwt.JwtPayload & ChatClaims;
  if (!p.jid || !p.pnr || !p.seat) throw new Error('malformed token');
  return { jid: p.jid, pnr: p.pnr, seat: p.seat };
}

/**
 * QR invite = a capability to join ONE bus chat as a guest, minted by a
 * PNR-verified passenger who is physically near the bus. It carries where the
 * provider was, so the scanner must be near both the provider and the bus.
 * Expires when the chat is purged.
 */
export interface QrClaims { jid: string; by: string; lat: number; lng: number }
const QR_AUDIENCE = 'journey-chat-qr';

export function signQrToken(claims: QrClaims, expiresAt: Date): string {
  const expSec = Math.max(60, Math.floor((+expiresAt - Date.now()) / 1000));
  return jwt.sign(claims, config.JWT_SECRET, { algorithm: 'HS256', issuer: ISSUER, audience: QR_AUDIENCE, expiresIn: expSec });
}

export function verifyQrToken(token: string): QrClaims {
  const p = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: QR_AUDIENCE }) as jwt.JwtPayload & QrClaims;
  if (!p.jid || !p.by || typeof p.lat !== 'number' || typeof p.lng !== 'number') throw new Error('malformed qr');
  return { jid: p.jid, by: p.by, lat: p.lat, lng: p.lng };
}
