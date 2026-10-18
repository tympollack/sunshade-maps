/**
 * Data access for the Parcel Inspector drawer. Everything is fetched on demand for the
 * selected parcel and framework-free so it can be unit tested in node with an injected
 * `fetchImpl`. Missing upstream values are returned as `null` - never defaulted or faked.
 */
import { latLngToCell } from "h3-js";
import type { LngLat } from "@/lib/map/coordinates";
import {
  CAGIS_BASE_URL,
  CAGIS_LAYERS,
  CagisQueryError,
  getJson,
  parseFeatureCollection,
  stringOrNull,
  type BBox,
  type QueryOptions,
} from "@/lib/gis/cagis";
import { FEMA_FLOOD_HAZARD_ZONES_LAYER_ID } from "@/lib/gis/federal";
import { toDecayState, type PatchworkNodeCollection, type PatchworkNodeSelection } from "@/lib/patchwork/nodes";
import { VALERIE_H3_RESOLUTION, type SentimentCellProperties } from "@/lib/valerie/sentiment";

const FEMA_NFHL_MAPSERVER = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer";
/** FEMA encodes "no base flood elevation" as -9999. */
const FEMA_NO_BFE = -9999;
/** PatchWork audits are listed when within this many degrees (~30 m) of the parcel bounds. */
export const AUDIT_PAD_DEGREES = 0.0003;

/** Thrown when an endpoint requires the shared SSO session and the visitor is signed out. */
export class SignInRequiredError extends Error {
  constructor() {
    super("Sign in required");
    this.name = "SignInRequiredError";
  }
}

// ─── Parcel (CAGIS Cadastral) ────────────────────────────────────────────────

export interface ParcelDetails {
  parcelId: string;
  address: string | null;
  owners: string[];
  ownerMailingAddress: string | null;
  /** CAGIS "Land Use Class" code (numeric; description table is not published on the layer). */
  landUseClass: number | null;
  acres: number | null;
  marketLandValue: number | null;
  marketImprovementValue: number | null;
  marketTotalValue: number | null;
  annualTaxes: number | null;
  taxesPaid: number | null;
  delinquentTaxes: number | null;
  /** ISO date (YYYY-MM-DD) of the last recorded sale. */
  lastSaleDate: string | null;
  lastSaleAmount: number | null;
  taxDistrict: string | null;
  schoolDistrict: string | null;
  homestead: boolean | null;
  foreclosure: boolean | null;
  /** Parcel polygon bounds [west, south, east, north]; `null` when geometry is unavailable. */
  bounds: BBox | null;
}

const PARCEL_DETAIL_FIELDS = [
  "PARCELID",
  "ADDRNO",
  "ADDRST",
  "ADDRSF",
  "OWNNM1",
  "OWNNM2",
  "OWNAD1",
  "OWNADCITY",
  "OWNADSTATE",
  "OWNADZIP",
  "CLASS",
  "ACREDEED",
  "MKTLND",
  "MKTIMP",
  "MKT_TOTAL_VAL",
  "ANNUAL_TAXES",
  "TAXES_PAID",
  "DELQ_TAXES",
  "SALDAT",
  "SALAMT",
  "TAXDST_DIS",
  "SCHOOL_CODE_DIS",
  "HMSD_FLAG",
  "FORECL_FLAG",
] as const;

/** CAGIS parcel ids are short alphanumerics; reject anything else before it reaches a `where` clause. */
const PARCEL_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function flagOrNull(value: unknown): boolean | null {
  const s = stringOrNull(value)?.toUpperCase();
  if (s === "Y") return true;
  if (s === "N") return false;
  return null;
}

function epochToIsoDate(value: unknown): string | null {
  const ms = numberOrNull(value);
  if (ms === null) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function joinParts(parts: unknown[], separator: string): string | null {
  const present = parts.map(stringOrNull).filter((p): p is string => p !== null);
  return present.length > 0 ? present.join(separator) : null;
}

/** Walks every coordinate of a (Multi)Polygon and returns its bounds, or `null` for other geometry. */
export function geometryBounds(geometry: GeoJSON.Geometry | null | undefined): BBox | null {
  if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

export function parseParcelDetails(feature: GeoJSON.Feature): ParcelDetails | null {
  const p = (feature.properties ?? {}) as Record<string, unknown>;
  const parcelId = stringOrNull(p.PARCELID);
  if (!parcelId) return null;
  return {
    parcelId,
    address: joinParts([p.ADDRNO, p.ADDRST, p.ADDRSF], " "),
    owners: [p.OWNNM1, p.OWNNM2].map(stringOrNull).filter((o): o is string => o !== null),
    ownerMailingAddress: joinParts(
      [p.OWNAD1, joinParts([p.OWNADCITY, joinParts([p.OWNADSTATE, p.OWNADZIP], " ")], ", ")],
      ", ",
    ),
    landUseClass: numberOrNull(p.CLASS),
    acres: numberOrNull(p.ACREDEED),
    marketLandValue: numberOrNull(p.MKTLND),
    marketImprovementValue: numberOrNull(p.MKTIMP),
    marketTotalValue: numberOrNull(p.MKT_TOTAL_VAL),
    annualTaxes: numberOrNull(p.ANNUAL_TAXES),
    taxesPaid: numberOrNull(p.TAXES_PAID),
    delinquentTaxes: numberOrNull(p.DELQ_TAXES),
    lastSaleDate: epochToIsoDate(p.SALDAT),
    lastSaleAmount: numberOrNull(p.SALAMT),
    taxDistrict: stringOrNull(p.TAXDST_DIS),
    schoolDistrict: stringOrNull(p.SCHOOL_CODE_DIS),
    homestead: flagOrNull(p.HMSD_FLAG),
    foreclosure: flagOrNull(p.FORECL_FLAG),
    bounds: geometryBounds(feature.geometry),
  };
}

export function buildParcelDetailsUrl(parcelId: string): string {
  if (!PARCEL_ID_RE.test(parcelId)) throw new CagisQueryError("Invalid parcel id");
  const params = new URLSearchParams({
    where: `PARCELID='${parcelId}'`,
    outFields: PARCEL_DETAIL_FIELDS.join(","),
    outSR: "4326",
    returnGeometry: "true",
    geometryPrecision: "6",
    resultRecordCount: "1",
    f: "geojson",
  });
  return `${CAGIS_BASE_URL}/${CAGIS_LAYERS.parcels.path}/query?${params.toString()}`;
}

/** Ownership / assessment record for a parcel, or `null` when CAGIS has no such parcel. */
export async function fetchParcelDetails(parcelId: string, options: QueryOptions = {}): Promise<ParcelDetails | null> {
  const { features } = parseFeatureCollection(await getJson(buildParcelDetailsUrl(parcelId), options));
  return features[0] ? parseParcelDetails(features[0]) : null;
}

// ─── Flood risk (FEMA NFHL) ──────────────────────────────────────────────────

export interface FloodZoneInfo {
  /** FEMA flood zone designation, e.g. `AE`, `X`. */
  zone: string | null;
  subtype: string | null;
  /** Whether the point lies inside the Special Flood Hazard Area (1% annual chance). */
  specialFloodHazardArea: boolean | null;
  /** Base flood elevation in feet; `null` when FEMA publishes none. */
  baseFloodElevation: number | null;
}

export function buildFloodQueryUrl(point: LngLat): string {
  const params = new URLSearchParams({
    geometry: `${point.lng},${point.lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE",
    returnGeometry: "false",
    resultRecordCount: "1",
    f: "json",
  });
  return `${FEMA_NFHL_MAPSERVER}/${FEMA_FLOOD_HAZARD_ZONES_LAYER_ID}/query?${params.toString()}`;
}

export function parseFloodZone(body: unknown): FloodZoneInfo | null {
  if (typeof body !== "object" || body === null) throw new Error("FEMA returned an unexpected payload");
  const features = (body as { features?: unknown }).features;
  if (!Array.isArray(features)) throw new Error("FEMA returned an unexpected payload");
  const attrs = (features[0] as { attributes?: Record<string, unknown> } | undefined)?.attributes;
  if (!attrs) return null;
  const bfe = numberOrNull(attrs.STATIC_BFE);
  const sfha = stringOrNull(attrs.SFHA_TF)?.toUpperCase();
  return {
    zone: stringOrNull(attrs.FLD_ZONE),
    subtype: stringOrNull(attrs.ZONE_SUBTY),
    specialFloodHazardArea: sfha === "T" ? true : sfha === "F" ? false : null,
    baseFloodElevation: bfe === null || bfe === FEMA_NO_BFE ? null : bfe,
  };
}

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

async function fetchJson(url: string, label: string, { signal, fetchImpl }: QueryOptions): Promise<Response> {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  const response = await doFetch(url, { signal });
  if (response.status === 401) throw new SignInRequiredError();
  if (!response.ok) throw new Error(`${label} responded with HTTP ${response.status}`);
  return response;
}

/** FEMA flood zone at a coordinate, or `null` when NFHL has no mapped zone there (unmapped area). */
export async function fetchFloodZone(point: LngLat, options: QueryOptions = {}): Promise<FloodZoneInfo | null> {
  const response = await fetchJson(buildFloodQueryUrl(point), "FEMA NFHL", options);
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null && "error" in body) {
    throw new Error("FEMA NFHL query error");
  }
  return parseFloodZone(body);
}

// ─── PatchWork audits (same-origin API) ──────────────────────────────────────

export function auditBBox(bounds: BBox): BBox {
  const [w, s, e, n] = bounds;
  return [w - AUDIT_PAD_DEGREES, s - AUDIT_PAD_DEGREES, e + AUDIT_PAD_DEGREES, n + AUDIT_PAD_DEGREES];
}

export interface NearbyAudits {
  nodes: PatchworkNodeSelection[];
  /** True when the API row cap was hit, i.e. more nodes exist than listed. */
  truncated: boolean;
}

export function collectionToSelections(collection: PatchworkNodeCollection): PatchworkNodeSelection[] {
  return collection.features.map((f) => ({
    ...f.properties,
    decay_state: toDecayState(f.properties.decay_state),
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
}

/** Verified PatchWork nodes around the parcel (within {@link AUDIT_PAD_DEGREES} of its bounds). */
export async function fetchNearbyAudits(bounds: BBox, options: QueryOptions = {}): Promise<NearbyAudits> {
  const bbox = auditBBox(bounds).map((v) => v.toFixed(6)).join(",");
  const response = await fetchJson(`/api/v1/spatial/nodes?bbox=${bbox}`, "PatchWork nodes", options);
  const body = (await response.json()) as PatchworkNodeCollection;
  if (!body || !Array.isArray(body.features)) throw new Error("PatchWork returned an unexpected payload");
  return { nodes: collectionToSelections(body), truncated: body.truncated === true };
}

// ─── Valerie community sentiment (same-origin, SSO-gated) ────────────────────

/** H3 cell (Valerie's stored resolution) containing a coordinate. */
export function sentimentCellAt(point: LngLat): string {
  return latLngToCell(point.lat, point.lng, VALERIE_H3_RESOLUTION);
}

/**
 * Community sentiment for the cell under `point`. Resolves `null` when no cell met the
 * K-anonymity threshold (the server omits it; we never show a count or a default).
 * Rejects with {@link SignInRequiredError} for signed-out visitors.
 */
export async function fetchSentimentAt(point: LngLat, options: QueryOptions = {}): Promise<SentimentCellProperties | null> {
  const cell = sentimentCellAt(point);
  const response = await fetchJson(`/api/spatial/valerie?h3=${encodeURIComponent(cell)}`, "Valerie sentiment", options);
  const body = (await response.json()) as GeoJSON.FeatureCollection<GeoJSON.Polygon, SentimentCellProperties>;
  if (!body || !Array.isArray(body.features)) throw new Error("Valerie returned an unexpected payload");
  return body.features.find((f) => f.properties?.h3 === cell)?.properties ?? null;
}
