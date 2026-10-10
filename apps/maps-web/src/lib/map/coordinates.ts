export interface LngLat {
  lng: number;
  lat: number;
}

/** Formats a coordinate as a fixed-width surveyor readout, e.g. `39.103100° N  84.512000° W`. */
export function formatCoordinate({ lng, lat }: LngLat, precision = 6): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(precision)}° ${ns}  ${Math.abs(lng).toFixed(precision)}° ${ew}`;
}

/** Normalises longitude into [-180, 180) — MapLibre can report wrapped values after panning across the antimeridian. */
export function wrapLng(lng: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}
