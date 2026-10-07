import React, { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Ionicons } from './icons';
import * as Haptics from '../services/haptics';
import { Txt } from './Txt';
import { useServerNow } from '../hooks/useNow';
import { personFrom } from '../hooks/usePeople';
import { useChat } from '../store/chatStore';
import { mmss } from '../utils/format';
import { font, palette, radius, themed } from '../theme/tokens';
import {
  RPS_NAMES, RPS_PICKS, SNL_JUMPS, SNL_MAX_PLAYERS, quizAnswers, rpsBeats, snlState, tttState,
  type EmojiGame, type GamePayload, type QuizGame, type RpsGame, type SnlGame, type TttGame,
} from '../shared/protocol';

/** Seat id → display name (seats are never shown). */
const nameOf = (seat: string) => personFrom(useChat.getState(), seat).name;

export type GameMoveInput =
  | { type: 'answer'; option: number } | { type: 'join' } | { type: 'cell'; cell: number }
  | { type: 'start' } | { type: 'roll' } | { type: 'pick'; pick: number };

interface Props {
  game: GamePayload | { kind: GamePayload['kind']; pending: true };
  reactions: Record<string, string[]>;
  mySeat: string;
  accent: string;
  createdAt: string;
  onMove: (move: GameMoveInput) => void;
}

const TITLES: Record<GamePayload['kind'], { emoji: string; title: string }> = {
  QUIZ: { emoji: '🧠', title: 'BUS QUIZ' },
  EMOJI: { emoji: '🎬', title: 'GUESS THE MOVIE' },
  TTT: { emoji: '❌⭕', title: 'TIC-TAC-TOE' },
  SNL: { emoji: '🎲', title: 'SNAKES & LADDERS' },
  RPS: { emoji: '✊', title: 'ROCK PAPER SCISSORS' },
};

/** In-chat mini game card. Quiz and movie puzzles are for the whole room; tic-tac-toe is 1v1 with spectators. */
export function GameCard(p: Props) {
  if ('pending' in p.game) {
    return (
      <View style={[styles.wrap, styles.row]}>
        <ActivityIndicator color={p.accent} />
        <Txt v="smallStrong" color={palette.textSecondary}>{`Starting ${TITLES[p.game.kind].title.toLowerCase()}…`}</Txt>
      </View>
    );
  }
  if (p.game.kind === 'QUIZ') return <Quiz {...p} game={p.game} />;
  if (p.game.kind === 'EMOJI') return <Emoji {...p} game={p.game} />;
  if (p.game.kind === 'SNL') return <Snl {...p} game={p.game} />;
  if (p.game.kind === 'RPS') return <Rps {...p} game={p.game} />;
  return <Ttt {...p} game={p.game} />;
}

function Header({ kind, sub, right }: { kind: GamePayload['kind']; sub?: string; right?: React.ReactNode }) {
  return (
    <View style={styles.head}>
      <Txt style={{ fontSize: 14, lineHeight: 18 }}>{TITLES[kind].emoji}</Txt>
      <Txt v="micro" color={palette.textTertiary} style={{ letterSpacing: 0.7, flex: 1 }} numberOfLines={1}>
        {sub ? `${TITLES[kind].title} · ${sub.toUpperCase()}` : TITLES[kind].title}
      </Txt>
      {right}
    </View>
  );
}

/** Ticking pill; only mounted while a game is live, so finished cards don't keep timers running. */
function Countdown({ until, label, tone }: { until: string; label?: string; tone: string }) {
  const now = useServerNow(500);
  const left = Math.max(0, Date.parse(until) - now);
  return (
    <View style={[styles.pill, { borderColor: tone }]}>
      <Ionicons name="time-outline" size={11} color={tone} />
      <Txt v="micro" color={tone} style={{ fontVariant: ['tabular-nums'] }}>{label ? `${label} ${mmss(left)}` : mmss(left)}</Txt>
    </View>
  );
}

// ================================================================ Quiz ===
function Quiz({ game, reactions, mySeat, accent, onMove }: Props & { game: QuizGame }) {
  const now = useServerNow(1000);
  const answers = quizAnswers(reactions, game.options.length);
  const mine = answers.findIndex((seats) => seats.includes(mySeat));
  const revealed = game.correct != null;
  const open = !revealed && now < Date.parse(game.revealAt);
  const total = answers.reduce((n, a) => n + a.length, 0);
  const right = revealed ? answers[game.correct!] : [];
  const fastest = right[0];

  return (
    <View style={styles.wrap}>
      <Header kind="QUIZ" sub={game.category} right={open ? <Countdown until={game.revealAt} tone={accent} /> : null} />
      <Txt v="bodyStrong" style={{ marginBottom: 8 }}>{game.question}</Txt>
      <View style={{ gap: 6 }}>
        {game.options.map((opt, i) => {
          const isMine = mine === i;
          const isRight = revealed && game.correct === i;
          const isWrongPick = revealed && isMine && !isRight;
          const canTap = open && mine < 0;
          return (
            <Pressable key={i} disabled={!canTap} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onMove({ type: 'answer', option: i }); }}
              style={({ pressed }) => [
                styles.answer,
                isMine && !revealed && { borderColor: accent, backgroundColor: palette.cyanSoft },
                isRight && { borderColor: palette.green, backgroundColor: palette.greenSoft },
                isWrongPick && { borderColor: palette.red, backgroundColor: palette.redSoft },
                !canTap && !isMine && !isRight && { opacity: revealed ? 0.7 : 0.55 },
                pressed && { opacity: 0.7 },
              ]}
              accessibilityRole="button" accessibilityState={{ selected: isMine, disabled: !canTap }}
              accessibilityLabel={`${opt}${isRight ? ', correct answer' : ''}${isMine ? ', your answer' : ''}`}>
              <Txt v="body" style={{ flex: 1 }}>{opt}</Txt>
              {revealed && <Txt v="smallStrong" color={palette.textSecondary} style={{ fontVariant: ['tabular-nums'] }}>{answers[i].length}</Txt>}
              {isRight && <Ionicons name="checkmark-circle" size={18} color={palette.green} />}
              {isWrongPick && <Ionicons name="close-circle" size={18} color={palette.red} />}
              {isMine && !revealed && <Ionicons name="lock-closed" size={14} color={accent} />}
            </Pressable>
          );
        })}
      </View>
      <View style={styles.footer}>
        {!revealed ? (
          <Txt v="meta" color={palette.textSecondary}>
            {mine >= 0 ? `Locked in · ${total} answered · result when the timer ends` : open ? `${total} answered · tap to lock in your answer` : 'Revealing…'}
          </Txt>
        ) : (
          <Txt v="meta" color={palette.textSecondary}>
            {mine === game.correct ? 'You got it! 🎉  ' : mine >= 0 ? 'Not this time.  ' : ''}
            {fastest ? `⚡ Fastest: ${fastest === mySeat ? 'You' : nameOf(fastest)} · ${right.length} of ${total} right` : total ? `Nobody got it · ${total} answered` : 'Nobody answered'}
          </Txt>
        )}
      </View>
    </View>
  );
}

// =============================================================== Emoji ===
function Emoji({ game, mySeat, accent, createdAt }: Props & { game: EmojiGame }) {
  const now = useServerNow(1000);
  const solved = !!game.solvedBy;
  const expired = !solved && now >= Date.parse(game.expiresAt);
  const live = !solved && !expired;
  const secs = solved ? Math.round((Date.parse(game.solvedAt!) - Date.parse(createdAt)) / 1000) : 0;

  return (
    <View style={styles.wrap}>
      <Header kind="EMOJI" sub={game.category} right={live ? <Countdown until={game.expiresAt} tone={accent} /> : null} />
      <Txt style={styles.emojis} accessibilityLabel={`Emoji clue: ${game.emojis}`}>{game.emojis}</Txt>
      <Txt v="meta" color={palette.textTertiary} style={{ textAlign: 'center' }}>{`${game.wordCount} word${game.wordCount === 1 ? '' : 's'}`}</Txt>

      {live ? (
        <View style={styles.footer}>
          <View style={styles.row}>
            <Ionicons name="chatbubble-ellipses-outline" size={15} color={accent} />
            <Txt v="smallStrong" style={{ flex: 1 }}>Type your guess in the chat</Txt>
          </View>
          {game.hint ? (
            <Txt v="small" color={palette.textSecondary} style={{ marginTop: 6 }}>
              {'Hint: '}<Txt v="smallStrong" style={{ fontFamily: font.display, letterSpacing: 1 }}>{game.hint}</Txt>
            </Txt>
          ) : (
            <View style={{ marginTop: 6, alignSelf: 'flex-start' }}><Countdown until={game.hintAt} label="Hint in" tone={palette.textTertiary} /></View>
          )}
        </View>
      ) : (
        <View style={[styles.result, { borderColor: solved ? palette.green : palette.hairlineStrong }]}>
          <Txt v="micro" color={palette.textTertiary} style={{ letterSpacing: 0.7 }}>{solved ? 'SOLVED' : 'TIME’S UP'}</Txt>
          <Txt v="title" style={{ textAlign: 'center' }}>{game.answer}</Txt>
          <Txt v="meta" color={palette.textSecondary}>
            {solved ? (game.solvedBy === mySeat ? `You got it in ${secs}s! 🎉` : `${nameOf(game.solvedBy!)} got it in ${secs}s`) : 'Nobody guessed it'}
          </Txt>
        </View>
      )}
    </View>
  );
}

// ========================================================= Tic-tac-toe ===
function Ttt({ game, reactions, mySeat, accent, onMove }: Props & { game: TttGame }) {
  const now = useServerNow(5000);
  const st = tttState(game, reactions);
  const iPlay = mySeat === game.challenger || mySeat === st.opponent;
  const expired = !st.opponent && now >= Date.parse(game.expiresAt);
  const over = !!st.winner || st.draw;

  let status: string;
  let statusColor: string = palette.textSecondary;
  if (!st.opponent) status = expired ? 'Challenge expired' : mySeat === game.challenger ? 'Waiting for someone to accept…' : 'Anyone on the bus can accept';
  else if (st.winner) { status = st.winner === mySeat ? 'You won! 🏆' : `${nameOf(st.winner)} won 🏆`; statusColor = st.winner === mySeat ? palette.green : palette.text; }
  else if (st.draw) status = 'It’s a draw 🤝';
  else if (st.turn === mySeat) { status = 'Your turn'; statusColor = accent; }
  else status = `${nameOf(st.turn!)}’s turn${iPlay ? '' : ' · you’re watching'}`;

  return (
    <View style={styles.wrap}>
      <Header kind="TTT" />
      <View style={styles.players}>
        <Player seat={game.challenger} mark="✕" me={mySeat === game.challenger} active={st.turn === game.challenger} />
        <Txt v="micro" color={palette.textTertiary}>VS</Txt>
        {st.opponent
          ? <Player seat={st.opponent} mark="○" me={mySeat === st.opponent} active={st.turn === st.opponent} />
          : <Txt v="smallStrong" color={palette.textTertiary} style={{ flex: 1, textAlign: 'center' }}>?</Txt>}
      </View>

      {st.opponent ? (
        <View style={styles.board} accessibilityLabel="Tic-tac-toe board">
          {st.board.map((cell, i) => {
            const mine = st.turn === mySeat && !cell && !over;
            const win = st.line?.includes(i);
            return (
              <Pressable key={i} disabled={!mine} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onMove({ type: 'cell', cell: i }); }}
                style={({ pressed }) => [styles.cell, win && { backgroundColor: palette.greenSoft, borderColor: palette.green }, mine && { borderColor: accent }, pressed && { opacity: 0.6 }]}
                accessibilityRole="button" accessibilityLabel={`Square ${i + 1}${cell ? `, ${cell === game.challenger ? 'X' : 'O'}` : mine ? ', empty, tap to play' : ', empty'}`}>
                {cell && (
                  <Txt style={styles.mark} color={cell === game.challenger ? palette.cyan : palette.rose}>{cell === game.challenger ? '✕' : '○'}</Txt>
                )}
              </Pressable>
            );
          })}
        </View>
      ) : !expired && mySeat !== game.challenger ? (
        <Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onMove({ type: 'join' }); }}
          style={({ pressed }) => [styles.accept, { backgroundColor: accent }, pressed && { opacity: 0.85 }]} accessibilityRole="button">
          <Txt v="bodyStrong" color={palette.onCyan}>{`Accept ${nameOf(game.challenger)}’s challenge`}</Txt>
        </Pressable>
      ) : null}

      <View style={styles.footer}><Txt v="smallStrong" color={statusColor} style={{ textAlign: 'center' }}>{status}</Txt></View>
    </View>
  );
}

// ==================================================== Snakes & ladders ===
const SNL_CELL = 26;
/** Square number at grid row r (0 = top) and column c, boustrophedon like a real board (1 bottom-left, 100 top-left). */
const squareAt = (r: number, c: number) => { const row = 9 - r; return row * 10 + (row % 2 === 0 ? c + 1 : 10 - c); };
const tokenColors = () => [palette.red, '#4EA8FF', palette.amber, palette.green];

function Snl({ game, reactions, mySeat, accent, onMove }: Props & { game: SnlGame }) {
  const now = useServerNow(5000);
  const [boardOpen, setBoardOpen] = useState(false); // compact in the chat; the board opens only when someone taps
  const st = snlState(game, reactions);
  const colors = tokenColors();
  const colorOf = (seat: string) => colors[Math.max(0, st.players.indexOf(seat))];
  const inGame = st.players.includes(mySeat);
  const expired = !st.started && now >= Date.parse(game.expiresAt);
  const host = mySeat === game.challenger;
  const name = (seat: string) => (seat === mySeat ? 'You' : nameOf(seat));

  let status: string;
  let statusColor: string = palette.textSecondary;
  if (st.winner) { status = st.winner === mySeat ? 'You won! 🏆' : `${nameOf(st.winner)} won 🏆`; statusColor = st.winner === mySeat ? palette.green : palette.text; }
  else if (!st.started) status = expired ? 'Game expired' : `${st.players.length}/${SNL_MAX_PLAYERS} players · ${host ? 'start when ready' : inGame ? 'waiting for the host to start' : 'join before it starts'}`;
  else if (st.turn === mySeat) { status = 'Your turn — roll!'; statusColor = accent; }
  else status = `${nameOf(st.turn!)}’s turn${inGame ? '' : ' · you’re watching'}`;

  const last = st.last;
  const lastLine = last ? `${name(last.seat)} rolled ${last.die}${last.via === 'ladder' ? ` · ladder up to ${last.to} 🪜` : last.via === 'snake' ? ` · snake down to ${last.to} 🐍` : last.from === last.to ? ' · needs an exact roll' : ` · now on ${last.to}`}` : null;

  return (
    <View style={[styles.wrap, boardOpen && { width: 10 * SNL_CELL + 4 }]}>
      <Header kind="SNL" right={!st.started && !expired ? <Countdown until={game.expiresAt} tone={palette.textTertiary} /> : null} />
      <View style={styles.snlPlayers}>
        {st.players.map((seat) => (
          <View key={seat} style={[styles.snlPlayer, st.turn === seat && { borderColor: colorOf(seat) }]}>
            <View style={[styles.token, { backgroundColor: colorOf(seat), position: 'relative' }]} />
            <Txt v="micro" numberOfLines={1} style={{ maxWidth: 70 }}>{name(seat)}</Txt>
            <Txt v="micro" color={palette.textTertiary} style={{ fontVariant: ['tabular-nums'] }}>{st.positions[seat]}</Txt>
          </View>
        ))}
      </View>

      {boardOpen && <View style={styles.snlBoard} accessibilityLabel={`Snakes and ladders board. ${st.players.map((x) => `${name(x)} on ${st.positions[x]}`).join(', ')}`}>
        {Array.from({ length: 10 }, (_, r) => (
          <View key={r} style={{ flexDirection: 'row' }}>
            {Array.from({ length: 10 }, (_, c) => {
              const n = squareAt(r, c);
              const jump = SNL_JUMPS[n];
              const here = st.players.filter((x) => st.positions[x] === n);
              return (
                <View key={c} style={[styles.sq, (r + c) % 2 === 1 && { backgroundColor: palette.surfaceRaised },
                  jump != null && { backgroundColor: jump > n ? palette.greenSoft : palette.redSoft }, n === 100 && { backgroundColor: palette.amberSoft }]}>
                  <Txt style={styles.sqNum} color={palette.textTertiary}>{n}</Txt>
                  {jump != null && <Txt style={styles.sqIcon}>{jump > n ? '🪜' : '🐍'}</Txt>}
                  {n === 100 && <Txt style={styles.sqIcon}>🏁</Txt>}
                  {here.map((x, i) => <View key={x} style={[styles.token, { backgroundColor: colorOf(x), left: 2 + (i % 2) * 11, top: 9 + Math.floor(i / 2) * 8 }]} />)}
                </View>
              );
            })}
          </View>
        ))}
      </View>}
      <Pressable onPress={() => { Haptics.selectionAsync(); setBoardOpen((o) => !o); }} hitSlop={6} style={({ pressed }) => [styles.boardToggle, pressed && { opacity: 0.6 }]}
        accessibilityRole="button" accessibilityState={{ expanded: boardOpen }}>
        <Ionicons name={boardOpen ? 'chevron-up' : 'grid-outline'} size={14} color={palette.textSecondary} />
        <Txt v="smallStrong" color={palette.textSecondary}>{boardOpen ? 'Hide board' : 'View board'}</Txt>
      </Pressable>
      {lastLine && <Txt v="meta" color={palette.textSecondary} style={{ marginTop: 8, textAlign: 'center' }}>{lastLine}</Txt>}

      {!st.started && !expired && !inGame && st.players.length < SNL_MAX_PLAYERS && (
        <Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onMove({ type: 'join' }); }}
          style={({ pressed }) => [styles.accept, { backgroundColor: accent, marginTop: 10 }, pressed && { opacity: 0.85 }]} accessibilityRole="button">
          <Txt v="bodyStrong" color={palette.onCyan}>Join the game</Txt>
        </Pressable>
      )}
      {!st.started && !expired && host && (
        <Pressable disabled={st.players.length < 2} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onMove({ type: 'start' }); }}
          style={({ pressed }) => [styles.accept, { backgroundColor: accent, marginTop: 10 }, st.players.length < 2 && { opacity: 0.45 }, pressed && { opacity: 0.85 }]} accessibilityRole="button">
          <Txt v="bodyStrong" color={palette.onCyan}>{st.players.length < 2 ? 'Waiting for players…' : `Start with ${st.players.length} players`}</Txt>
        </Pressable>
      )}
      {st.turn === mySeat && (
        <Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); onMove({ type: 'roll' }); }}
          style={({ pressed }) => [styles.accept, { backgroundColor: accent, marginTop: 10, flexDirection: 'row', gap: 8 }, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityLabel="Roll the dice">
          <Txt style={{ fontSize: 18, lineHeight: 22 }}>🎲</Txt>
          <Txt v="bodyStrong" color={palette.onCyan}>Roll the dice</Txt>
        </Pressable>
      )}
      <View style={styles.footer}><Txt v="smallStrong" color={statusColor} style={{ textAlign: 'center' }}>{status}</Txt></View>
    </View>
  );
}

// ================================================ Rock paper scissors ===
function Rps({ game, mySeat, accent, onMove }: Props & { game: RpsGame }) {
  const now = useServerNow(5000);
  const done = game.opponent != null && game.challengerPick != null && game.opponentPick != null;
  const expired = !game.opponent && now >= Date.parse(game.expiresAt);
  const mine = mySeat === game.challenger;
  const r = done ? rpsBeats(game.challengerPick!, game.opponentPick!) : 0;
  const winner = done && r !== 0 ? (r > 0 ? game.challenger : game.opponent!) : null;

  let status: string;
  let statusColor: string = palette.textSecondary;
  if (done) {
    status = !winner ? 'It’s a draw 🤝' : winner === mySeat ? 'You won! 🏆' : `${nameOf(winner)} won 🏆`;
    if (winner === mySeat) statusColor = palette.green;
  } else if (expired) status = 'Challenge expired';
  else status = mine ? 'Your pick is locked in · waiting for someone to answer' : 'Pick yours — first answer plays';

  return (
    <View style={styles.wrap}>
      <Header kind="RPS" right={!done && !expired ? <Countdown until={game.expiresAt} tone={palette.textTertiary} /> : null} />
      <View style={styles.players}>
        <View style={styles.rpsSide}>
          <Txt style={styles.rpsBig}>{done ? RPS_PICKS[game.challengerPick!] : '❔'}</Txt>
          <Txt v="smallStrong" numberOfLines={1}>{mine ? 'You' : nameOf(game.challenger)}</Txt>
          {done && <Txt v="micro" color={palette.textTertiary}>{RPS_NAMES[game.challengerPick!]}</Txt>}
        </View>
        <Txt v="micro" color={palette.textTertiary}>VS</Txt>
        <View style={styles.rpsSide}>
          <Txt style={styles.rpsBig}>{done ? RPS_PICKS[game.opponentPick!] : '❔'}</Txt>
          <Txt v="smallStrong" numberOfLines={1}>{game.opponent ? (game.opponent === mySeat ? 'You' : nameOf(game.opponent)) : '?'}</Txt>
          {done && <Txt v="micro" color={palette.textTertiary}>{RPS_NAMES[game.opponentPick!]}</Txt>}
        </View>
      </View>
      {!done && !expired && !mine && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {RPS_PICKS.map((e, i) => (
            <Pressable key={i} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onMove({ type: 'pick', pick: i }); }}
              style={({ pressed }) => [styles.rpsBtn, { borderColor: accent }, pressed && { backgroundColor: palette.cyanSoft }]}
              accessibilityRole="button" accessibilityLabel={RPS_NAMES[i]}>
              <Txt style={{ fontSize: 26, lineHeight: 32 }}>{e}</Txt>
              <Txt v="micro" color={palette.textSecondary}>{RPS_NAMES[i]}</Txt>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.footer}><Txt v="smallStrong" color={statusColor} style={{ textAlign: 'center' }}>{status}</Txt></View>
    </View>
  );
}

function Player({ seat, mark, me, active }: { seat: string; mark: string; me: boolean; active: boolean }) {
  return (
    <View style={[styles.player, active && { borderColor: palette.hairlineStrong, backgroundColor: palette.surfaceRaised }]}>
      <Txt style={{ fontFamily: font.displayBold, fontSize: 14 }} color={mark === '✕' ? palette.cyan : palette.rose}>{mark}</Txt>
      <Txt v="smallStrong" numberOfLines={1}>{me ? 'You' : nameOf(seat)}</Txt>
    </View>
  );
}

const styles = themed(() => ({
  wrap: { width: 280, maxWidth: '100%' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, height: 20, borderRadius: radius.pill, borderWidth: 1 },
  answer: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 42, paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.chip, borderWidth: 1, borderColor: palette.hairlineStrong, backgroundColor: palette.surfaceSunk,
  },
  footer: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: palette.hairline },
  emojis: { fontSize: 34, lineHeight: 46, textAlign: 'center', letterSpacing: 4, marginVertical: 6 },
  result: { marginTop: 10, padding: 12, gap: 2, alignItems: 'center', borderRadius: radius.chip, borderWidth: 1, backgroundColor: palette.surfaceSunk },
  players: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  player: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 32, borderRadius: radius.pill, borderWidth: 1, borderColor: 'transparent' },
  board: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignSelf: 'center', width: 3 * 64 + 2 * 6 },
  cell: { width: 64, height: 64, borderRadius: 12, borderWidth: 1, borderColor: palette.hairlineStrong, backgroundColor: palette.surfaceSunk, alignItems: 'center', justifyContent: 'center' },
  mark: { fontFamily: font.displayBold, fontSize: 30, lineHeight: 36 },
  boardToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 32, marginTop: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: palette.hairlineStrong },
  snlPlayers: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  snlPlayer: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, height: 24, borderRadius: radius.pill, borderWidth: 1, borderColor: palette.hairline },
  snlBoard: { alignSelf: 'center', borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: palette.hairlineStrong, backgroundColor: palette.surfaceSunk },
  sq: { width: SNL_CELL, height: SNL_CELL, padding: 1 },
  sqNum: { fontSize: 7, lineHeight: 8 },
  sqIcon: { position: 'absolute', right: 1, bottom: 0, fontSize: 9, lineHeight: 11 },
  token: { position: 'absolute', width: 9, height: 9, borderRadius: 5, borderWidth: 1, borderColor: '#FFFFFF' },
  rpsSide: { flex: 1, alignItems: 'center', gap: 2 },
  rpsBig: { fontSize: 38, lineHeight: 46 },
  rpsBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.chip, borderWidth: 1, backgroundColor: palette.surfaceSunk },
  accept: { height: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
}));

