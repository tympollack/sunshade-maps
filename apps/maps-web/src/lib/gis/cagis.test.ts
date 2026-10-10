import { describe, expect, it, vi } from "vitest";
import {
  CAGIS_LAYERS,
  CagisQueryError,
  bboxContains,
  buildPointQueryUrl,
  buildViewportQueryUrl,
  degreesPerPixel,
  fetchLayerFeatures,
  formatParcelAddress,
  padBBox,
  queryZoningAtPoint,
  type BBox,
} from "./cagis";

const BBOX: BBox = [-84.52, 39.096, -84.505, 39.106];

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function collection(n: number, exceeded = false) {
  return {
    type: "FeatureCollection",
    exceededTransferLimit: exceeded || undefined,
    features: Array.from({ length: n }, (_, i) => ({
      type: "Feature",
      properties: { PARCELID: `P${i}` },
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    })),
  };
}

describe("bbox helpers", () => {
  it("pads proportionally and clamps latitude", () => {
    const padded = padBBox([0, 89, 10, 90], 0.5);
    expect(padded[0]).toBe(-5);
    expect(padded[2]).toBe(15);
    expect(padded[3]).toBe(90);
    expect(padded[1]).toBeCloseTo(88.5);
  });

  it("detects containment", () => {
    expect(bboxContains([0, 0, 10, 10], [1, 1, 9, 9])).toBe(true);
    expect(bboxContains([0, 0, 10, 10], [-1, 1, 9, 9])).toBe(false);
  });

  it("halves degrees-per-pixel per zoom level", () => {
    expect(degreesPerPixel(11) / degreesPerPixel(12)).toBeCloseTo(2);
  });
});

describe("query builders", () => {
  it("builds a geojson viewport query against the verified parcel layer", () => {
    const url = new URL(buildViewportQueryUrl(CAGIS_LAYERS.parcels, BBOX, { zoom: 17, offset: 1000 }));
    expect(url.origin + url.pathname).toBe(
      "https://cagisonline.hamilton-co.org/arcgis/rest/services/COUNTYWIDE/Cadastral/MapServer/0/query",
    );
    expect(url.searchParams.get("f")).toBe("geojson");
    expect(url.searchParams.get("geometry")).toBe(BBOX.join(","));
    expect(url.searchParams.get("geometryType")).toBe("esriGeometryEnvelope");
    expect(url.searchParams.get("outFields")).toBe("PARCELID,ADDRNO,ADDRST,ADDRSF");
    expect(url.searchParams.get("resultOffset")).toBe("1000");
    expect(url.searchParams.get("inSR")).toBe("4326");
    expect(url.searchParams.get("outSR")).toBe("4326");
  });

  it("builds a geometry-less point query for zoning", () => {
    const url = new URL(buildPointQueryUrl(CAGIS_LAYERS.zoning, { lng: -84.5121, lat: 39.1031 }));
    expect(url.searchParams.get("geometryType")).toBe("esriGeometryPoint");
    expect(url.searchParams.get("geometry")).toBe("-84.5121,39.1031");
    expect(url.searchParams.get("returnGeometry")).toBe("false");
  });
});

describe("fetchLayerFeatures", () => {
  it("returns features from a single page", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(collection(3)));
    const result = await fetchLayerFeatures("streets", BBOX, 16, { fetchImpl });
    expect(result.collection.features).toHaveLength(3);
    expect(result.truncated).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows pagination until the server stops reporting exceededTransferLimit", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(collection(2, true)))
      .mockResolvedValueOnce(jsonResponse(collection(1)));
    const result = await fetchLayerFeatures("parcels", BBOX, 17, { fetchImpl });
    expect(result.collection.features).toHaveLength(3);
    expect(result.truncated).toBe(false);
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get("resultOffset")).toBe("1000");
  });

  it("caps paging at maxPages and flags truncation", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(collection(1, true)));
    const result = await fetchLayerFeatures("parcels", BBOX, 17, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(CAGIS_LAYERS.parcels.maxPages);
    expect(result.truncated).toBe(true);
  });

  it("rejects on ArcGIS error envelopes instead of returning empty data", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 400, message: "Invalid query" } }));
    await expect(fetchLayerFeatures("zoning", BBOX, 14, { fetchImpl })).rejects.toThrow(/Invalid query/);
  });

  it("rejects on HTTP failures and malformed payloads", async () => {
    await expect(
      fetchLayerFeatures("zoning", BBOX, 14, { fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, { status: 503 })) }),
    ).rejects.toBeInstanceOf(CagisQueryError);
    await expect(
      fetchLayerFeatures("zoning", BBOX, 14, { fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ hello: 1 })) }),
    ).rejects.toThrow(/unexpected GeoJSON/);
  });

  it("propagates AbortError untouched", async () => {
    const abort = new DOMException("aborted", "AbortError");
    await expect(
      fetchLayerFeatures("zoning", BBOX, 14, { fetchImpl: vi.fn().mockRejectedValue(abort) }),
    ).rejects.toBe(abort);
  });
});

describe("queryZoningAtPoint", () => {
  it("maps attributes to a zoning designation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        features: [{ attributes: { ZONING: "DD", ZONE_DESCRIPTION: "Downtown Development District", JURISDICTION: "CINCINNATI" } }],
      }),
    );
    await expect(queryZoningAtPoint({ lng: -84.5121, lat: 39.1031 }, { fetchImpl })).resolves.toEqual({
      code: "DD",
      description: "Downtown Development District",
      jurisdiction: "CINCINNATI",
    });
  });

  it("returns null when no zone covers the point (empty state, not a fabricated zone)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ features: [] }));
    await expect(queryZoningAtPoint({ lng: 0, lat: 0 }, { fetchImpl })).resolves.toBeNull();
  });

  it("normalises blank attributes to null", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ features: [{ attributes: { ZONING: "MG-T", ZONE_DESCRIPTION: " ", JURISDICTION: null } }] }),
    );
    await expect(queryZoningAtPoint({ lng: 1, lat: 1 }, { fetchImpl })).resolves.toEqual({
      code: "MG-T",
      description: null,
      jurisdiction: null,
    });
  });
});

describe("formatParcelAddress", () => {
  it("joins available address parts and returns null when none exist", () => {
    expect(formatParcelAddress({ ADDRNO: "100", ADDRST: "MAIN", ADDRSF: "ST" })).toBe("100 MAIN ST");
    expect(formatParcelAddress({ ADDRNO: null, ADDRST: null, ADDRSF: null })).toBeNull();
    expect(formatParcelAddress(undefined)).toBeNull();
  });
});
