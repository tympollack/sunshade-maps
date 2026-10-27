import type { DiscoveryJob, DiscoveryOutcome, DiscoveryStore, FetchLike } from "./types";

const FIPS_RE = /^\d{5}$/;

/** Supabase PostgREST store (service role; `maps` schema via Content-Profile). */
export function createSupabaseStore(config: { url: string; serviceRoleKey: string; fetchImpl?: FetchLike }): DiscoveryStore {
  const doFetch: FetchLike = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const base = `${config.url.replace(/\/$/, "")}/rest/v1`;
  const headers = (extra: Record<string, string> = {}) => ({
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    "Content-Type": "application/json",
    "Content-Profile": "maps",
    "Accept-Profile": "maps",
    ...extra,
  });

  async function ok(response: Response, what: string): Promise<Response> {
    if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response;
  }

  return {
    async save(job: DiscoveryJob, outcome: DiscoveryOutcome) {
      if (!FIPS_RE.test(job.fips_code)) throw new Error("Invalid fips_code");
      const status = outcome.status === "active" ? "active" : "failed";

      // 1. Jurisdiction (created pending so the public RLS policy hides it until layers exist).
      const upsertJurisdiction = await ok(
        await doFetch(`${base}/civic_jurisdictions?on_conflict=fips_code`, {
          method: "POST",
          headers: headers({ Prefer: "resolution=merge-duplicates,return=representation" }),
          body: JSON.stringify([
            { fips_code: job.fips_code, name: job.county_name, state_code: job.state_code, jurisdiction_level: "county" },
          ]),
        }),
        "jurisdiction upsert",
      );
      const rows = (await upsertJurisdiction.json()) as { id?: string }[];
      const jurisdictionId = rows[0]?.id;
      if (!jurisdictionId) throw new Error("jurisdiction upsert returned no id");

      // 2. Layers first, THEN flip status, so an 'active' jurisdiction never has missing layers.
      if (outcome.status === "active") {
        const now = new Date().toISOString();
        await ok(
          await doFetch(`${base}/jurisdiction_layers?on_conflict=jurisdiction_id,layer_type`, {
            method: "POST",
            headers: headers({ Prefer: "resolution=merge-duplicates" }),
            body: JSON.stringify(outcome.layers.map((l) => ({ ...l, jurisdiction_id: jurisdictionId, last_verified: now }))),
          }),
          "layer upsert",
        );
      }

      // 3. Status flip only after the layer write succeeded (errors above throw before this point).
      await ok(
        await doFetch(`${base}/civic_jurisdictions?id=eq.${encodeURIComponent(jurisdictionId)}`, {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ discovery_status: status }),
        }),
        "status update",
      );
    },
  };
}
