/**
 * Precision pin snapping: a field-reported node can sit just outside the parcel it belongs to
 * (GPS drift). Given the CAGIS parcel polygon, a node inside it is left untouched; one outside
 * is snapped to the nearest point on the parcel boundary.
 */
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import polygonToLine from "@turf/polygon-to-line";
import { point as turfPoint } from "@turf/helpers";
import type { LngLat } from "@/lib/map/coordinates";

export interface SnapResult {
  /** Final pin position (equal to the input when it already lies inside the parcel). */
  point: LngLat;
  /** True when the pin had to be moved onto the parcel boundary. */
  snapped: boolean;
  /** Distance moved, in metres (0 when not snapped). */
  distanceMeters: number;
}

type ParcelPolygon = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

function isParcelPolygon(feature: GeoJSON.Feature): feature is ParcelPolygon {
  const t = feature.geometry?.type;
  return t === "Polygon" || t === "MultiPolygon";
}

/** Returns `null` when the feature has no polygon geometry to snap to. */
export function snapPointToParcel(pin: LngLat, parcel: GeoJSON.Feature): SnapResult | null {
  if (!isParcelPolygon(parcel)) return null;
  const pt = turfPoint([pin.lng, pin.lat]);
  if (booleanPointInPolygon(pt, parcel)) return { point: pin, snapped: false, distanceMeters: 0 };

  // MultiPolygon (or polygons with holes) yields a FeatureCollection of boundary lines.
  const lines = polygonToLine(parcel);
  const candidates = lines.type === "FeatureCollection" ? lines.features : [lines];
  let best: { lng: number; lat: number; dist: number } | null = null;
  for (const line of candidates) {
    const nearest = nearestPointOnLine(line, pt, { units: "meters" });
    const dist = nearest.properties.dist ?? Infinity;
    if (!best || dist < best.dist) {
      const [lng, lat] = nearest.geometry.coordinates;
      best = { lng, lat, dist };
    }
  }
  if (!best) return null;
  return { point: { lng: best.lng, lat: best.lat }, snapped: true, distanceMeters: best.dist };
}
