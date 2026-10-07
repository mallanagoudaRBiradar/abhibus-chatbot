export const fmtTime = (iso?: string | null) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—';
export const fmtDateTime = (iso?: string | null) => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—';
export function ago(iso?: string | null) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) { const m = Math.round(-s / 60); return m < 60 ? `in ${m} min` : `in ${Math.round(m / 60)} h`; }
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
/** The room key people copy and search by (same rule as the server's toRef). */
export const roomRef = (id?: string | null) => (id && id.startsWith('room_') ? `TR-${id.slice(5, 11).toUpperCase()}` : id ?? '');
export const num = (n?: number | null) => (n ?? 0).toLocaleString('en-IN');
export const UNIT: Record<string, string> = { bus: 'Bus', train: 'Train', flight: 'Flight', custom: 'Trip' };
export const STATE_LABEL: Record<string, string> = { scheduled: 'Scheduled', dormant: 'Dormant (opens on delay)', open: 'Waiting to board', onboard: 'On the way', read_only: 'Read-only', closed: 'Closed', purged: 'Purged' };
export const STATE_TONE: Record<string, string> = { scheduled: 'c-mute', dormant: 'c-mute', open: 'c-info', onboard: 'c-ok', read_only: 'c-warn', closed: 'c-mute', purged: 'c-mute' };
export const SEV_COLOR: Record<string, string> = { critical: 'var(--rose)', warning: 'var(--amber)', info: 'var(--violet)' };
export const TENANT_DOT: Record<string, string> = { abhibus: '#d4373c', confirmtkt: '#1d6fd8', ixigo_trains: '#ea6a1b', ixigo_flights: '#2b5ce6' };

/** One vocabulary for urgency everywhere in the console (alerts, issues, updates). */
export const SEV_WORD: Record<string, string> = { critical: 'Urgent', warning: 'Important', info: 'FYI' };
export const SEV_TONE: Record<string, string> = { critical: 'c-crit', warning: 'c-warn', info: 'c-info' };
export const SEV_HELP: Record<string, string> = { critical: 'Safety or the trip is at risk. Pinned in red, push + SMS recommended.', warning: 'Changes someone’s plan (delay, new platform). Pinned, push recommended.', info: 'Good to know. Shown in the room, no push needed.' };
