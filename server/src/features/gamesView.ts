import type { GamePayload } from '../shared/protocol';
import { hintFor } from './gameBank';

/**
 * What a game looks like on the server (stored in the message payload, incl.
 * secrets) vs. what passengers receive. Secrets — the quiz answer, the movie
 * title — are only included once the game says so (time or solve).
 */
export type StoredGame =
  | { kind: 'QUIZ'; category: string; question: string; options: string[]; revealAt: string; correct: number }
  | { kind: 'EMOJI'; category: string; emojis: string; title: string; answers: string[]; hintAt: string; expiresAt: string; solvedBy: string | null; solvedAt: string | null }
  | { kind: 'TTT'; challenger: string; expiresAt: string }
  | { kind: 'SNL'; challenger: string; expiresAt: string }
  | { kind: 'RPS'; challenger: string; expiresAt: string; pick: number; opponent: string | null; opponentPick: number | null };

export function publicGame(g: StoredGame, now = Date.now()): GamePayload {
  switch (g.kind) {
    case 'QUIZ':
      return { kind: 'QUIZ', category: g.category, question: g.question, options: g.options, revealAt: g.revealAt, correct: now >= Date.parse(g.revealAt) ? g.correct : null };
    case 'EMOJI': {
      const over = !!g.solvedBy || now >= Date.parse(g.expiresAt);
      return {
        kind: 'EMOJI', category: g.category, emojis: g.emojis, wordCount: g.title.split(/\s+/).length,
        hint: over || now >= Date.parse(g.hintAt) ? hintFor(g.title) : null, hintAt: g.hintAt, expiresAt: g.expiresAt,
        solvedBy: g.solvedBy, solvedAt: g.solvedAt, answer: over ? g.title : null,
      };
    }
    case 'TTT':
      return { kind: 'TTT', challenger: g.challenger, expiresAt: g.expiresAt };
    case 'SNL':
      return { kind: 'SNL', challenger: g.challenger, expiresAt: g.expiresAt };
    case 'RPS': // the challenger's pick is secret until someone answers
      return { kind: 'RPS', challenger: g.challenger, expiresAt: g.expiresAt, opponent: g.opponent, challengerPick: g.opponent ? g.pick : null, opponentPick: g.opponentPick };
  }
}
