import type { Gender } from '../shared/protocol';

/**
 * Demo trip: an overnight Hyderabad -> Bengaluru sleeper on NH 44.
 * Timeline is anchored to server boot so the bus is always "live" and sitting
 * near Kurnool when the demo starts.
 */
const BOOT = Date.now();
const TRIP_MS = 9 * 3600_000;
const START = new Date(BOOT - 3 * 3600_000);
const END = new Date(START.getTime() + TRIP_MS);

type Seat = { seat: string; gender: Gender };

export const DEMO = {
  serviceId: 'DEMO-HYD-BLR-2245',
  operatorName: 'Sapphire Travels',
  busNumber: 'TS 09 UB 4521',
  routeName: 'Hyderabad to Bengaluru',
  journeyDate: () => START.toISOString().slice(0, 10),
  schedule: () => ({ start: START, end: END }),

  /** Tickets a human can log in with (shown as one-tap chips on the join screen in DEMO_MODE). */
  tickets: [
    { pnr: 'AB7X2K9Q', label: 'Solo woman traveller', seats: [{ seat: '12L', gender: 'F' }] as Seat[] },
    { pnr: 'AB4M8R2T', label: 'Solo male traveller', seats: [{ seat: '7U', gender: 'M' }] as Seat[] },
    { pnr: 'ABFAM026', label: 'Family booking, 2 seats', seats: [{ seat: '3L', gender: 'F' }, { seat: '4L', gender: 'M' }] as Seat[] },
  ],

  /**
   * Extra demo tickets created at runtime: when a ticket's seat is already held by another
   * browser, the next browser gets its own seat (same ticket type, e.g. still a woman's seat),
   * so several people can try the demo at once as different passengers.
   */
  extraTickets: new Map<string, { pnr: string; label: string; seats: Seat[] }>(),

  /** Simulated co-passengers that make the demo feel alive. */
  crowd: [
    { seat: '4W', gender: 'M', name: 'Arjun', avatar: 'animal-1' },
    { seat: '18L', gender: 'M', name: 'Vikram', avatar: 'fun-6' },
    { seat: '9U', gender: 'M', name: 'Rohit', avatar: 'fun-0' },
    { seat: '2L', gender: 'F', name: 'Priya', avatar: 'animal-8' },
    { seat: '15U', gender: 'F', name: 'Ananya', avatar: 'fun-3' },
    { seat: '6L', gender: 'F', name: 'Lakshmi', avatar: 'people-6' },
    { seat: '21W', gender: 'F', name: 'Sneha', avatar: null },
    { seat: '11U', gender: 'M', name: 'Imran', avatar: 'animal-2' },
    { seat: '14L', gender: 'M', name: 'Suresh', avatar: 'people-7' },
    { seat: '8W', gender: 'M', name: 'Kiran', avatar: null },
    { seat: '17U', gender: 'O', name: 'Sam', avatar: 'fun-1' },
  ] as (Seat & { name: string; avatar: string | null })[],
};
