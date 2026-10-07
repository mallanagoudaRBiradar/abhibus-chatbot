import type { Vertical } from './protocol';

/** Words that change by vertical, so one engine speaks bus, train and flight. */
export const UNIT: Record<Vertical, { unit: string; u: string; ops: string }> = {
  bus: { unit: 'Bus', u: 'bus', ops: 'Ops' },
  train: { unit: 'Train', u: 'train', ops: 'Ops' },
  flight: { unit: 'Flight', u: 'flight', ops: 'Ops' },
  custom: { unit: 'Trip', u: 'trip', ops: 'Ops' },
};

export const QUICK_ASKS: Record<Vertical, string[]> = {
  bus: ['Where is the bus?', 'Need a charger', 'Is the AC too cold?', 'How long is the stop?'],
  train: ['Where is the train?', 'Which platform?', 'Pantry open?', 'Charging point working?'],
  flight: ['New departure time?', 'Gate change?', 'Meal vouchers?', 'Baggage belt?'],
  custom: ['Where are we?', 'When do we arrive?'],
};

export const ISSUE_TYPES: Record<Vertical, string[]> = {
  bus: ['AC not working', 'Charging point not working', 'Cleanliness', 'Rash driving', 'Bus skipped my stop'],
  train: ['AC not working', 'Charging point not working', 'Cleanliness', 'No water in washroom', 'Unauthorised people in coach'],
  flight: ['No updates at the gate', 'Long queue at boarding', 'Need food or water during delay', 'Bag not on belt'],
  custom: ['Something is wrong'],
};

/**
 * Trip-event → alert text, in English and Hindi. `ctx` carries the facts the
 * engine already knows (next stop, new ETA, gate…). Used by POST /trip-events
 * (auto_announce) and by the Ops console's templates.
 */
export interface TemplateCtx { unit: string; minutes?: number; delay?: number; nextStop?: string; newTime?: string; place?: string; platform?: string; coach?: string; gate?: string; terminal?: string; belt?: string; stop?: string; flightNo?: string; reason?: string; boarding?: string }
type T = { id: string; label: string; vertical: Vertical[]; severity: 'info' | 'warning' | 'critical'; en: (c: TemplateCtx) => string; hi?: (c: TemplateCtx) => string };

const r = (c: TemplateCtx) => (c.reason ? ` Reason: ${c.reason}.` : '');
export const TEMPLATES: T[] = [
  { id: 'delay', label: 'Delay', vertical: ['bus', 'train'], severity: 'warning',
    en: (c) => `${c.unit} is running ${c.delay} min late.${c.nextStop ? ` New time at ${c.nextStop}: ${c.newTime}.` : ''}${r(c)}`,
    hi: (c) => `${c.unit === 'Bus' ? 'बस' : 'ट्रेन'} ${c.delay} मिनट देरी से चल रही है।${c.nextStop ? ` ${c.nextStop} पर नया समय: ${c.newTime}।` : ''}` },
  { id: 'delay', label: 'Delay', vertical: ['flight'], severity: 'critical',
    en: (c) => `${c.flightNo} is delayed by ${c.delay} min. New departure: ${c.newTime}.${r(c)}`,
    hi: (c) => `${c.flightNo} ${c.delay} मिनट देरी से है। नया प्रस्थान समय: ${c.newTime}।` },
  { id: 'breakdown', label: 'Breakdown', vertical: ['bus'], severity: 'critical',
    en: (c) => `Our bus has a breakdown ${c.place}. An alternate bus is on the way and should reach in about 60 min. Please stay near the bus.`,
    hi: () => 'हमारी बस खराब हो गई है। दूसरी बस आ रही है, लगभग 60 मिनट में पहुँचेगी। कृपया बस के पास ही रहें।' },
  { id: 'boarding_point_change', label: 'Boarding point change', vertical: ['bus'], severity: 'warning',
    en: (c) => `Boarding at ${c.boarding} has moved. ${c.reason ?? 'Please check the new pickup point.'}` },
  { id: 'rest_stop', label: 'Rest stop', vertical: ['bus'], severity: 'info',
    en: (c) => `We will stop at ${c.stop} for ${c.minutes ?? 20} minutes.`, hi: (c) => `हम ${c.stop} पर ${c.minutes ?? 20} मिनट रुकेंगे।` },
  { id: 'platform_change', label: 'Platform change', vertical: ['train'], severity: 'warning',
    en: (c) => `Train will arrive on platform ${c.platform} at ${c.nextStop}.`, hi: (c) => `ट्रेन ${c.nextStop} पर प्लेटफ़ॉर्म ${c.platform} पर आएगी।` },
  { id: 'coach_position', label: 'Coach position', vertical: ['train'], severity: 'info',
    en: (c) => `Coach ${c.coach} stops near the middle of the platform at ${c.nextStop}.` },
  { id: 'pantry', label: 'Pantry', vertical: ['train'], severity: 'info', en: () => 'Pantry dinner orders close at the next station.' },
  { id: 'gate_change', label: 'Gate change', vertical: ['flight'], severity: 'warning',
    en: (c) => `Gate changed to ${c.gate}, Terminal ${c.terminal ?? '1'}.`, hi: (c) => `गेट बदलकर ${c.gate}, टर्मिनल ${c.terminal ?? '1'} हो गया है।` },
  { id: 'boarding_started', label: 'Boarding started', vertical: ['flight'], severity: 'info',
    en: (c) => `Boarding has started at gate ${c.gate}. Zones 1 and 2 first.`, hi: (c) => `गेट ${c.gate} पर बोर्डिंग शुरू हो गई है।` },
  { id: 'gate_closed', label: 'Gate closed', vertical: ['flight'], severity: 'warning', en: (c) => `Gate ${c.gate} is now closed.` },
  { id: 'meal', label: 'Meal vouchers', vertical: ['flight'], severity: 'info',
    en: (c) => `Meal vouchers are available at the airline counter near gate ${c.gate}. Show your boarding pass.` },
  { id: 'baggage_belt', label: 'Baggage belt', vertical: ['flight'], severity: 'info', en: (c) => `Bags will arrive on belt ${c.belt}.`, hi: (c) => `सामान बेल्ट ${c.belt} पर आएगा।` },
  { id: 'cancelled', label: 'Cancelled', vertical: ['bus', 'train', 'flight'], severity: 'critical',
    en: (c) => `This ${c.unit.toLowerCase()} is cancelled.${r(c)} Your refund is being processed.` },
  { id: 'diverted', label: 'Diverted', vertical: ['bus', 'train', 'flight'], severity: 'warning', en: (c) => `This ${c.unit.toLowerCase()} is being diverted.${r(c)}` },
  { id: 'fixed', label: 'Issue fixed', vertical: ['bus', 'train', 'flight'], severity: 'info', en: () => 'The reported issue has been fixed. Thank you for flagging it.' },
];
export const templateFor = (id: string, v: Vertical) => TEMPLATES.find((t) => t.id === id && t.vertical.includes(v));
