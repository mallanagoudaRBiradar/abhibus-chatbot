import type { BookingRecord, BookingSource } from './types';
import { DEMO } from '../demo/demoData';

/** Demo tickets so leadership can try the full flow without touching abrs_new. */
export class MockBookingSource implements BookingSource {
  async findByPnr(pnr: string): Promise<BookingRecord | null> {
    const t = DEMO.tickets.find((x) => x.pnr === pnr) ?? DEMO.extraTickets.get(pnr);
    if (!t) return null;
    return {
      pnr: t.pnr,
      channel: 'OWN',
      serviceId: DEMO.serviceId,
      journeyDate: DEMO.journeyDate(),
      isActive: true,
      seats: t.seats.map((s) => ({ seat: s.seat, gender: s.gender, phoneHash: null })),
      schedule: DEMO.schedule(),
      meta: { operatorName: DEMO.operatorName, busNumber: DEMO.busNumber, sourceCity: 'Hyderabad', destinationCity: 'Bengaluru' },
    };
  }
}
