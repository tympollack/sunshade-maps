/**
 * Project Valerie sentiment overlay helpers (shared by the API route and the map layer).
 *
 * Privacy model (defence in depth - the database RPC is the primary gate):
 *   * Cells with fewer than {@link K_MIN_RESPONDENTS} distinct respondents are never
 *     emitted; this module re-checks even though `valerie.h3_sentiment_cells` already
 *     suppresses them.
 *   * Output features carry only the H3 cell, mean Likert and mean confidence. No user
 *     ids, GPS points, comments, or exact respondent counts.
 *
 * H3 resolution: Valerie stores `h3_hex_index` at resolution 7 (~5 km2). See the
 * 20261010182000_valerie_h3_sentiment_cells_rpc migration for details.
 */
import { cellToBoundary, isValidCell, polygonToCells } from "h3-js";
import type { BBox } from "@/lib/gis/cagis";

/** H3 resolution of `valerie.poll_responses.h3_hex_index`. */
export const VALERIE_H3_RESOLUTION = 7;
/** Anti-doxxing gate: minimum distinct respondents for a cell to render. */
export const K_MIN_RESPONDENTS = 10;
/** Upper bound on cells requested per viewport (matches the RPC cap). */
export const MAX_CELLS_PER_REQUEST = 5000;

/** Likert −2..+2 colour ramp stops: Crimson → Amber → Emerald. */
export const SENTIMENT_RAMP = [
  { score: -2, color: "#DC143C" },
  { score: 0, color: "#FFBF00" },
  { score: 2, color: "#50C878" },
] as const;

/** 3D extrusion metres per confidence point (0–100% → 0–800 m). */
export const CONFIDENCE_METERS_PER_POINT = 8;

/** Row shape returned by the `valerie.h3_sentiment_cells` RPC. */
export interface SentimentRow {
  h3_hex_index: string;
  respondent_count: number;
  avg_likert: number | string;
  avg_confidence: number | string;
}

export interface SentimentCellProperties {
  h3: string;
  /** Mean Likert score, −2 (strongly negative) … +2 (strongly positive). */
  avg_likert: number;
  /** Mean confidence, 0–100. */
  avg_confidence: number;
}

export type SentimentCollection = GeoJSON.FeatureCollection<GeoJSON.Polygon, SentimentCellProperties>;

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** CSS colour for a mean Likert score (clamped to −2..+2). */
export function sentimentColor(score: number): string {
  const s = Math.min(2, Math.max(-2, score));
  const [a, b] = s <= 0 ? [SENTIMENT_RAMP[0], SENTIMENT_RAMP[1]] : [SENTIMENT_RAMP[1], SENTIMENT_RAMP[2]];
  const t = (s - a.score) / (b.score - a.score);
  const ca = hexToRgb(a.color);
  const cb = hexToRgb(b.color);
  const rgb = ca.map((c, i) => Math.round(c + (cb[i] - c) * t));
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** Extrusion height in metres for a 0–100 confidence score (clamped). */
export function confidenceHeight(confidence: number): number {
  return Math.min(100, Math.max(0, confidence)) * CONFIDENCE_METERS_PER_POINT;
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Converts RPC rows into hexagon polygons. Rows below the K-anonymity threshold, with
 * invalid H3 ids, or with non-numeric aggregates are dropped (suppressed, never defaulted).
 */
export function sentimentRowsToFeatureCollection(rows: readonly SentimentRow[]): SentimentCollection {
  const features: SentimentCollection["features"] = [];
  for (const row of rows) {
    if (!Number.isFinite(row.respondent_count) || row.respondent_count < K_MIN_RESPONDENTS) continue;
    if (typeof row.h3_hex_index !== "string" || !isValidCell(row.h3_hex_index)) continue;
    const likert = toFiniteNumber(row.avg_likert);
    const confidence = toFiniteNumber(row.avg_confidence);
    if (likert === null || confidence === null) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [cellToBoundary(row.h3_hex_index, true)] },
      properties: {
        h3: row.h3_hex_index,
        avg_likert: Math.min(2, Math.max(-2, likert)),
        avg_confidence: Math.min(100, Math.max(0, confidence)),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

export type ViewportCellsResult = { ok: true; cells: string[] } | { ok: false; error: string };

/** H3 cells (resolution 7) covering a viewport bbox; refuses viewports that would exceed the cap. */
export function viewportCells(bbox: BBox, resolution = VALERIE_H3_RESOLUTION): ViewportCellsResult {
  const [west, south, east, north] = bbox;
  const ring: [number, number][] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  const cells = polygonToCells([ring], resolution, true);
  if (cells.length > MAX_CELLS_PER_REQUEST) {
    return { ok: false, error: `Viewport covers ${cells.length} cells (max ${MAX_CELLS_PER_REQUEST}); zoom in` };
  }
  return { ok: true, cells };
}
