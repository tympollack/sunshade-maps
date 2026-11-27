/**
 * Desktop Command Center <-> mobile PatchWork PWA deep-link handoff.
 *
 *  - Inbound (PatchWork -> Maps): `/?node=<uuid>&lat=..&lng=..&z=..` opens the map on that node.
 *  - Outbound (Maps -> PatchWork): a "Field Verify" URL (rendered as a QR code) that opens the
 *    node in the PatchWork mobile PWA so a field worker can re-verify it on site.
 */
import { wrapLng, type LngLat } from "@/lib/map/coordinates";

export const DEFAULT_HANDOFF_ZOOM = 17;
const MIN_ZOOM = 1;
const MAX_ZOOM = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CommandCenterTarget {
  center: LngLat;
  zoom: number;
  /** Node to open in the inspector, when the link names one. */
  nodeId: string | null;
}

function finiteParam(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Parses an inbound deep link; `null` when it lacks a valid coordinate. */
export function parseCommandCenterParams(search: string | URLSearchParams): CommandCenterTarget | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const lat = finiteParam(params, "lat");
  const lng = finiteParam(params, "lng");
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -540 || lng > 540) return null;

  const z = finiteParam(params, "z");
  const node = params.get("node");
  return {
    center: { lng: wrapLng(lng), lat },
    zoom: z === null ? DEFAULT_HANDOFF_ZOOM : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)),
    nodeId: node !== null && UUID.test(node) ? node.toLowerCase() : null,
  };
}

/**
 * URL opened by the "Field Verify" QR code in the PatchWork mobile PWA. `base` is the PatchWork
 * origin (NEXT_PUBLIC_PATCHWORK_URL); `null` when it is not configured or not an http(s) URL.
 */
export function buildFieldVerifyUrl(base: string | undefined, nodeId: string, point: LngLat): string | null {
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/verify`;
  url.search = new URLSearchParams({
    node: nodeId,
    lat: point.lat.toFixed(6),
    lng: point.lng.toFixed(6),
    source: "maps",
  }).toString();
  return url.toString();
}
