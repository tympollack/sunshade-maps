import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_PAD_DEGREES,
  SignInRequiredError,
  auditBBox,
  buildFloodQueryUrl,
  buildParcelDetailsUrl,
  fetchFloodZone,
  fetchNearbyAudits,
  fetchParcelDetails,
  fetchSentimentAt,
  geometryBounds,
  parseFloodZone,
  parseParcelDetails,
  sentimentCellAt,
} from "./report";

const polygon: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [-84.52, 39.1],
      [-84.51, 39.1],
      [-84.51, 39.11],
      [-84.52, 39.11],
      [-84.52, 39.1],
    ],
  ],
};

function parcelFeature(props: Record<string, unknown>): GeoJSON.Feature {
  return { type: "Feature", geometry: polygon, properties: props };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("geometryBounds", () => {
  it("returns polygon bounds", () => {
    expect(geometryBounds(polygon)).toEqual([-84.52, 39.1, -84.51, 39.11]);
  });
  it("handles multipolygons", () => {
    const multi: GeoJSON.MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [polygon.coordinates, [[[-84.4, 39.2], [-84.3, 39.2], [-84.3, 39.3], [-84.4, 39.2]]]],
    };
    expect(geometryBounds(multi)).toEqual([-84.52, 39.1, -84.3, 39.3]);
  });
  it("is null for missing or non-polygon geometry", () => {
    expect(geometryBounds(null)).toBeNull();
    expect(geometryBounds({ type: "Point", coordinates: [0, 0] })).toBeNull();
  });
});

describe("parseParcelDetails", () => {
  it("maps populated attributes", () => {
    const details = parseParcelDetails(
      parcelFeature({
        PARCELID: "007700020163",
        ADDRNO: "100",
        ADDRST: "MAIN",
        ADDRSF: "ST",
        OWNNM1: "ACME LLC",
        OWNNM2: " ",
        OWNAD1: "1 PO BOX",
        OWNADCITY: "LEXINGTON",
        OWNADSTATE: "KY",
        OWNADZIP: "40511",
        CLASS: 411,
        ACREDEED: 0.25,
        MKT_TOTAL_VAL: 250000,
        ANNUAL_TAXES: 0,
        SALDAT: Date.UTC(2019, 4, 17),
        SALAMT: 100000,
        HMSD_FLAG: "Y",
        FORECL_FLAG: "N",
      }),
    );
    expect(details).toMatchObject({
      parcelId: "007700020163",
      address: "100 MAIN ST",
      owners: ["ACME LLC"],
      ownerMailingAddress: "1 PO BOX, LEXINGTON, KY 40511",
      landUseClass: 411,
      acres: 0.25,
      marketTotalValue: 250000,
      annualTaxes: 0,
      lastSaleDate: "2019-05-17",
      lastSaleAmount: 100000,
      homestead: true,
      foreclosure: false,
      bounds: [-84.52, 39.1, -84.51, 39.11],
    });
  });

  it("keeps unrecorded values null (never defaulted)", () => {
    const details = parseParcelDetails(parcelFeature({ PARCELID: "X1", OWNNM1: null, MKT_TOTAL_VAL: null, SALDAT: null, HMSD_FLAG: null }));
    expect(details).toMatchObject({
      address: null,
      owners: [],
      ownerMailingAddress: null,
      marketTotalValue: null,
      annualTaxes: null,
      lastSaleDate: null,
      homestead: null,
    });
  });

  it("returns null without a PARCELID", () => {
    expect(parseParcelDetails(parcelFeature({ OWNNM1: "A" }))).toBeNull();
  });
});

describe("buildParcelDetailsUrl", () => {
  it("quotes the parcel id in the where clause", () => {
    const url = new URL(buildParcelDetailsUrl("007700020163"));
    expect(url.searchParams.get("where")).toBe("PARCELID='007700020163'");
    expect(url.searchParams.get("f")).toBe("geojson");
  });
  it("rejects ids that could alter the query", () => {
    expect(() => buildParcelDetailsUrl("1' OR '1'='1")).toThrow();
    expect(() => buildParcelDetailsUrl("")).toThrow();
  });
});

describe("fetchParcelDetails", () => {
  it("returns parsed details", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ type: "FeatureCollection", features: [parcelFeature({ PARCELID: "A1", OWNNM1: "ME" })] }));
    expect((await fetchParcelDetails("A1", { fetchImpl }))?.owners).toEqual(["ME"]);
  });
  it("returns null when CAGIS has no such parcel", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ type: "FeatureCollection", features: [] }));
    expect(await fetchParcelDetails("A1", { fetchImpl })).toBeNull();
  });
});

describe("flood zone", () => {
  it("builds a point query against NFHL layer 28", () => {
    const url = new URL(buildFloodQueryUrl({ lng: -84.5, lat: 39.1 }));
    expect(url.pathname).toContain("/NFHL/MapServer/28/query");
    expect(url.searchParams.get("geometry")).toBe("-84.5,39.1");
  });

  it("parses a mapped zone and drops the -9999 BFE sentinel", () => {
    expect(
      parseFloodZone({ features: [{ attributes: { FLD_ZONE: "X", ZONE_SUBTY: "AREA OF MINIMAL FLOOD HAZARD", SFHA_TF: "F", STATIC_BFE: -9999 } }] }),
    ).toEqual({ zone: "X", subtype: "AREA OF MINIMAL FLOOD HAZARD", specialFloodHazardArea: false, baseFloodElevation: null });
  });

  it("keeps a real BFE and flags the SFHA", () => {
    expect(parseFloodZone({ features: [{ attributes: { FLD_ZONE: "AE", SFHA_TF: "T", STATIC_BFE: 512.5 } }] })).toMatchObject({
      zone: "AE",
      specialFloodHazardArea: true,
      baseFloodElevation: 512.5,
    });
  });

  it("is null for unmapped areas and throws on malformed payloads", () => {
    expect(parseFloodZone({ features: [] })).toBeNull();
    expect(() => parseFloodZone({})).toThrow();
  });

  it("surfaces HTTP and ArcGIS error envelopes", async () => {
    await expect(fetchFloodZone({ lng: 0, lat: 0 }, { fetchImpl: async () => jsonResponse({}, 503) })).rejects.toThrow("503");
    await expect(
      fetchFloodZone({ lng: 0, lat: 0 }, { fetchImpl: async () => jsonResponse({ error: { code: 400 } }) }),
    ).rejects.toThrow("query error");
  });
});

describe("PatchWork audits", () => {
  it("pads the parcel bounds", () => {
    const [w, s, e, n] = auditBBox([-84.52, 39.1, -84.51, 39.11]);
    expect(w).toBeCloseTo(-84.52 - AUDIT_PAD_DEGREES);
    expect(n).toBeCloseTo(39.11 + AUDIT_PAD_DEGREES);
    expect(s).toBeLessThan(39.1);
    expect(e).toBeGreaterThan(-84.51);
  });

  it("maps API features to selections and normalises unknown decay states", async () => {
    const body = {
      type: "FeatureCollection",
      truncated: true,
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-84.515, 39.105] },
          properties: {
            node_id: "n1",
            decay_state: "bogus",
            severity: 0,
            expires_at_yellow: null,
            expires_at_red: null,
            verification_hash: "abc",
            verified_at: null,
            az_heading: 90,
          },
        },
      ],
    };
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>(async () => jsonResponse(body));
    const result = await fetchNearbyAudits([-84.52, 39.1, -84.51, 39.11], { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^\/api\/v1\/spatial\/nodes\?bbox=/);
    expect(result.truncated).toBe(true);
    expect(result.nodes[0]).toMatchObject({ node_id: "n1", decay_state: "unknown", lng: -84.515, lat: 39.105, az_heading: 90 });
  });

  it("returns an empty list when no nodes exist", async () => {
    const fetchImpl = async () => jsonResponse({ type: "FeatureCollection", features: [], truncated: false });
    expect(await fetchNearbyAudits([0, 0, 1, 1], { fetchImpl })).toEqual({ nodes: [], truncated: false });
  });
});

describe("Valerie sentiment", () => {
  const point = { lng: -84.512, lat: 39.1031 };

  it("requests the single resolution-7 cell under the point", async () => {
    const cell = sentimentCellAt(point);
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>(async () =>
      jsonResponse({ type: "FeatureCollection", features: [{ type: "Feature", geometry: polygon, properties: { h3: cell, avg_likert: 1.25, avg_confidence: 70 } }] }),
    );
    const result = await fetchSentimentAt(point, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(`/api/spatial/valerie?h3=${cell}`);
    expect(result).toEqual({ h3: cell, avg_likert: 1.25, avg_confidence: 70 });
  });

  it("is null when the cell was suppressed by the K-anonymity gate", async () => {
    const fetchImpl = async () => jsonResponse({ type: "FeatureCollection", features: [] });
    expect(await fetchSentimentAt(point, { fetchImpl })).toBeNull();
  });

  it("rejects with SignInRequiredError on 401", async () => {
    await expect(fetchSentimentAt(point, { fetchImpl: async () => jsonResponse({ error: "no" }, 401) })).rejects.toBeInstanceOf(
      SignInRequiredError,
    );
  });
});
