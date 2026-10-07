/**
 * Console alerts: a short chime (more insistent for urgent) and a desktop notification when the tab
 * is in the background. One preference per person and browser, shared by the bell and the support desk.
 */
const KEY = 'tr.console.care_alerts';

export const alertsOn = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };

/** Turn alerts on/off. Turning on asks for notification permission; returns the resulting state. */
export async function setAlerts(on: boolean) {
  if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission().catch(() => 'denied');
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
  if (on) chime('info');
  return on;
}

let ctx: AudioContext | null = null;
export function chime(severity: 'critical' | 'warning' | 'info') {
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime;
    const notes = severity === 'critical' ? [988, 740, 988, 740] : severity === 'warning' ? [880, 1320] : [1175];
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator(), g = ctx!.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const at = t + i * 0.15;
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(severity === 'critical' ? 0.16 : 0.11, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
      o.connect(g).connect(ctx!.destination); o.start(at); o.stop(at + 0.36);
    });
  } catch { /* audio is blocked until the user has interacted with the page */ }
}

/** Ring + (if the tab is hidden) a desktop notification that opens `link` when clicked. */
export function ring(n: { id: string; severity: 'critical' | 'warning' | 'info'; title: string; body: string; link: string }) {
  if (!alertsOn()) return;
  if (n.severity !== 'info') chime(n.severity);
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  const d = new Notification(n.title, { body: n.body.slice(0, 160), tag: n.id, requireInteraction: n.severity === 'critical' });
  d.onclick = () => { window.focus(); window.location.hash = n.link; d.close(); };
}

// Support desk names (kept so existing screens keep working).
export const careAlertsOn = alertsOn;
export const setCareAlerts = setAlerts;
export const alertNewTicket = (e: { text?: string; follow_up?: boolean; action_id?: string }) =>
  ring({ id: e.action_id ?? String(Date.now()), severity: 'warning', title: e.follow_up ? 'Traveller wrote again' : 'New support ticket', body: e.text ?? '', link: e.action_id ? `/support/queue/${e.action_id}` : '/support/queue' });
