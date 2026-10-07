/**
 * Trip updates in the words an operator uses, not API names. One entry per event type the server
 * accepts (EVENT_TYPES in server/src/core/tripEvents.ts); the room's mode decides which are offered.
 */
export type FieldKind = 'minutes' | 'restMinutes' | 'stop' | 'text' | 'reason';
export interface EventField { key: string; label: string; kind: FieldKind; required?: boolean; placeholder?: string; help?: string }
export interface EventDef { label: string; desc: string; icon: string; group: Group; fields: EventField[]; tone?: 'danger' }
export type Group = 'Timing' | 'Vehicle & route' | 'Stops & boarding' | 'Trip status';
export const GROUPS: Group[] = ['Timing', 'Stops & boarding', 'Vehicle & route', 'Trip status'];

const reason: EventField = { key: 'reason', label: 'Reason (shown to travellers)', kind: 'reason' };

export const EVENTS: Record<string, EventDef> = {
  delay: { label: 'Running late', desc: 'Push every ETA back and tell travellers the new time.', icon: '⏱', group: 'Timing', fields: [{ key: 'minutes', label: 'How late?', kind: 'minutes', required: true }, reason] },
  rescheduled: { label: 'Rescheduled', desc: 'The departure moved. ETAs shift by the same amount.', icon: '🗓', group: 'Timing', fields: [{ key: 'minutes', label: 'Moved by', kind: 'minutes', required: true }, reason] },

  stop_arrived: { label: 'Reached a stop', desc: 'Mark a stop as reached. Travellers see it in the chat.', icon: '📍', group: 'Stops & boarding', fields: [{ key: 'at_stop', label: 'Which stop?', kind: 'stop', required: true }] },
  rest_stop_started: { label: 'Rest stop', desc: 'Start a break. Travellers get a countdown so no one is left behind.', icon: '☕', group: 'Stops & boarding', fields: [{ key: 'at_stop', label: 'Where?', kind: 'stop' }, { key: 'minutes', label: 'How long?', kind: 'restMinutes', required: true }] },
  boarding_point_change: { label: 'Boarding point changed', desc: 'Travellers are told where to board instead.', icon: '↪', group: 'Stops & boarding', fields: [{ key: 'boarding', label: 'New boarding point', kind: 'text', required: true, placeholder: 'e.g. Ameerpet metro, pillar 1012' }] },
  platform_change: { label: 'Platform changed', desc: 'Tell travellers the new platform.', icon: '🚉', group: 'Stops & boarding', fields: [{ key: 'station', label: 'Station', kind: 'stop', required: true }, { key: 'platform', label: 'New platform', kind: 'text', required: true, placeholder: 'e.g. 5' }] },
  coach_position: { label: 'Coach position', desc: 'Where each coach will stop on the platform.', icon: '🚃', group: 'Stops & boarding', fields: [{ key: 'station', label: 'Station', kind: 'stop', required: true }, { key: 'coach', label: 'Coach position', kind: 'text', required: true, placeholder: 'e.g. B2 near the footbridge' }] },
  gate_change: { label: 'Gate changed', desc: 'Tell flyers the new gate (and terminal if it moved).', icon: '🛫', group: 'Stops & boarding', fields: [{ key: 'gate', label: 'New gate', kind: 'text', required: true, placeholder: 'e.g. 22B' }, { key: 'terminal', label: 'Terminal (if changed)', kind: 'text', placeholder: 'e.g. T2' }] },
  boarding_started: { label: 'Boarding started', desc: 'Flyers are asked to go to the gate now.', icon: '🚶', group: 'Stops & boarding', fields: [] },
  gate_closed: { label: 'Gate closed', desc: 'Boarding is over.', icon: '⛔', group: 'Stops & boarding', fields: [] },
  baggage_belt: { label: 'Baggage belt', desc: 'Which belt the bags arrive on.', icon: '🧳', group: 'Stops & boarding', fields: [{ key: 'belt', label: 'Belt number', kind: 'text', required: true, placeholder: 'e.g. 4' }] },

  breakdown: { label: 'Breakdown', desc: 'The vehicle has stopped. Ads pause and travellers are told help is coming.', icon: '⚠', group: 'Vehicle & route', fields: [{ key: 'reason', label: 'What happened?', kind: 'reason' }], tone: 'danger' },
  resolved: { label: 'Breakdown fixed', desc: 'The vehicle is moving again. Clears the breakdown banner.', icon: '✓', group: 'Vehicle & route', fields: [] },
  vehicle_swap: { label: 'Replacement vehicle', desc: 'A different bus is taking over. Clears any breakdown.', icon: '🔁', group: 'Vehicle & route', fields: [{ key: 'vehicle_no', label: 'New vehicle number', kind: 'text', required: true, placeholder: 'e.g. KA 01 AB 1234' }] },
  diverted: { label: 'Route diverted', desc: 'The trip is taking a different road or path.', icon: '🛣', group: 'Vehicle & route', fields: [{ key: 'reason', label: 'Why, and the new route', kind: 'reason', required: true }] },

  departed: { label: 'Departed', desc: 'The flight has left. The room moves to “On the way”.', icon: '✈', group: 'Trip status', fields: [] },
  landed: { label: 'Landed', desc: 'The flight is down. The room becomes read-only.', icon: '🛬', group: 'Trip status', fields: [] },
  charting_done: { label: 'Chart prepared', desc: 'Final seat chart is out; coach rooms are created.', icon: '📋', group: 'Trip status', fields: [] },
  cancelled: { label: 'Trip cancelled', desc: 'Travellers are told; the room becomes read-only. This can’t be undone here.', icon: '✕', group: 'Trip status', fields: [reason], tone: 'danger' },
};
export const EVENT_LABEL: Record<string, string> = Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, v.label]));

/** Reason presets so most updates need no typing. */
export const REASONS: Record<string, string[]> = {
  delay: ['Heavy traffic', 'Bad weather', 'Late incoming vehicle', 'Technical check', 'Road work'],
  rescheduled: ['Operational reasons', 'Bad weather', 'Late incoming train'],
  breakdown: ['Tyre puncture', 'Engine problem', 'AC not working', 'Minor accident, all safe'],
  diverted: ['Road closed ahead', 'Accident on the highway', 'Flooding'],
  cancelled: ['Operational reasons', 'Bad weather', 'Vehicle unavailable'],
};

/** A one-line summary of a stored trip update, for history lists. */
export function describeUpdate(type: string, d: any): string {
  const bits: string[] = [];
  if (d?.minutes !== undefined) bits.push(d.minutes < 0 ? `${-d.minutes} min recovered` : `${d.minutes} min`);
  for (const k of ['at_stop', 'station', 'platform', 'coach', 'gate', 'terminal', 'belt', 'vehicle_no', 'boarding']) if (d?.[k]) bits.push(`${k.replace('_', ' ')} ${d[k]}`);
  if (d?.reason) bits.push(`“${d.reason}”`);
  if (d?.auto_announce === false) bits.push('no alert');
  return bits.join(' · ') || (EVENTS[type]?.desc ?? '');
}
