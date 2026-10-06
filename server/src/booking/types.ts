import type { Gender } from '../shared/protocol';

export interface BookingSeat { seat: string; gender: Gender; phoneHash: string | null }

export interface BookingRecord {
  pnr: string;
  channel: 'OWN' | 'API';
  serviceId: string;
  journeyDate: string;        // YYYY-MM-DD
  isActive: boolean;          // confirmed & not cancelled
  seats: BookingSeat[];
  /** Present only if the ticket tables carry schedule columns. */
  schedule: { start: Date; end: Date } | null;
  meta: { operatorName?: string; busNumber?: string; sourceCity?: string; destinationCity?: string };
}

export interface BookingSource {
  findByPnr(pnr: string): Promise<BookingRecord | null>;
}

export const journeyIdFor = (serviceId: string, journeyDate: string) => `${serviceId}:${journeyDate}`;
