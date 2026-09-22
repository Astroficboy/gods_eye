// Low-precision solar ephemeris (good to ~0.1°), enough for a day/night overlay.
const RAD = Math.PI / 180;

export function subsolarPoint(date = new Date()) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / RAD;
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra - gmst;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: dec / RAD, lon };
}

/** Sun elevation in degrees above the horizon at a location. */
export function sunElevation(lat, lon, date = new Date()) {
  const s = subsolarPoint(date);
  const h = (lon - s.lon) * RAD;
  const v = Math.sin(lat * RAD) * Math.sin(s.lat * RAD) +
    Math.cos(lat * RAD) * Math.cos(s.lat * RAD) * Math.cos(h);
  return Math.asin(v) / RAD;
}

/** Polygon (lat/lon ring) covering the night side of the Earth. */
export function nightPolygon(date = new Date()) {
  const s = subsolarPoint(date);
  const tanDec = Math.tan((Math.abs(s.lat) < 0.01 ? 0.01 : s.lat) * RAD);
  const ring = [];
  for (let lon = -180; lon <= 180; lon += 1) {
    const lat = Math.atan(-Math.cos((lon - s.lon) * RAD) / tanDec) / RAD;
    ring.push([lat, lon]);
  }
  const pole = s.lat > 0 ? -90 : 90;
  ring.push([pole, 180], [pole, -180]);
  return ring;
}
