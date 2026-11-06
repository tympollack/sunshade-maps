import type { JurisdictionDb, JurisdictionResolution, LngLatPoint } from "./resolveJurisdiction";

/** The slice of `@supabase/supabase-js` this adapter needs (structural, so no dependency). */
export interface RpcCapableClient {
  schema(name: "maps"): {
    rpc(
      fn: "resolve_jurisdiction",
      args: { p_lng: number; p_lat: number },
    ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
}

function isResolution(value: unknown): value is JurisdictionResolution {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.fips_code === "string" &&
    typeof row.county_name === "string" &&
    typeof row.state_code === "string" &&
    typeof row.is_registered === "boolean"
  );
}

/** Calls `maps.resolve_jurisdiction` (PostGIS `ST_Contains` on `maps.us_counties`). */
export function createSupabaseJurisdictionDb(client: RpcCapableClient): JurisdictionDb {
  return {
    async resolveCounty(point: LngLatPoint): Promise<JurisdictionResolution | null> {
      const { data, error } = await client.schema("maps").rpc("resolve_jurisdiction", {
        p_lng: point.lng,
        p_lat: point.lat,
      });
      if (error) throw new Error(`maps.resolve_jurisdiction failed: ${error.message}`);
      if (!Array.isArray(data) || data.length === 0) return null;
      const row: unknown = data[0];
      if (!isResolution(row)) throw new Error("maps.resolve_jurisdiction returned an unexpected row shape");
      return row;
    },
  };
}
