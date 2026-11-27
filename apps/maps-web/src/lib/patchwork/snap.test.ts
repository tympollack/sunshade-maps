import { describe, expect, it } from "vitest";
import { resolveParcelSnap, snapPointToParcel } from "./snap";

const parcel: GeoJSON.Feature<GeoJSON.Polygon> = {
  type: "Feature",
  properties: {},
  geometry: {
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
  },
};

describe("snapPointToParcel", () => {
  it("leaves a pin inside the parcel untouched", () => {
    const pin = { lng: -84.515, lat: 39.105 };
    expect(snapPointToParcel(pin, parcel)).toEqual({ point: pin, snapped: false, distanceMeters: 0 });
  });

  it("snaps an outside pin to the nearest boundary point", () => {
    const result = snapPointToParcel({ lng: -84.505, lat: 39.105 }, parcel);
    expect(result?.snapped).toBe(true);
    expect(result?.point.lng).toBeCloseTo(-84.51, 5);
    expect(result?.point.lat).toBeCloseTo(39.105, 4);
    expect(result?.distanceMeters).toBeGreaterThan(400);
    expect(result?.distanceMeters).toBeLessThan(500);
  });

  it("returns null for non-polygon features", () => {
    const line: GeoJSON.Feature = { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } };
    expect(snapPointToParcel({ lng: 0, lat: 0 }, line)).toBeNull();
  });
});

describe("resolveParcelSnap", () => {
  const neighbour: GeoJSON.Feature<GeoJSON.Polygon> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[[-84.51, 39.1], [-84.5, 39.1], [-84.5, 39.11], [-84.51, 39.11], [-84.51, 39.1]]],
    },
  };

  it("snaps a drifted pin to the single parcel within tolerance", () => {
    // ~8 m west of the parcel's west edge, nothing else nearby.
    const out = resolveParcelSnap({ lng: -84.52009, lat: 39.105 }, [parcel]);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.result.snapped).toBe(true);
  });

  it("reports ambiguity when two parcels are within tolerance", () => {
    expect(resolveParcelSnap({ lng: -84.5100001, lat: 39.105 }, [parcel, neighbour])).toEqual({
      kind: "ambiguous",
      candidates: 2,
    });
  });

  it("returns none when no parcel is within tolerance", () => {
    expect(resolveParcelSnap({ lng: -84.4, lat: 39.105 }, [parcel]).kind).toBe("none");
    expect(resolveParcelSnap({ lng: -84.4, lat: 39.105 }, []).kind).toBe("none");
  });
});
