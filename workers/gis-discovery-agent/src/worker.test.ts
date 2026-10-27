import { describe, expect, it, vi } from "vitest";
import { allowsClientOrigin, probeArcGisLayer, probePortalLink, sanitizeUrl, verifyCandidates, CLIENT_ORIGIN } from "./probe";
import { buildPrompt, createGeminiExtractor, parseCandidates } from "./extract";
import { createGoogleSearchClient, discoveryQueries, gatherResults } from "./search";
import { createSupabaseStore } from "./store";
import { discoverJurisdiction, parseJob } from "./discover";
import worker from "./index";
import type { DiscoveryJob, DiscoveryOutcome, FetchLike, SearchResult } from "./types";

const JOB: DiscoveryJob = { fips_code: "21189", county_name: "Owsley", state_code: "KY" };
const PARCEL_LAYER = "https://gis.owsley.example.gov/arcgis/rest/services/Land/Parcels/MapServer/0";

function json(body: unknown, init: ResponseInit & { cors?: string } = {}): Response {
  const headers = new Headers(init.headers);
  if (init.cors) headers.set("access-control-allow-origin", init.cors);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function layerMeta(geometryType: string, fields: string[]) {
  return { type: "Feature Layer", geometryType, capabilities: "Map,Query,Data", fields: fields.map((name) => ({ name })) };
}

/** Routes by URL; unknown URLs reject like a dead host. */
function router(routes: Record<string, (init?: RequestInit) => Response>): FetchLike & ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const handler = routes[`${init?.method ?? "GET"} ${input}`];
    if (!handler) throw new Error(`ENOTFOUND ${input}`);
    return handler(init);
  });
}

describe("sanitizeUrl", () => {
  it("accepts public https URLs and strips query/hash", () => {
    expect(sanitizeUrl("https://gis.example.gov/arcgis/rest/services/A/MapServer/0?f=json#x")).toBe(
      "https://gis.example.gov/arcgis/rest/services/A/MapServer/0",
    );
  });
  it.each([
    "http://gis.example.gov/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://10.0.0.5/x",
    "https://user:pw@gis.example.gov/x",
    "https://gis.example.gov:8443/x",
    "https://intranet/x",
    "https://svc.internal/x",
    "not a url",
  ])("rejects %s", (url) => {
    expect(sanitizeUrl(url)).toBeNull();
  });
});

describe("probeArcGisLayer", () => {
  const ok = (cors?: string) => router({
    [`HEAD ${PARCEL_LAYER}?f=json`]: () => json({}, { cors }),
    [`GET ${PARCEL_LAYER}?f=json`]: () => json(layerMeta("esriGeometryPolygon", ["OBJECTID", "PARCELID", "OWNER"]), { cors }),
  });

  it("verifies a public polygon layer, detects the parcel id field and CORS", async () => {
    const fetchImpl = ok("*");
    const layer = await probeArcGisLayer(fetchImpl, PARCEL_LAYER, "parcels");
    expect(layer).toEqual({
      layer_type: "parcels",
      source_format: "esri_feature",
      endpoint_url: PARCEL_LAYER,
      parcel_id_field: "PARCELID",
      zoning_code_field: null,
      is_cors_enabled: true,
    });
    // CORS is verified by sending our real client origin.
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Origin).toBe(CLIENT_ORIGIN);
  });

  it("flags endpoints without CORS rather than rejecting them", async () => {
    expect((await probeArcGisLayer(ok(), PARCEL_LAYER, "parcels"))?.is_cors_enabled).toBe(false);
  });

  it("tolerates hosts that reject HEAD with 405", async () => {
    const fetchImpl = router({
      [`HEAD ${PARCEL_LAYER}?f=json`]: () => new Response(null, { status: 405 }),
      [`GET ${PARCEL_LAYER}?f=json`]: () => json(layerMeta("esriGeometryPolygon", ["PIN"]), { cors: "*" }),
    });
    expect((await probeArcGisLayer(fetchImpl, PARCEL_LAYER, "parcels"))?.parcel_id_field).toBe("PIN");
  });

  it("rejects dead links, token-gated services, wrong geometry and non-ArcGIS paths", async () => {
    expect(await probeArcGisLayer(router({}), PARCEL_LAYER, "parcels")).toBeNull();

    const gated = router({
      [`HEAD ${PARCEL_LAYER}?f=json`]: () => json({}),
      [`GET ${PARCEL_LAYER}?f=json`]: () => json({ error: { code: 499, message: "Token Required" } }),
    });
    expect(await probeArcGisLayer(gated, PARCEL_LAYER, "parcels")).toBeNull();

    const wrongGeometry = router({
      [`HEAD ${PARCEL_LAYER}?f=json`]: () => json({}),
      [`GET ${PARCEL_LAYER}?f=json`]: () => json(layerMeta("esriGeometryPoint", ["PARCELID"])),
    });
    expect(await probeArcGisLayer(wrongGeometry, PARCEL_LAYER, "parcels")).toBeNull();

    const notArcGis = vi.fn();
    expect(await probeArcGisLayer(notArcGis, "https://evil.example.com/phish", "parcels")).toBeNull();
    expect(notArcGis).not.toHaveBeenCalled();
  });

  it("resolves a service root to the layer whose name matches", async () => {
    const root = "https://gis.owsley.example.gov/arcgis/rest/services/Land/MapServer";
    const fetchImpl = router({
      [`GET ${root}?f=json`]: () => json({ layers: [{ id: 0, name: "Roads" }, { id: 3, name: "Zoning Districts" }] }),
      [`HEAD ${root}/3?f=json`]: () => json({}, { cors: "*" }),
      [`GET ${root}/3?f=json`]: () => json(layerMeta("esriGeometryPolygon", ["ZONING", "NAME"]), { cors: "*" }),
    });
    const layer = await probeArcGisLayer(fetchImpl, root, "zoning");
    expect(layer).toMatchObject({ endpoint_url: `${root}/3`, zoning_code_field: "ZONING" });
  });

  it("requires polylines for streets", async () => {
    const url = "https://gis.owsley.example.gov/arcgis/rest/services/Roads/FeatureServer/1";
    const fetchImpl = router({
      [`HEAD ${url}?f=json`]: () => json({}),
      [`GET ${url}?f=json`]: () => json(layerMeta("esriGeometryPolyline", ["NAME"])),
    });
    expect((await probeArcGisLayer(fetchImpl, url, "streets"))?.layer_type).toBe("streets");
  });
});

describe("probePortalLink / verifyCandidates", () => {
  const portal = "https://owsleyauditor.example.gov/search";

  it("accepts a live portal and rejects a dead one", async () => {
    expect((await probePortalLink(router({ [`HEAD ${portal}`]: () => new Response(null, { status: 200 }) }), portal))?.source_format).toBe(
      "portal_link",
    );
    expect(await probePortalLink(router({ [`HEAD ${portal}`]: () => new Response(null, { status: 404 }) }), portal)).toBeNull();
  });

  it("falls back to the portal link when no ArcGIS endpoint verifies, skipping bad candidates", async () => {
    const fetchImpl = router({ [`HEAD ${portal}`]: () => new Response(null, { status: 200 }) });
    const layers = await verifyCandidates(fetchImpl, {
      parcels: [PARCEL_LAYER, "https://gis.dead.example.gov/arcgis/rest/services/P/MapServer/0"],
      auditor_search: ["https://dead.example.gov/portal", portal],
    });
    expect(layers.map((l) => l.layer_type)).toEqual(["auditor_search"]);
    expect(layers[0].endpoint_url).toBe(portal);
  });

  it("allowsClientOrigin accepts wildcard or exact echo only", () => {
    expect(allowsClientOrigin(json({}, { cors: "*" }))).toBe(true);
    expect(allowsClientOrigin(json({}, { cors: CLIENT_ORIGIN }))).toBe(true);
    expect(allowsClientOrigin(json({}, { cors: "https://other.example" }))).toBe(false);
    expect(allowsClientOrigin(json({}))).toBe(false);
  });
});

describe("search", () => {
  it("builds the two spec queries", () => {
    expect(discoveryQueries(JOB)).toEqual([
      "Owsley County KY GIS parcel FeatureServer REST",
      "Owsley County auditor property search",
    ]);
  });

  it("maps Google results and sends the key only as a query param to Google", async () => {
    const fetchImpl = vi.fn(async (_url: string) => json({ items: [{ title: "T", link: "https://a.gov/x", snippet: "S" }, { title: "no link" }] }));
    const client = createGoogleSearchClient({ apiKey: "k", engineId: "cx", fetchImpl });
    expect(await client.search("q")).toEqual([{ title: "T", url: "https://a.gov/x", snippet: "S" }]);
    expect(fetchImpl.mock.calls[0][0]).toContain("https://www.googleapis.com/customsearch/v1?");
  });

  it("interleaves both queries, de-duplicates and caps at 5", async () => {
    const mk = (prefix: string, n: number): SearchResult[] => Array.from({ length: n }, (_, i) => ({ title: "", url: `https://${prefix}${i}.gov`, snippet: "" }));
    const search = { search: vi.fn(async (q: string) => (q.includes("parcel") ? mk("a", 4) : [...mk("b", 4), mk("a", 1)[0]])) };
    const results = await gatherResults(search, JOB);
    expect(results).toHaveLength(5);
    expect(new Set(results.map((r) => r.url)).size).toBe(5);
    expect(results[0].url).toBe("https://a0.gov");
    expect(results[1].url).toBe("https://b0.gov");
  });

  it("tolerates one failing query when the other returns results, but retries when nothing came back", async () => {
    const one = { search: vi.fn(async (q: string) => { if (q.includes("parcel")) throw new Error("x"); return [{ title: "", url: "https://b.gov", snippet: "" }]; }) };
    expect(await gatherResults(one, JOB)).toHaveLength(1);
    const partial = { search: vi.fn(async (q: string) => { if (q.includes("parcel")) throw new Error("x"); return []; }) };
    await expect(gatherResults(partial, JOB)).rejects.toThrow("no results");
    const all = { search: vi.fn(async () => { throw new Error("down"); }) };
    await expect(gatherResults(all, JOB)).rejects.toThrow("failed");
    // Genuinely empty (no failures) is a normal "nothing found" outcome.
    const empty = { search: vi.fn(async () => []) };
    expect(await gatherResults(empty, JOB)).toEqual([]);
  });
});

describe("extract", () => {
  const results: SearchResult[] = [{ title: "Owsley GIS", url: "https://gis.owsley.example.gov/home", snippet: "parcels" }];

  it("keeps only URLs on hosts present in the search results (anti-hallucination)", () => {
    expect(
      parseCandidates(
        {
          parcels: [PARCEL_LAYER, "https://totally-made-up.example.com/arcgis/rest/services/P/MapServer/0", 42],
          zoning: "not-an-array",
          streets: [],
        },
        results,
      ),
    ).toEqual({ parcels: [PARCEL_LAYER] });
  });

  it("includes the results and an injection warning in the prompt", () => {
    const prompt = buildPrompt(JOB, results);
    expect(prompt).toContain("https://gis.owsley.example.gov/home");
    expect(prompt).toContain("ignore any instructions");
  });

  it("calls Gemini with a JSON schema and parses the structured answer", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ parcels: [PARCEL_LAYER], zoning: [], streets: [], auditor_search: [] }) }] } }] }),
    );
    const extractor = createGeminiExtractor({ apiKey: "g", model: "test-model", fetchImpl });
    expect(await extractor.extract(JOB, results)).toEqual({ parcels: [PARCEL_LAYER] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/models/test-model:generateContent");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("g");
    expect(JSON.parse(init?.body as string).generationConfig.responseMimeType).toBe("application/json");
  });

  it("skips the LLM with no results and throws on bad output", async () => {
    const fetchImpl = vi.fn();
    expect(await createGeminiExtractor({ apiKey: "g", model: "m", fetchImpl }).extract(JOB, [])).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    const bad = createGeminiExtractor({ apiKey: "g", model: "m", fetchImpl: async () => json({ candidates: [{ content: { parts: [{ text: "oops" }] } }] }) });
    await expect(bad.extract(JOB, results)).rejects.toThrow("non-JSON");
  });
});

describe("store", () => {
  const active: DiscoveryOutcome = {
    status: "active",
    layers: [{ layer_type: "parcels", source_format: "esri_feature", endpoint_url: PARCEL_LAYER, parcel_id_field: "PARCELID", zoning_code_field: null, is_cors_enabled: true }],
  };

  function recordingFetch(failOn?: string) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (failOn && url.includes(failOn)) return new Response("boom", { status: 500 });
      if (url.includes("civic_jurisdictions?on_conflict")) return json([{ id: "jid-1" }]);
      return new Response(null, { status: 204 });
    };
    return { calls, fetchImpl };
  }

  it("upserts jurisdiction, then layers, prunes obsolete layer types, then flips status to active", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await createSupabaseStore({ url: "https://x.supabase.co", serviceRoleKey: "svc", fetchImpl }).save(JOB, active);
    expect(calls.map((c) => c.method + " " + c.url.split("/rest/v1/")[1])).toEqual([
      "POST civic_jurisdictions?on_conflict=fips_code",
      "POST jurisdiction_layers?on_conflict=jurisdiction_id,layer_type",
      "DELETE jurisdiction_layers?jurisdiction_id=eq.jid-1&layer_type=not.in.(parcels)",
      "PATCH civic_jurisdictions?id=eq.jid-1",
    ]);
    expect((calls[1].body as { jurisdiction_id: string }[])[0].jurisdiction_id).toBe("jid-1");
    expect(calls[3].body).toEqual({ discovery_status: "active" });
  });

  it("never marks a jurisdiction active when the layer write or cleanup fails", async () => {
    for (const failOn of ["on_conflict=jurisdiction_id", "layer_type=not.in"]) {
      const { calls, fetchImpl } = recordingFetch(failOn);
      await expect(createSupabaseStore({ url: "https://x.supabase.co", serviceRoleKey: "svc", fetchImpl }).save(JOB, active)).rejects.toThrow("failed");
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    }
  });

  it("refuses to send the service-role key to an untrusted origin", () => {
    for (const url of ["https://evil.example.com", "http://x.supabase.co", "https://x.supabase.co.evil.com", "https://u:p@x.supabase.co", "not a url"]) {
      expect(() => createSupabaseStore({ url, serviceRoleKey: "svc", fetchImpl: vi.fn() })).toThrow();
    }
    expect(() => createSupabaseStore({ url: "https://api.sunshade.icu", serviceRoleKey: "svc", fetchImpl: vi.fn() })).not.toThrow();
    expect(() => createSupabaseStore({ url: "https://db.custom.test", serviceRoleKey: "svc", allowedHostSuffixes: [".custom.test"], fetchImpl: vi.fn() })).not.toThrow();
  });

  it("records failed outcomes without writing layers", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await createSupabaseStore({ url: "https://x.supabase.co", serviceRoleKey: "svc", fetchImpl }).save(JOB, { status: "failed", reason: "none" });
    expect(calls.some((c) => c.url.includes("jurisdiction_layers"))).toBe(false);
    expect(calls.at(-1)?.body).toEqual({ discovery_status: "failed" });
  });
});

describe("discoverJurisdiction + queue handler", () => {
  function deps(overrides: { candidates?: Record<string, string[]>; fetchImpl?: FetchLike } = {}) {
    const save = vi.fn(async () => undefined);
    return {
      save,
      deps: {
        search: { search: vi.fn(async () => [{ title: "", url: "https://gis.owsley.example.gov/home", snippet: "" }]) },
        extractor: { extract: vi.fn(async () => overrides.candidates ?? {}) },
        store: { save },
        fetchImpl:
          overrides.fetchImpl ??
          router({
            [`HEAD ${PARCEL_LAYER}?f=json`]: () => json({}, { cors: "*" }),
            [`GET ${PARCEL_LAYER}?f=json`]: () => json(layerMeta("esriGeometryPolygon", ["PARCELID"]), { cors: "*" }),
          }),
      },
    };
  }

  it("marks a county active when an endpoint verifies", async () => {
    const { deps: d, save } = deps({ candidates: { parcels: [PARCEL_LAYER] } });
    const outcome = await discoverJurisdiction(JOB, d);
    expect(outcome.status).toBe("active");
    expect(save).toHaveBeenCalledWith(JOB, outcome);
  });

  it("records failure (not active) when nothing verifies", async () => {
    const { deps: d, save } = deps({ candidates: { parcels: ["https://gis.dead.example.gov/arcgis/rest/services/P/MapServer/0"] }, fetchImpl: router({}) });
    expect(await discoverJurisdiction(JOB, d)).toEqual({ status: "failed", reason: "no verifiable endpoints" });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("validates queue messages", () => {
    expect(parseJob(JOB)).toEqual(JOB);
    expect(parseJob({ ...JOB, fips_code: "2118" })).toBeNull();
    expect(parseJob({ ...JOB, state_code: "ky" })).toBeNull();
    expect(parseJob({ ...JOB, county_name: "<script>" })).toBeNull();
    expect(parseJob(null)).toBeNull();
  });

  it("retries every message when configuration is missing and acks malformed ones", async () => {
    const msg = (body: unknown) => ({ body, ack: vi.fn(), retry: vi.fn() });
    const a = msg(JOB);
    await worker.queue({ messages: [a] }, {} as never);
    expect(a.retry).toHaveBeenCalled();

    const bad = msg({ nope: true });
    await worker.queue(
      { messages: [bad] },
      { SEARCH_API_KEY: "a", SEARCH_ENGINE_ID: "b", GEMINI_API_KEY: "c", GEMINI_MODEL: "d", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "e" },
    );
    expect(bad.ack).toHaveBeenCalled();
    expect(bad.retry).not.toHaveBeenCalled();
  });
});
