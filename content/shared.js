// Haversine distance between two [lat, lon] points, in miles.
export function haversineMiles(a, b) {
  const R = 3958.8; // Earth radius in miles
  const toRad = deg => deg * Math.PI / 180;

  const [lat1, lon1] = a;
  const [lat2, lon2] = b;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}
