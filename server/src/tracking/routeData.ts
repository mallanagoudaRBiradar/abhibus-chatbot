/**
 * NH 44 corridor, Hyderabad -> Bengaluru. Coordinates are approximate and only
 * used by the mock tracker + "nearest landmark" labelling.
 */
export const NH44_WAYPOINTS = [
  { name: 'Hyderabad', lat: 17.3784, lng: 78.4867 },
  { name: 'Shamshabad', lat: 17.2403, lng: 78.4294 },
  { name: 'Shadnagar', lat: 17.0716, lng: 78.2057 },
  { name: 'Jadcherla', lat: 16.7631, lng: 78.1443 },
  { name: 'Kothakota', lat: 16.3836, lng: 77.9396 },
  { name: 'Kurnool Highway', lat: 15.8281, lng: 78.0373 },
  { name: 'Dhone', lat: 15.3958, lng: 77.8726 },
  { name: 'Gooty', lat: 15.1123, lng: 77.637 },
  { name: 'Anantapur', lat: 14.6819, lng: 77.6006 },
  { name: 'Penukonda', lat: 14.0835, lng: 77.596 },
  { name: 'Bagepalli', lat: 13.784, lng: 77.795 },
  { name: 'Devanahalli', lat: 13.2468, lng: 77.712 },
  { name: 'Hebbal', lat: 13.0358, lng: 77.597 },
  { name: 'Bengaluru', lat: 12.9177, lng: 77.6238 },
];

/** Toll plazas along the corridor as fractions of route distance (demo). */
export const NH44_TOLLS = [
  { name: 'Rayakal Toll Plaza', frac: 0.07 },
  { name: 'Pullur Toll Plaza', frac: 0.28 },
  { name: 'Amakathadu Toll Plaza', frac: 0.43 },
  { name: 'Marur Toll Plaza', frac: 0.6 },
  { name: 'Bagepalli Toll Plaza', frac: 0.84 },
];

/** Operator-curated pickup/drop landmark photos. imageUrl null => illustrated fallback in app. */
export const NH44_PICKUP_POINTS = [
  { id: 'lm_lakdi', pointName: 'Lakdikapul', frac: 0.0, title: 'Opposite Telangana Bhavan bus bay', caption: 'Look for the blue Sapphire flag near the bus shelter.', imageUrl: null },
  { id: 'lm_kurnool', pointName: 'Kurnool', frac: 0.36, title: 'Opposite HP Petrol Pump', caption: 'Bypass service road, stand near the tea stall with the red awning.', imageUrl: null },
  { id: 'lm_atp', pointName: 'Anantapur', frac: 0.62, title: 'Clock Tower bus bay, platform 3', caption: 'Bus halts for 5 minutes only. Be there 10 minutes early.', imageUrl: null },
  { id: 'lm_hebbal', pointName: 'Hebbal', frac: 0.96, title: 'Below Hebbal flyover, BMTC stop', caption: 'First drop point in Bengaluru. Autos wait across the road.', imageUrl: null },
];
