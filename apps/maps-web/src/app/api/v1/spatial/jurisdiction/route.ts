import { after } from "next/server";
import {
  cloudflareQueueFromEnv,
  createSupabaseJurisdictionDb,
  resolveJurisdiction,
  type RpcCapableClient,
} from "@sunshade/spatial";
import { getServerSupabase } from "@/lib/supabase/server";

/**
 * GET /api/v1/spatial/jurisdiction?lng=<deg>&lat=<deg>
 *
 * Resolves a coordinate to its US county (PostGIS `ST_Contains`/`ST_Intersects` via
 * `maps.resolve_jurisdiction`). When the county has no active GIS registry entry a discovery job is
 * published to the Cloudflare Queue `gis-discovery-jobs` AFTER the response is sent (`after()`), so
 * the client is never blocked by, or exposed to failures of, the queue. Dispatch is skipped when
 * the CLOUDFLARE_* queue variables are not configured.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const lng = Number(params.get("lng"));
  const lat = Number(params.get("lat"));
  if (params.get("lng") === null || params.get("lat") === null || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    return Response.json({ error: "lng and lat are required numbers" }, { status: 400 });
  }
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    return Response.json({ error: "lng/lat out of range" }, { status: 400 });
  }

  const supabase = await getServerSupabase();
  if (!supabase) {
    return Response.json({ error: "Spatial backend is not configured" }, { status: 503 });
  }

  try {
    const jurisdiction = await resolveJurisdiction(
      { lng, lat },
      {
        db: createSupabaseJurisdictionDb(supabase as unknown as RpcCapableClient),
        queue: cloudflareQueueFromEnv(process.env),
        waitUntil: (work) =>
          after(async () => {
            await work;
          }),
        onDispatchError: (error, job) =>
          console.error(`[maps-web] discovery dispatch failed for ${job.fips_code}:`, error instanceof Error ? error.message : error),
      },
    );
    return Response.json({ jurisdiction }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[maps-web] maps.resolve_jurisdiction failed:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Failed to resolve jurisdiction" }, { status: 502 });
  }
}
