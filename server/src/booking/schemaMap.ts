/**
 * ============================================================================
 *  abrs_new column mapping — THE ONLY PLACE that knows legacy column names.
 * ============================================================================
 *  Confirmed from the platform notes:
 *    abrs_reserved_tickets / abrs_api_reserved_tickets      (ticket master)
 *      Ticket_no, supplierpnr, Service_Id, Journey_date, Status, Track_Id
 *    abrs_reserved_tickets_det / abrs_api_reserved_tickets_det (per seat)
 *      Seat_Num, Passenger_Name, Gender, Age
 *
 *  ⚠ VERIFY items are educated guesses. Run `npm run db:introspect-abrs`
 *  — it prints the real columns of all four tables and validates this map.
 *  Optional columns set to null are simply not selected.
 *
 *  PRIVACY: Passenger_Name and Age are deliberately NOT mapped. The chat
 *  service never reads them, so it can never leak them.
 * ============================================================================
 */
export const ABRS_MAP = {
  tables: {
    OWN: { master: 'abrs_reserved_tickets', detail: 'abrs_reserved_tickets_det' },
    API: { master: 'abrs_api_reserved_tickets', detail: 'abrs_api_reserved_tickets_det' },
  },
  master: {
    ticketNo: 'Ticket_no',
    supplierPnr: 'supplierpnr',
    serviceId: 'Service_Id',
    journeyDate: 'Journey_date',
    status: 'Status',
    // ---- optional — VERIFY and fill from introspection output -------------
    sourceCity: null as string | null,        // e.g. 'Source' / 'From_City'
    destinationCity: null as string | null,   // e.g. 'Destination' / 'To_City'
    departureTime: null as string | null,     // e.g. 'Dep_Time' (HH:MM or datetime)
    arrivalTime: null as string | null,       // e.g. 'Arr_Time'
    operatorName: null as string | null,      // e.g. 'Operator_Name' / 'Travels_Name'
    busNumber: null as string | null,         // often NOT on the ticket; ops registers it
    mobile: null as string | null,            // e.g. 'Mobile' — only ever HMAC-hashed
  },
  detail: {
    joinKey: 'Ticket_no', // VERIFY: FK from _det to master (Ticket_no vs an Id column)
    seat: 'Seat_Num',
    gender: 'Gender',
    status: null as string | null, // VERIFY: per-seat status for partial cancellations
  },
  /** Also accept the operator's supplier PNR. Only enable if supplierpnr is indexed. */
  matchSupplierPnr: false,
};

const IDENT = /^[A-Za-z0-9_]+$/;
export function assertSafeIdentifiers() {
  const all = [
    ...Object.values(ABRS_MAP.tables).flatMap((t) => Object.values(t)),
    ...Object.values(ABRS_MAP.master),
    ...Object.values(ABRS_MAP.detail),
  ].filter((v): v is string => typeof v === 'string');
  for (const id of all) if (!IDENT.test(id)) throw new Error(`Unsafe SQL identifier in ABRS_MAP: ${id}`);
}
export const q = (id: string) => `\`${id}\``;
