/**
 * PatchWork node helpers shared by the `/api/v1/spatial/nodes` route handler and the
 * map overlay. Framework-free so it can be unit tested in node.
 */
import { BLUEPRINT } from "@/lib/theme";
import type { BBox } from "@/lib/gis/cagis";

export type DecayState = "green" | "yellow" | "red" | "unknown";

/** Decay palette. `unknown` = node has no expiry timestamps yet (never a faked health state). */
export const DECAY_COLORS: Record<DecayState, string> = {
  green: "#34D399",
  yellow: "#FBBF24",
  red: "#F87171",
  unknown: BLUEPRINT.inkMuted,
};

/** Numeric severity so MapLibre clusters can aggregate the worst decay state with `max`. */
export const DECAY_SEVERITY: Record<DecayState, number> = {
  unknown: 0,
  green: 1,
  yellow: 2,
  red: 3,
};

const DECAY_STATES = new Set<string>(["green", "yellow", "red", "unknown"]);

export function toDecayState(value: unknown): DecayState {
  return typeof value === "string" && DECAY_STATES.has(value) ? (value as DecayState) : "unknown";
}

/** Row shape returned by the `patchwork.nodes_in_bbox` RPC. */
export interface NodeRow {
  node_id: string;
  latitude: number;
  longitude: number;
  status: string;
  decay_state: string;
  expires_at_yellow: string | null;
  expires_at_red: string | null;
  sha256_hash: string | null;
  verified_at: string | null;
  az_heading: number | string | null;
}

export interface PatchworkNodeProperties {
  node_id: string;
  decay_state: DecayState;
  severity: number;
  expires_at_yellow: string | null;
  expires_at_red: string | null;
  /** Image fingerprint recorded at verification (SHA-256 hex). */
  verification_hash: string | null;
  verified_at: string | null;
  /** Sightline azimuth in degrees (0–360, clockwise from north); null when not recorded. */
  az_heading: number | null;
}

export type PatchworkNodeFeature = GeoJSON.Feature<GeoJSON.Point, PatchworkNodeProperties>;

export interface PatchworkNodeCollection extends GeoJSON.FeatureCollection<GeoJSON.Point, PatchworkNodeProperties> {
  /** True when the server hit its row cap, i.e. more nodes exist in the bbox than returned. */
  truncated: boolean;
}

/** Selected node as surfaced in the Inspector HUD. */
export interface PatchworkNodeSelection extends PatchworkNodeProperties {
  lng: number;
  lat: number;
}

export const NODES_MAX_ROWS = 2000;
/** Widest bbox the API accepts (degrees); keeps a single request from scanning the whole table. */
export const MAX_BBOX_SPAN_DEGREES = 10;

export type BBoxParseResult = { ok: true; bbox: BBox } | { ok: false; error: string };

/** Parses `west,south,east,north` (WGS84) from a query-string value. */
export function parseBBoxParam(raw: string | null): BBoxParseResult {
  if (!raw) return { ok: false, error: "Missing required query parameter: bbox=west,south,east,north" };
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 4 || parts.some((p) => p === "")) {
    return { ok: false, error: "bbox must be four comma-separated numbers: west,south,east,north" };
  }
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) {
    return { ok: false, error: "bbox values must be finite numbers" };
  }
  const [west, south, east, north] = nums;
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    return { ok: false, error: "bbox must be within WGS84 bounds (lng ±180, lat ±90)" };
  }
  if (west >= east || south >= north) {
    return { ok: false, error: "bbox must satisfy west < east and south < north" };
  }
  if (east - west > MAX_BBOX_SPAN_DEGREES || north - south > MAX_BBOX_SPAN_DEGREES) {
    return { ok: false, error: `bbox span must not exceed ${MAX_BBOX_SPAN_DEGREES} degrees; zoom in` };
  }
  return { ok: true, bbox: [west, south, east, north] };
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function nodesToFeatureCollection(rows: readonly NodeRow[], limit = NODES_MAX_ROWS): PatchworkNodeCollection {
  const features: PatchworkNodeFeature[] = [];
  for (const row of rows) {
    const lng = toNumberOrNull(row.longitude);
    const lat = toNumberOrNull(row.latitude);
    if (lng === null || lat === null) continue; // never plot a node at a guessed location
    const decay = toDecayState(row.decay_state);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        node_id: row.node_id,
        decay_state: decay,
        severity: DECAY_SEVERITY[decay],
        expires_at_yellow: row.expires_at_yellow ?? null,
        expires_at_red: row.expires_at_red ?? null,
        verification_hash: row.sha256_hash ?? null,
        verified_at: row.verified_at ?? null,
        az_heading: toNumberOrNull(row.az_heading),
      },
    });
  }
  return { type: "FeatureCollection", features, truncated: rows.length >= limit };
}

/** Compass label for an azimuth, e.g. 271.5 → "W". */
export function compassLabel(azimuth: number): string {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const normalized = ((azimuth % 360) + 360) % 360;
  return points[Math.round(normalized / 22.5) % 16];
}
