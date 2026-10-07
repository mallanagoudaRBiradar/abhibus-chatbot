import type { BookingInput, PointInput } from '../features/ingest';

/**
 * ============================================================================
 *  AbhiBus adapter — raw AbhiBus responses → our booking model.
 * ============================================================================
 *  The AbhiBus backend forwards the responses it already has, unchanged:
 *    GetTicket            → POST /v1/partner/abhibus/ticket        (booked / modified / any status refresh)
 *    ConfirmCancellation  → POST /v1/partner/abhibus/cancellation  (+ the request's cancel_seats)
 *  so the field mapping lives here, in one place we can fix without a backend
 *  release. Only what the chat and Ops need is kept (see features/ingest.ts);
 *  fares, payment, email and card details are ignored.
 *
 *  Field map (GetTicket ticketList[0]):
 *    journey key   `${api}_${travelerPartnerId}_${ServiceKey}` + JourneyDate
 *                  (the same id track.abhibus.com uses: ?service=base64("2291_7_150")_20261008)
 *    start / end   this passenger's boardingDateTime / droppingDateTime (IST). Per bus run the
 *                  journey takes the EARLIEST boarding and LATEST drop across passengers, so the
 *                  room opens before the first person gets on (features/ingest.ts).
 *    seats         SelectedSeats, with name + gender from passengerdetails[] or Passenger1..N "(name,gender)"
 *    boarding      bpId · Boarding_At · Landmark · boardingLatLong · boardingDateTime
 *    dropping      DP id · droppingPlace · droppingLatLong · droppingDateTime
 *    contact       CustPhoneNumber (encrypted) · additional_info.accountId → customerId
 *    operator      Operator_Name · busPartnerDetails "helpline" → SOS sheet
 * ============================================================================
 */
type Obj = Record<string, any>;

export class AdapterError extends Error {}

const str = (v: unknown) => (v == null ? '' : String(v).trim());
const json = (v: unknown): Obj => { if (v && typeof v === 'object') return v as Obj; try { return JSON.parse(String(v ?? '')) ?? {}; } catch { return {}; } };

/** "2026-10-08 20:50" or "2026-10-08 20:50:00" (IST) → Date. */
export function istDateTime(v: unknown): Date | null {
  const m = str(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, '0')}:${m[5]}:${m[6] ?? '00'}+05:30`);
  return isNaN(+d) ? null : d;
}
const MONTHS: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
/** "08-10-2026" / "08-Oct-2026" / "2026-10-08" → "2026-10-08". */
export function isoDate(v: unknown): string | null {
  const s = str(v);
  let m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m && MONTHS[m[2].toUpperCase()]) return `${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
/** "17.446, 78.376" → { lat, lng } */
export function latLng(v: unknown): { lat: number; lng: number } | null {
  const [a, b] = str(v).split(',').map((x) => parseFloat(x));
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 ? { lat: a, lng: b } : null;
}
const splitSeats = (v: unknown) => str(v).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

/**
 * Name + gender per seat. Real tickets carry them in different places:
 *  1. passengerdetails[]  (seat-keyed when present; empty in the samples we've seen)
 *  2. Passenger1..N "(name,gender)" (only trusted when there is one per current seat:
 *     a 3-seat ticket can carry just Passenger1)
 *  3. additional_info.haltEvents.charged bus_name<i> / bus_gender<i>: numbered in the
 *     ORIGINAL booking order, and NOT updated by a partial cancellation. They are matched
 *     to seats through the original seat list (asf.onw.allPolicies[0].seatNos, e.g.
 *     "4U,8U,16"), never by position in today's SelectedSeats: after 8U is cancelled,
 *     seat 16 is still passenger 3, not passenger 2.
 * Unknown gender stays 'O', which keeps the seat out of the women-only room.
 */
function passengers(t: Obj, seats: string[], ai: Obj): { seat: string; name: string | null; gender: string }[] {
  const U = (x: string) => x.toUpperCase();
  const list: Obj[] = Array.isArray(t.passengerdetails) ? t.passengerdetails : [];
  const pick = (o: Obj, keys: string[]) => keys.map((k) => o[k]).find((x) => x != null && str(x) !== '');
  const bySeat = new Map(list.map((p) => [U(str(pick(p, ['seat', 'Seat', 'seatNo', 'SeatNo', 'seat_no', 'Seat_Num', 'seatNumber']))), p]));

  const paxFields = Object.keys(t).filter((k) => /^Passenger\d+$/.test(k));
  const paxTrusted = paxFields.length === seats.length;

  const halt = json(ai.haltEvents)?.charged ?? {};
  const original = splitSeats(json(ai.asf)?.onw?.allPolicies?.[0]?.seatNos ?? '').map(U);
  const haltCount = Object.keys(halt).filter((k) => /^bus_gender\d+$/.test(k)).length;
  const haltIndex = (seat: string, i: number) => {
    if (original.length) { const k = original.indexOf(U(seat)); return k >= 0 ? k + 1 : null; }
    return haltCount === seats.length ? i + 1 : null; // no partial cancellation possible to detect: same count = same order
  };

  return seats.map((seat, i) => {
    const p = bySeat.get(U(seat));
    if (p) return { seat, name: str(pick(p, ['name', 'Name', 'passengerName', 'Passenger_Name', 'fullName'])) || null, gender: str(pick(p, ['gender', 'Gender', 'sex', 'GenderType', 'GENDER_TYPE'])) || 'O' };
    const m = paxTrusted ? str(t[`Passenger${i + 1}`]).match(/^\(?\s*([^,()]*?)\s*,\s*([^,()]*?)\s*\)?$/) : null;
    const h = haltIndex(seat, i);
    const name = m?.[1] || (h ? str(halt[`bus_name${h}`]) : '') || null;
    const gender = m?.[2] || (h ? str(halt[`bus_gender${h}`]) : '') || 'O';
    return { seat, name, gender };
  });
}

function point(id: unknown, name: unknown, landmark: unknown, ll: unknown, at: unknown): PointInput | null {
  const n = str(name);
  if (!n) return null;
  const c = latLng(ll);
  return { id: str(id) || null, name: n.slice(0, 120), landmark: str(landmark) || null, lat: c?.lat ?? null, lng: c?.lng ?? null, at: istDateTime(at) };
}

/** Journey key: the bus run id track.abhibus.com uses (api_partner_serviceKey), else ServiceKey alone. */
export function serviceKeyOf(t: Obj): string {
  const sk = str(t.ServiceKey || t.serviceId || t.Service_Id);
  if (!sk) throw new AdapterError('ServiceKey is missing.');
  const api = str(t.api || t.api_Key), partner = str(t.travelerPartnerId || t.Traveler_Partner_Id);
  const key = api && partner ? `${api}_${partner}_${sk}` : sk;
  return key.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
}

/** GetTicket response (whole body or one ticketList item) → BookingInput. */
export function bookingFromGetTicket(body: Obj): BookingInput {
  const t: Obj = Array.isArray(body?.ticketList) ? body.ticketList[0] : body;
  if (!t || typeof t !== 'object') throw new AdapterError('No ticket in the body (expected ticketList[0]).');
  const pnr = str(t.PNR || t.ticket_num);
  if (!pnr) throw new AdapterError('PNR is missing.');
  const ai = json(t.additional_info);
  const journeyDate = isoDate(t.JourneyDate || t.Journey_Date);
  if (!journeyDate) throw new AdapterError('JourneyDate is missing or not DD-MM-YYYY.');

  // When this passenger gets on; the journey keeps the earliest across all its passengers.
  const start = istDateTime(t.boardingDateTime || ai.bdt) ?? istDateTime(ai.origin_date_time || t.add_origin_date_time);
  let end = istDateTime(t.droppingDateTime || ai.ddt);
  if (!start) throw new AdapterError('Boarding time is missing (boardingDateTime / additional_info.bdt).');
  if (!end || +end <= +start) end = new Date(+start + 12 * 3600_000); // safe fallback; resend the journey when known

  const seats = splitSeats(t.SelectedSeats || t.Adult_Seats);
  const dp = str(t.DP || ai.DP || t.add_drop_info).split('^'); // "34^HSR Layout^11:00"
  const track = str(t.trackBusURL).match(/[?&]service=([^&]+)/)?.[1] ?? null;
  const helpline = (Array.isArray(t.busPartnerDetails) ? t.busPartnerDetails : [])
    .find((d: Obj) => /helpline|contact|phone/i.test(str(d?.title)) && /\d{6,}/.test(str(d?.value)));

  return {
    pnr,
    // Full cancellation = "Cancelled". Anything else is live; seats no longer in SelectedSeats are dropped.
    status: /^cancel/i.test(str(t.Status)) ? 'CANCELLED' : 'CONFIRMED',
    channel: 'OWN',
    customerId: str(ai.accountId) || null,
    mobile: str(t.CustPhoneNumber || t.Mobile) || null,
    journey: {
      serviceId: serviceKeyOf(t), journeyDate,
      busNumber: str(t.Service_Number || t.Service_number).slice(0, 20) || null,
      operatorName: str(t.Operator_Name || t.operator_name).slice(0, 80) || null,
      sourceCity: str(t.From || t.Source).slice(0, 60) || 'Origin',
      destinationCity: str(t.To || t.Destination).slice(0, 60) || 'Destination',
      startTime: start, estimatedEndTime: end,
      trackingRef: track,
      operatorHelpline: helpline ? str(helpline.value).replace(/[^\d+]/g, '').slice(0, 20) : null,
    },
    seats: passengers(t, seats, ai).map((p) => ({ seat: p.seat, gender: p.gender, name: p.name })),
    boarding: point(ai.bpId, t.Boarding_At || t.Boarding_Place_Name, t.Landmark || t.LandMark, t.boardingLatLong || ai.bpLatLong, t.boardingDateTime || ai.bdt),
    dropping: point(dp[0], t.droppingPlace || dp[1], null, t.droppingLatLong || ai.dpLatLong, t.droppingDateTime || ai.ddt),
  };
}

/**
 * BOOKING row from bus-online ticket::makeTicketHistory, written once per confirmed
 * ticket (onward and return each come separately):
 *   { ticket_no, journey_type, account_id,
 *     othInfo:          what was saved to abrs_ticket_history.record_info,
 *     additional_info:  the ticket's additional_info (same blob GetTicket carries) }
 * othInfo.passengerdetails are the per-seat rows from the ticket tables
 * (Passenger_Name, Seat_Num, GENDER_TYPE "Male"/"Female", Age): the most reliable
 * source of names and genders, so they win over haltEvents.
 */
export function bookingFromHistory(body: Obj): BookingInput {
  const o = json(body?.othInfo);
  const ai = json(body?.additional_info);
  const pnr = str(body?.ticket_no || o.ticketNo);
  if (!pnr) throw new AdapterError('ticket_no is missing.');
  // journeyDate is always "04-Dec-2024"; journey_date varies ("Wed, 4th Dec 2024", "05-12-2024"), so it's only a fallback.
  const journeyDate = isoDate(o.journeyDate) ?? isoDate(o.journey_date);
  if (!journeyDate) throw new AdapterError('othInfo.journeyDate / journey_date is missing or unreadable.');

  const start = istDateTime(o.bdt || ai.bdt) ?? istDateTime(o.odtm || ai.origin_date_time);
  if (!start) throw new AdapterError('Boarding time is missing (othInfo.bdt / additional_info.bdt).');
  let end = istDateTime(o.ddt || ai.ddt);
  if (!end || +end <= +start) end = new Date(+start + 12 * 3600_000);

  const rows: Obj[] = Array.isArray(o.passengerdetails) ? o.passengerdetails : [];
  // A passenger row can say "Status": "Cancelled"; that seat is not added.
  const cancelled = new Set(rows.filter((r) => /cancel/i.test(str(r?.Status))).map((r) => str(r?.Seat_Num).toUpperCase()));
  const seats = splitSeats(o.selectedSeats).filter((x) => !cancelled.has(x.toUpperCase()));
  const dp = str(ai.DP).split('^'); // "124^Hayathnagar^23:50"
  const ref = { ServiceKey: o.Service_Id, api: o.api_key, travelerPartnerId: o.travelerPartnerId };

  return {
    pnr,
    // Written when the booking is confirmed; later cancellations come as CANCELLATION rows.
    status: seats.length ? 'CONFIRMED' : 'CANCELLED',
    channel: 'OWN',
    customerId: str(body?.account_id || ai.accountId) || null,
    mobile: str(o.phone_number || o.mobile) || null,
    journey: {
      serviceId: serviceKeyOf(ref), journeyDate,
      busNumber: str(o.Service_Number).slice(0, 20) || null,
      operatorName: str(o.operatorName).slice(0, 80) || null,
      sourceCity: str(o.source || o.abhiSourceName).slice(0, 60) || 'Origin',
      destinationCity: str(o.destination || o.abhiDestinationName).slice(0, 60) || 'Destination',
      startTime: start, estimatedEndTime: end,
      trackingRef: null,
      operatorHelpline: null, // not in the booking history (looked up separately by bus-online)
    },
    seats: passengers({ passengerdetails: rows }, seats, ai).map((p) => ({ seat: p.seat, gender: p.gender, name: p.name })),
    boarding: point(ai.bpId, o.boardingPlace, o.Landmark, o.bpLatLong || ai.bpLatLong, o.bdt || ai.bdt),
    dropping: point(dp[0], dp[1] || o.droppingPlace, null, o.dpLatLong || ai.dpLatLong, o.ddt || ai.ddt),
  };
}

/**
 * ConfirmCancellation response (+ the request's cancel_seats) → which seats to remove.
 * Applied when the cancellation went through, or the ticket was already cancelled.
 */
export function cancellationFrom(body: Obj): { pnr: string; seats: string[]; apply: boolean; reason: string } {
  const pnr = str(body.ticket_num || body.PNR);
  if (!pnr) throw new AdapterError('ticket_num is missing.');
  const done = /^success$/i.test(str(body.status)) || /^y$/i.test(str(body.cancelstatus)) || /^yes$/i.test(str(body.is_already_cancelled));
  // Prefer the seats you asked to cancel; the response's Adult_Seats can list the whole ticket.
  const seats = splitSeats(body.cancel_seats || body.Adult_Seats);
  return { pnr, seats, apply: done, reason: str(body.message) || (done ? 'cancelled' : 'cancellation not confirmed') };
}
