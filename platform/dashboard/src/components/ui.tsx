import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useTheme, type ThemePref } from '../lib/theme';

// ------------------------------------------------------------------ toast ---
const ToastCtx = createContext<(msg: string, tone?: 'ok' | 'err') => void>(() => {});
export function ToastHost({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; tone: 'ok' | 'err'; id: number } | null>(null);
  const show = useCallback((msg: string, tone: 'ok' | 'err' = 'ok') => setT({ msg, tone, id: Date.now() }), []);
  useEffect(() => { if (!t) return; const h = setTimeout(() => setT(null), t.tone === 'err' ? 5000 : 2600); return () => clearTimeout(h); }, [t]);
  return <ToastCtx.Provider value={show}>{children}{t && <div id="toast" role="status" className={t.tone === 'err' ? 'err' : ''}>{t.msg}</div>}</ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

/** Run an async action with a busy flag + toast on success/failure. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, ok?: string | ((r: T) => string)) => {
    setBusy(key);
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); return r; }
    catch (e: any) { toast(e?.message ?? 'Something went wrong.', 'err'); return undefined; }
    finally { setBusy(null); }
  }, [toast]);
  return { busy, run };
}

// -------------------------------------------------------------- elements ---
export const Chip = ({ tone = 'c-mute', children, title }: { tone?: string; children: ReactNode; title?: string }) => <span className={`chip ${tone.startsWith('c-') ? tone : `c-${tone}`}`} title={title}>{children}</span>;

export function Btn({ kind, sm, busy, children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'pri' | 'danger' | 'ghost'; sm?: boolean; busy?: boolean }) {
  return <button type="button" {...p} disabled={p.disabled || busy} className={`btn ${kind ?? ''} ${sm ? 'sm' : ''} ${p.className ?? ''}`}>{busy ? <span className="spin" aria-hidden /> : null}{children}</button>;
}
export const Panel = ({ title, children, right, className }: { title?: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) => (
  <div className={`panel ${className ?? ''}`}>{title || right ? <div className="ph">{title ? <h3>{title}</h3> : <span />}{right}</div> : null}{children}</div>
);
export const Head = ({ title, sub, right, back }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; back?: { label: string; href: string } }) => (
  <div className="ch"><div>{back && <a className="btn sm ghost" href={back.href}>‹ {back.label}</a>}<h2 style={back ? { marginTop: 8 } : undefined}>{title}</h2>{sub && <p>{sub}</p>}</div>{right && <div className="fil">{right}</div>}</div>
);
/** Stat card. With `to` (a hash href) the whole card is a link to the page behind the number. */
export const Kpi = ({ label, value, sub, tone, to }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; to?: string }) => {
  const inner = <><small>{label}</small><b style={tone ? { color: tone } : undefined}>{value}</b>{sub && <span>{sub}</span>}</>;
  return to ? <a className="kpi" href={to} title={`Open ${label.toLowerCase()}`}>{inner}</a> : <div className="kpi">{inner}</div>;
};
const THEMES: [ThemePref, string, string][] = [['light', '☀', 'Light'], ['dark', '☾', 'Dark'], ['system', '◐', 'Auto']];
export function ThemeSwitch({ labels }: { labels?: boolean }) {
  const { pref, setPref } = useTheme();
  return (
    <div className="thm" role="group" aria-label="Colour theme">
      {THEMES.map(([v, icon, l]) => <button key={v} type="button" aria-pressed={pref === v} onClick={() => setPref(v)} title={`${l} theme`} aria-label={`${l} theme`}><span aria-hidden>{icon}</span>{labels && l}</button>)}
    </div>
  );
}
export const Switch = ({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) => (
  <button type="button" className="sw" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />
);
export const Field = ({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) => (
  <div className="f"><label>{label}</label>{children}{hint && <small className="hint">{hint}</small>}</div>
);
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const Loading = () => <div className="empty"><span className="spin" /> Loading…</div>;
export const ErrorBox = ({ msg, retry }: { msg: string; retry?: () => void }) => <div className="errbox">{msg}{retry && <> <Btn sm onClick={retry}>Retry</Btn></>}</div>;

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void }) {
  return <div className="vt">{options.map(([v, l]) => <button type="button" key={v} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>)}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f); }, [onClose]);
  return (
    <div className="modal-ov" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="ph"><h3 style={{ margin: 0 }}>{title}</h3><button type="button" className="btn sm ghost" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

/** Shown once after creating a key / webhook / user. Copy-to-clipboard, then it's gone. */
export function SecretOnce({ label, value, note }: { label: string; value: string; note?: string }) {
  const toast = useToast();
  return (
    <div className="secret">
      <small>{label}</small>
      <div className="fil" style={{ alignItems: 'center' }}><code>{value}</code><Btn sm onClick={() => { void navigator.clipboard?.writeText(value); toast('Copied'); }}>Copy</Btn></div>
      {note && <p className="hint">{note}</p>}
    </div>
  );
}

// ------------------------------------------------------------- code view ---
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function highlight(v: unknown) {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  if (typeof v === 'string' && !s.trim().startsWith('{') && !s.trim().startsWith('[')) return esc(s);
  return esc(s).replace(/("(?:\\.|[^"\\])*")(\s*:)?/g, (_m, str, colon) => colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`);
}
export const Code = ({ value, max }: { value: unknown; max?: number }) => <pre className="code" style={max ? { maxHeight: max } : undefined} dangerouslySetInnerHTML={{ __html: highlight(value) }} />;
export function CopyCode({ text, lang }: { text: string; lang?: string }) {
  const toast = useToast();
  return <div className="copycode"><Btn sm className="cc-btn" onClick={() => { void navigator.clipboard?.writeText(text); toast('Copied'); }}>Copy</Btn><pre className="code">{lang ? <span className="cm">{`// ${lang}\n`}</span> : null}{text}</pre></div>;
}

// ------------------------------------------------------ product patterns ---
/** A reference code people can say on a call or paste in chat (TR-8YO3GW). Click copies it. */
export function Ref({ code, title }: { code?: string | null; title?: string }) {
  const toast = useToast();
  if (!code) return null;
  return (
    <button type="button" className="ref" title={title ?? 'Copy reference'} onClick={(e) => { e.stopPropagation(); e.preventDefault(); void navigator.clipboard?.writeText(code); toast(`Copied ${code}`); }}>
      {code}<span aria-hidden>⧉</span>
    </button>
  );
}

/** Numbered step header for guided flows. Steps before `at` are clickable to go back. */
export function Steps({ steps, at, onGo }: { steps: string[]; at: number; onGo?: (i: number) => void }) {
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={s} className={i === at ? 'now' : i < at ? 'done' : ''}>
          <button type="button" disabled={i >= at || !onGo} onClick={() => onGo?.(i)}><b>{i < at ? '✓' : i + 1}</b>{s}</button>
        </li>
      ))}
    </ol>
  );
}

/** Link tabs (deep-linkable, survive refresh). */
export function Tabs({ tabs, at }: { tabs: { id: string; label: ReactNode; href: string; hidden?: boolean }[]; at: string }) {
  return <nav className="tabs2" aria-label="Sections">{tabs.filter((t) => !t.hidden).map((t) => <a key={t.id} href={t.href} aria-current={t.id === at ? 'page' : undefined}>{t.label}</a>)}</nav>;
}

/** A big selectable card used in "what are you doing?" steps. */
export function Choice({ on, title, desc, icon, tone, onClick }: { on?: boolean; title: ReactNode; desc?: ReactNode; icon?: ReactNode; tone?: 'danger'; onClick: () => void }) {
  return (
    <button type="button" className={`choice ${on ? 'on' : ''} ${tone ?? ''}`} aria-pressed={!!on} onClick={onClick}>
      {icon && <span className="ci" aria-hidden>{icon}</span>}
      <span><b>{title}</b>{desc && <small>{desc}</small>}</span>
    </button>
  );
}
