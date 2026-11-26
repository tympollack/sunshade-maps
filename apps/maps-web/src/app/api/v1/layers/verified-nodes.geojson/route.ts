import { getServerSupabase } from "@/lib/supabase/server";
import {
  NODES_MAX_ROWS,
  filterByDecay,
  nodesToFeatureCollection,
  parseBBoxParam,
  parseDecayFilter,
  type NodeRow,
} from "@/lib/patchwork/nodes";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status: number, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, ...extra } });
}

/**
 * GET /api/v1/layers/verified-nodes.geojson?bbox=west,south,east,north[&decay=red,yellow]
 *
 * Public, CORS-enabled GeoJSON feed of verified PatchWork nodes for municipal GIS consumers
 * (e.g. ArcGIS / QGIS "GeoJSON layer from URL"). Decay state is computed live in the database.
 * Public civic data only: no user ids, image keys or report content.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = parseBBoxParam(params.get("bbox"));
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const decay = parseDecayFilter(params.get("decay"));
  if (!decay.ok) return json({ error: decay.error }, 400);

  const supabase = await getServerSupabase();
  if (!supabase) return json({ error: "Spatial backend is not configured" }, 503);

  const [west, south, east, north] = parsed.bbox;
  const { data, error } = await supabase.schema("patchwork").rpc("nodes_in_bbox", {
    p_west: west,
    p_south: south,
    p_east: east,
    p_north: north,
    p_limit: NODES_MAX_ROWS + 1,
  });
  if (error) {
    console.error("[maps-web] verified-nodes.geojson: patchwork.nodes_in_bbox failed:", error.message);
    return json({ error: "Failed to load PatchWork nodes" }, 502);
  }

  const collection = filterByDecay(nodesToFeatureCollection((data ?? []) as NodeRow[]), decay.states);
  return new Response(JSON.stringify(collection), {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/geo+json; charset=utf-8",
      // Live decay state: a short shared cache protects the database from polling GIS clients.
      "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
    },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400" } });
}
