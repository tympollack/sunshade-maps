import { getServerSupabase } from "@/lib/supabase/server";
import {
  NODES_MAX_ROWS,
  nodesToFeatureCollection,
  parseBBoxParam,
  type NodeRow,
} from "@/lib/patchwork/nodes";

/**
 * GET /api/v1/spatial/nodes?bbox=west,south,east,north
 *
 * Verified PatchWork nodes intersecting the bounding box (PostGIS ST_MakeEnvelope via the
 * `patchwork.nodes_in_bbox` RPC), with NOW()-relative decay state computed in the database.
 * Public civic data only: no user ids, image keys or report content are returned.
 */
export async function GET(request: Request) {
  const parsed = parseBBoxParam(new URL(request.url).searchParams.get("bbox"));
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const supabase = await getServerSupabase();
  if (!supabase) {
    return Response.json({ error: "Spatial backend is not configured" }, { status: 503 });
  }

  const [west, south, east, north] = parsed.bbox;
  const { data, error } = await supabase.schema("patchwork").rpc("nodes_in_bbox", {
    p_west: west,
    p_south: south,
    p_east: east,
    p_north: north,
    p_limit: NODES_MAX_ROWS,
  });

  if (error) {
    console.error("[maps-web] patchwork.nodes_in_bbox failed:", error.message);
    return Response.json({ error: "Failed to load PatchWork nodes" }, { status: 502 });
  }

  const rows = (data ?? []) as NodeRow[];
  return Response.json(nodesToFeatureCollection(rows), {
    // Decay colours depend on NOW(); keep browser reuse short and never share across users.
    headers: { "Cache-Control": "private, max-age=15" },
  });
}
