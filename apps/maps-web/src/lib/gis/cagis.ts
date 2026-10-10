/**
 * CAGIS (Cincinnati Area GIS) ArcGIS REST client for the Hamilton County testbed
 * (FIPS 39061). Everything here is framework-free so it can be unit tested in node.
 *
 * Endpoints were verified against https://cagisonline.hamilton-co.org/arcgis/rest/services
 * (GeoJSON output supported, CORS reflects the request origin). They are mirrored in the
 * `maps.jurisdiction_layers` registry by the Hamilton County seed migration in
 * sunshade-db-platform.
 */
import type { LngLat } from "@/lib/map/coordinates";

export const CAGIS_FIPS_CODE = "39061";
export const CAGIS_BASE_URL = "https://cagisonline.hamilton-co.org/arcgis/rest/services";

/** [west, south, east, north] in WGS84 degrees. */
export type BBox = readonly [number, number, number, number];

export type CagisLayerKey = "parcels" | "zoning" | "streets";

export interface CagisLayerConfig {
  key: CagisLayerKey;
  label: string;
  /** Path under {@link CAGIS_BASE_URL} up to and including the layer id. */
  path: string;
  /** Only the attributes we actually render/select; keeps payloads small. */
  outFields: readonly string[];
  /** Below this zoom the layer is not queried (avoids streaming county-wide datasets). */
  minZoom: number;
  /** Server page size (the MapServer maxRecordCount). */
  pageSize: number;
  /** Max pages fetched per viewport when the server reports exceededTransferLimit. */
  maxPages: number;
}

export const CAGIS_LAYERS: Record<CagisLayerKey, CagisLayerConfig> = {
  parcels: {
    key: "parcels",
    label: "Parcels",
    path: "COUNTYWIDE/Cadastral/MapServer/0",
    outFields: ["PARCELID", "ADDRNO", "ADDRST", "ADDRSF"],
    minZoom: 16,
    pageSize: 1000,
    maxPages: 3,
  },
  zoning: {
    key: "zoning",
    label: "Zoning",
    path: "Countywide_Layers/Zoning/MapServer/21",
    outFields: ["ZONING", "ZONE_DESCRIPTION", "JURISDICTION"],
    minZoom: 12,
    pageSize: 2000,
    maxPages: 2,
  },
  streets: {
    key: "streets",
    label: "Street Centerlines",
    path: "COUNTYWIDE/CagisCoreLayers/MapServer/5",
    outFields: ["STRLABEL", "FEATUREID"],
    minZoom: 15,
    pageSize: 2000,
    maxPages: 2,
  },
};

export interface ZoningInfo {
  code: string | null;
  description: string | null;
  jurisdiction: string | null;
}

export interface LayerResult {
  collection: GeoJSON.FeatureCollection;
  /** True when more features exist than we were willing to page through. */
  truncated: boolean;
}

export class CagisQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CagisQueryError";
  }
}

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

interface QueryOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

// ─── Geometry helpers ───────────────────────────────────────────────────────

/** Expands a bbox by `ratio` of its width/height on each side (prefetch margin while panning). */
export function padBBox(bbox: BBox, ratio: number): BBox {
  const [w, s, e, n] = bbox;
  const dx = (e - w) * ratio;
  const dy = (n - s) * ratio;
  return [w - dx, Math.max(-90, s - dy), e + dx, Math.min(90, n + dy)];
}

export function bboxContains(outer: BBox, inner: BBox): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

/** Degrees per screen pixel for a 512px-tile web map at `zoom` (used for server-side generalisation). */
export function degreesPerPixel(zoom: number): number {
  return 360 / (512 * 2 ** zoom);
}

// ─── Query construction ─────────────────────────────────────────────────────

function baseParams(layer: CagisLayerConfig): URLSearchParams {
  const params = new URLSearchParams();
  params.set("where", "1=1");
  params.set("inSR", "4326");
  params.set("outSR", "4326");
  params.set("spatialRel", "esriSpatialRelIntersects");
  params.set("outFields", layer.outFields.join(","));
  return params;
}

export function buildViewportQueryUrl(
  layer: CagisLayerConfig,
  bbox: BBox,
  options: { zoom: number; offset?: number },
): string {
  const params = baseParams(layer);
  params.set("geometry", bbox.join(","));
  params.set("geometryType", "esriGeometryEnvelope");
  params.set("returnGeometry", "true");
  params.set("geometryPrecision", "6");
  // Generalise to ~1 screen pixel: big payload win on streets/zoning, invisible on screen.
  params.set("maxAllowableOffset", degreesPerPixel(options.zoom).toFixed(8));
  // Stable ordering is required for resultOffset paging to be deterministic.
  params.set("orderByFields", "OBJECTID");
  params.set("resultOffset", String(options.offset ?? 0));
  params.set("resultRecordCount", String(layer.pageSize));
  params.set("f", "geojson");
  return `${CAGIS_BASE_URL}/${layer.path}/query?${params.toString()}`;
}

export function buildPointQueryUrl(layer: CagisLayerConfig, point: LngLat): string {
  const params = baseParams(layer);
  params.set("geometry", `${point.lng},${point.lat}`);
  params.set("geometryType", "esriGeometryPoint");
  params.set("returnGeometry", "false");
  params.set("resultRecordCount", "1");
  params.set("f", "json");
  return `${CAGIS_BASE_URL}/${layer.path}/query?${params.toString()}`;
}

/** GeoJSON (with geometry) query for the single parcel polygon containing `point`. */
export function buildParcelPointQueryUrl(point: LngLat): string {
  const params = baseParams(CAGIS_LAYERS.parcels);
  params.set("geometry", `${point.lng},${point.lat}`);
  params.set("geometryType", "esriGeometryPoint");
  params.set("returnGeometry", "true");
  params.set("geometryPrecision", "6");
  params.set("resultRecordCount", "1");
  params.set("f", "geojson");
  return `${CAGIS_BASE_URL}/${CAGIS_LAYERS.parcels.path}/query?${params.toString()}`;
}

// ─── Response handling ──────────────────────────────────────────────────────

async function getJson(url: string, { signal, fetchImpl }: QueryOptions): Promise<unknown> {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(url, { signal });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new CagisQueryError("CAGIS request failed", { cause });
  }
  if (!response.ok) {
    throw new CagisQueryError(`CAGIS responded with HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new CagisQueryError("CAGIS returned a non-JSON response", { cause });
  }
  // ArcGIS reports query failures as HTTP 200 with an `error` envelope.
  if (isRecord(body) && isRecord(body.error)) {
    const message = typeof body.error.message === "string" ? body.error.message : "unknown error";
    throw new CagisQueryError(`CAGIS query error: ${message}`);
  }
  return body;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : isRecord(error) && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseFeatureCollection(body: unknown): { features: GeoJSON.Feature[]; exceeded: boolean } {
  if (!isRecord(body) || body.type !== "FeatureCollection" || !Array.isArray(body.features)) {
    throw new CagisQueryError("CAGIS returned an unexpected GeoJSON payload");
  }
  const features = (body.features as unknown[]).filter(
    (f): f is GeoJSON.Feature => isRecord(f) && f.type === "Feature" && isRecord(f.geometry),
  );
  return { features, exceeded: body.exceededTransferLimit === true };
}

/**
 * Fetches every feature of `layerKey` intersecting `bbox`, following the server's
 * pagination up to the layer's `maxPages`. Rejects with {@link CagisQueryError}
 * (or an AbortError when `signal` fires) — never resolves with partial/fake data.
 */
export async function fetchLayerFeatures(
  layerKey: CagisLayerKey,
  bbox: BBox,
  zoom: number,
  options: QueryOptions = {},
): Promise<LayerResult> {
  const layer = CAGIS_LAYERS[layerKey];
  const features: GeoJSON.Feature[] = [];
  let truncated = false;

  for (let page = 0; page < layer.maxPages; page += 1) {
    const url = buildViewportQueryUrl(layer, bbox, { zoom, offset: page * layer.pageSize });
    const { features: pageFeatures, exceeded } = parseFeatureCollection(await getJson(url, options));
    features.push(...pageFeatures);
    // Still exceeded after the final allowed page => results are capped (truncated).
    truncated = exceeded;
    if (!exceeded) break;
  }

  return { collection: { type: "FeatureCollection", features }, truncated };
}

/** Resolves the zoning designation at a coordinate, or `null` when no zone covers it. */
export async function queryZoningAtPoint(point: LngLat, options: QueryOptions = {}): Promise<ZoningInfo | null> {
  const body = await getJson(buildPointQueryUrl(CAGIS_LAYERS.zoning, point), options);
  if (!isRecord(body) || !Array.isArray(body.features)) {
    throw new CagisQueryError("CAGIS returned an unexpected zoning payload");
  }
  const first: unknown = body.features[0];
  if (!isRecord(first) || !isRecord(first.attributes)) return null;
  const attrs = first.attributes;
  return {
    code: stringOrNull(attrs.ZONING),
    description: stringOrNull(attrs.ZONE_DESCRIPTION),
    jurisdiction: stringOrNull(attrs.JURISDICTION),
  };
}

/** Resolves the parcel polygon containing a coordinate, or `null` when none does. */
export async function queryParcelAtPoint(point: LngLat, options: QueryOptions = {}): Promise<GeoJSON.Feature | null> {
  const { features } = parseFeatureCollection(await getJson(buildParcelPointQueryUrl(point), options));
  return features[0] ?? null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Joins ADDRNO / ADDRST / ADDRSF into a display address; `null` when the parcel has none. */
export function formatParcelAddress(props: Record<string, unknown> | null | undefined): string | null {
  if (!props) return null;
  const parts = [props.ADDRNO, props.ADDRST, props.ADDRSF]
    .map(stringOrNull)
    .filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}
