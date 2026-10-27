/**
 * Endpoint verification. Candidate URLs come from an LLM reading arbitrary web search results,
 * so they are treated as hostile input: https only, no credentials, no private/loopback hosts,
 * ArcGIS REST paths only, short timeouts, and a response must actually look like a public
 * feature layer before it is accepted.
 */
import type { CandidateEndpoints, FetchLike, LayerType, VerifiedLayer } from "./types";

/** Origin the browser client sends; CORS is verified against it. */
export const CLIENT_ORIGIN = "https://maps.sunshade.icu";
export const PROBE_TIMEOUT_MS = 8000;
const MAX_CANDIDATES_PER_LAYER = 3;

const ARCGIS_PATH = /\/rest\/services\/.+\/(FeatureServer|MapServer)(\/\d+)?$/i;
const PARCEL_FIELD = /^(parcel_?id|parcelid|parcel_?no|parcel_?num(ber)?|parid|pin|apn|parcel)$/i;
const ZONING_FIELD = /^(zoning|zone|zone_?code|zone_?class|zoning_?code|zoning_?class|zone_?desig(nation)?|zonedist)$/i;
const NAME_HINTS: Record<Exclude<LayerType, "auditor_search">, RegExp> = {
  parcels: /parcel|cadastr|tax\s*lot/i,
  zoning: /zoning|zone district/i,
  streets: /street|centerline|road/i,
};

/** Returns a normalised https URL, or `null` if it is unsafe to fetch. */
export function sanitizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return null;
  // Literal IPs (v4 or v6) are never legitimate county GIS hosts.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return null;
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

interface ArcGisJson {
  error?: { code?: number };
  type?: string;
  name?: string;
  geometryType?: string;
  fields?: { name: string }[];
  layers?: { id: number; name: string }[];
  capabilities?: string;
}

async function timed(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  return fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
}

/** `Access-Control-Allow-Origin` permits our client origin (wildcard or exact echo). */
export function allowsClientOrigin(response: Response): boolean {
  const allowed = response.headers.get("access-control-allow-origin");
  return allowed === "*" || allowed === CLIENT_ORIGIN;
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<ArcGisJson | null> {
  try {
    const response = await timed(fetchImpl, `${url}?f=json`, { method: "GET", headers: { Origin: CLIENT_ORIGIN } });
    if (!response.ok) return null;
    const body = (await response.json()) as ArcGisJson;
    return typeof body === "object" && body !== null ? body : null;
  } catch {
    return null;
  }
}

function pickField(fields: { name: string }[] | undefined, pattern: RegExp): string | null {
  return fields?.find((f) => pattern.test(f.name))?.name ?? null;
}

/** Service roots list their layers; choose the one whose name matches the wanted layer type. */
async function resolveLayerUrl(fetchImpl: FetchLike, url: string, type: Exclude<LayerType, "auditor_search">): Promise<string | null> {
  if (/\/\d+$/.test(url)) return url;
  const root = await getJson(fetchImpl, url);
  const match = root?.layers?.find((l) => NAME_HINTS[type].test(l.name));
  return match ? `${url}/${match.id}` : null;
}

/** Probes one ArcGIS candidate. Resolves `null` for dead, gated, wrong-shaped or non-public endpoints. */
export async function probeArcGisLayer(
  fetchImpl: FetchLike,
  rawUrl: string,
  type: Exclude<LayerType, "auditor_search">,
): Promise<VerifiedLayer | null> {
  const safe = sanitizeUrl(rawUrl);
  if (!safe || !ARCGIS_PATH.test(safe)) return null;
  const layerUrl = await resolveLayerUrl(fetchImpl, safe, type);
  if (!layerUrl) return null;

  // 1. Lightweight liveness + CORS check (HEAD).
  let cors = false;
  try {
    const head = await timed(fetchImpl, `${layerUrl}?f=json`, { method: "HEAD", headers: { Origin: CLIENT_ORIGIN } });
    // Some ArcGIS hosts reject HEAD (405); that is not evidence of a dead endpoint, so fall through to GET.
    if (head.status >= 300 && head.status !== 405 && head.status !== 501) return null;
    cors = allowsClientOrigin(head);
  } catch {
    return null;
  }

  // 2. Confirm it is a public, queryable layer of the right kind.
  let corsFromGet = false;
  let body: ArcGisJson | null = null;
  try {
    const response = await timed(fetchImpl, `${layerUrl}?f=json`, { method: "GET", headers: { Origin: CLIENT_ORIGIN } });
    if (!response.ok) return null;
    corsFromGet = allowsClientOrigin(response);
    body = (await response.json()) as ArcGisJson;
  } catch {
    return null;
  }
  // Token-gated (498/499) or any ArcGIS error envelope => proprietary / not public.
  if (!body || body.error) return null;
  if (!body.fields || body.fields.length === 0) return null;
  if (body.capabilities && !/query/i.test(body.capabilities)) return null;
  const geometry = body.geometryType ?? "";
  if (type === "streets" ? !/polyline/i.test(geometry) : !/polygon/i.test(geometry)) return null;

  return {
    layer_type: type,
    source_format: "esri_feature",
    endpoint_url: layerUrl,
    parcel_id_field: type === "parcels" ? pickField(body.fields, PARCEL_FIELD) : null,
    zoning_code_field: type === "zoning" ? pickField(body.fields, ZONING_FIELD) : null,
    is_cors_enabled: cors || corsFromGet,
  };
}

/** Property-card / auditor search: a plain public web link, only checked for liveness. */
export async function probePortalLink(fetchImpl: FetchLike, rawUrl: string): Promise<VerifiedLayer | null> {
  const safe = sanitizeUrl(rawUrl);
  if (!safe) return null;
  try {
    let response = await timed(fetchImpl, safe, { method: "HEAD" });
    if (response.status === 405 || response.status === 501) {
      response = await timed(fetchImpl, safe, { method: "GET" });
    }
    if (response.status >= 400) return null;
  } catch {
    return null;
  }
  return {
    layer_type: "auditor_search",
    source_format: "portal_link",
    endpoint_url: safe,
    parcel_id_field: null,
    zoning_code_field: null,
    is_cors_enabled: false,
  };
}

/** First verified candidate per layer type; dead links and gated portals are skipped silently. */
export async function verifyCandidates(fetchImpl: FetchLike, candidates: CandidateEndpoints): Promise<VerifiedLayer[]> {
  const verified: VerifiedLayer[] = [];
  const types: LayerType[] = ["parcels", "zoning", "streets", "auditor_search"];
  await Promise.all(
    types.map(async (type) => {
      const urls = [...new Set(candidates[type] ?? [])].slice(0, MAX_CANDIDATES_PER_LAYER);
      for (const url of urls) {
        const layer = type === "auditor_search" ? await probePortalLink(fetchImpl, url) : await probeArcGisLayer(fetchImpl, url, type);
        if (layer) {
          verified.push(layer);
          return;
        }
      }
    }),
  );
  return verified;
}
