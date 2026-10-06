import { abrsQuery } from '../db/abrsPool';
import { config } from '../config';
import { hashPhone, normaliseGender, normaliseSeat } from '../lib/util';
import { ABRS_MAP, assertSafeIdentifiers, q } from './schemaMap';
import type { BookingRecord, BookingSource } from './types';

/**
 * Reads a booking from abrs_new. Tries own-inventory tables first, then the
 * API/aggregator tables. Two small indexed lookups, no joins across sets.
 */
export class MysqlBookingSource implements BookingSource {
  constructor() { assertSafeIdentifiers(); }

  async findByPnr(pnr: string): Promise<BookingRecord | null> {
    for (const channel of ['OWN', 'API'] as const) {
      const rec = await this.lookup(channel, pnr);
      if (rec) return rec;
    }
    return null;
  }

  private async lookup(channel: 'OWN' | 'API', pnr: string): Promise<BookingRecord | null> {
    const { master: M, detail: D, tables } = { master: ABRS_MAP.master, detail: ABRS_MAP.detail, tables: ABRS_MAP.tables[channel] };

    const optional = (['sourceCity', 'destinationCity', 'departureTime', 'arrivalTime', 'operatorName', 'busNumber', 'mobile'] as const)
      .filter((k) => M[k])
      .map((k) => `m.${q(M[k]!)} AS ${k}`);

    const where = ABRS_MAP.matchSupplierPnr
      ? `(m.${q(M.ticketNo)} = ? OR m.${q(M.supplierPnr)} = ?)`
      : `m.${q(M.ticketNo)} = ?`;
    const params = ABRS_MAP.matchSupplierPnr ? [pnr, pnr] : [pnr];

    const masters = await abrsQuery<any>(
      `SELECT m.${q(M.ticketNo)} AS ticketNo, m.${q(M.serviceId)} AS serviceId,
              m.${q(M.journeyDate)} AS journeyDate, m.${q(M.status)} AS status
              ${optional.length ? ',' + optional.join(',') : ''}
         FROM ${q(tables.master)} m WHERE ${where} LIMIT 1`,
      params,
    );
    const m = masters[0];
    if (!m) return null;

    const detailCols = [`d.${q(D.seat)} AS seat`, `d.${q(D.gender)} AS gender`];
    if (D.status) detailCols.push(`d.${q(D.status)} AS seatStatus`);
    const details = await abrsQuery<any>(
      `SELECT ${detailCols.join(',')} FROM ${q(tables.detail)} d WHERE d.${q(D.joinKey)} = ?`,
      [m.ticketNo],
    );

    const statusOk = (s: unknown) => config.confirmedStatuses.includes(String(s ?? '').trim().toLowerCase());
    const journeyDate = String(m.journeyDate).slice(0, 10);

    return {
      pnr: String(m.ticketNo),
      channel,
      serviceId: String(m.serviceId),
      journeyDate,
      isActive: statusOk(m.status),
      seats: details
        .filter((d) => !D.status || statusOk(d.seatStatus))
        .map((d) => ({ seat: normaliseSeat(d.seat), gender: normaliseGender(d.gender), phoneHash: hashPhone(m.mobile) })),
      schedule: buildSchedule(journeyDate, m.departureTime, m.arrivalTime),
      meta: {
        operatorName: m.operatorName ?? undefined,
        busNumber: m.busNumber ?? undefined,
        sourceCity: m.sourceCity ?? undefined,
        destinationCity: m.destinationCity ?? undefined,
      },
    };
  }
}

/** Accepts "HH:MM[:SS]" or full datetimes (IST). Overnight arrivals roll to next day. */
function buildSchedule(date: string, dep?: string | null, arr?: string | null) {
  if (!dep || !arr) return null;
  const toDate = (v: string) => (v.length <= 8 ? new Date(`${date}T${v.padEnd(8, ':00').slice(0, 8)}+05:30`) : new Date(v.replace(' ', 'T') + '+05:30'));
  const start = toDate(String(dep));
  let end = toDate(String(arr));
  if (end <= start) end = new Date(end.getTime() + 24 * 3600_000);
  return isNaN(+start) || isNaN(+end) ? null : { start, end };
}
