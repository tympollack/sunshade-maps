import { describe, expect, it } from "vitest";
import {
  DECAY_SEVERITY,
  MAX_BBOX_SPAN_DEGREES,
  compassLabel,
  nodesToFeatureCollection,
  parseBBoxParam,
  toDecayState,
  type NodeRow,
} from "./nodes";

function row(overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    node_id: "11111111-1111-1111-1111-111111111111",
    latitude: 39.1,
    longitude: -84.51,
    status: "verified",
    decay_state: "green",
    expires_at_yellow: "2026-10-15T00:00:00Z",
    expires_at_red: "2026-10-22T00:00:00Z",
    sha256_hash: "abc123",
    verified_at: "2026-10-08T12:00:00Z",
    az_heading: "271.5",
    ...overrides,
  };
}

describe("parseBBoxParam", () => {
  it("parses a valid bbox", () => {
    expect(parseBBoxParam("-84.52,39.09,-84.50,39.11")).toEqual({ ok: true, bbox: [-84.52, 39.09, -84.5, 39.11] });
  });

  it.each([
    [null, /Missing/],
    ["", /Missing/],
    ["1,2,3", /four comma-separated/],
    ["1,2,3,", /four comma-separated/],
    ["a,2,3,4", /finite/],
    ["Infinity,0,1,1", /finite|bounds/],
    ["-181,0,1,1", /WGS84/],
    ["0,-91,1,1", /WGS84/],
    ["5,0,1,1", /west < east/],
    ["0,5,1,1", /south < north/],
    [`0,0,${MAX_BBOX_SPAN_DEGREES + 1},1`, /span/],
  ])("rejects %s", (raw, message) => {
    const result = parseBBoxParam(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});

describe("toDecayState", () => {
  it("accepts known states and collapses everything else to unknown", () => {
    expect(toDecayState("red")).toBe("red");
    expect(toDecayState("purple")).toBe("unknown");
    expect(toDecayState(null)).toBe("unknown");
  });
});

describe("nodesToFeatureCollection", () => {
  it("returns an empty, non-truncated collection for no rows (empty state, no fabricated nodes)", () => {
    expect(nodesToFeatureCollection([])).toEqual({ type: "FeatureCollection", features: [], truncated: false });
  });

  it("maps rows to point features with severity, hash and numeric azimuth", () => {
    const fc = nodesToFeatureCollection([row({ decay_state: "yellow" })]);
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    expect(f.geometry.coordinates).toEqual([-84.51, 39.1]);
    expect(f.properties).toMatchObject({
      decay_state: "yellow",
      severity: DECAY_SEVERITY.yellow,
      verification_hash: "abc123",
      az_heading: 271.5,
    });
  });

  it("never exposes user ids or image keys", () => {
    const leaky = { ...row(), user_id: "secret-user", image_key: "ports/prod/secret.jpg" } as NodeRow;
    const json = JSON.stringify(nodesToFeatureCollection([leaky]));
    expect(json).not.toContain("secret");
  });

  it("keeps missing azimuth/hash as null rather than inventing values", () => {
    const f = nodesToFeatureCollection([row({ az_heading: null, sha256_hash: null, decay_state: "unknown" })]).features[0];
    expect(f.properties.az_heading).toBeNull();
    expect(f.properties.verification_hash).toBeNull();
    expect(f.properties.severity).toBe(0);
  });

  it("skips rows without valid coordinates", () => {
    const fc = nodesToFeatureCollection([row({ latitude: Number.NaN }), row({ longitude: null as unknown as number })]);
    expect(fc.features).toHaveLength(0);
  });

  it("flags truncation when the row cap is reached", () => {
    const rows = Array.from({ length: 3 }, (_, i) => row({ node_id: `n${i}` }));
    expect(nodesToFeatureCollection(rows, 3).truncated).toBe(true);
    expect(nodesToFeatureCollection(rows, 4).truncated).toBe(false);
  });
});

describe("compassLabel", () => {
  it("labels azimuths and wraps around north", () => {
    expect(compassLabel(0)).toBe("N");
    expect(compassLabel(90)).toBe("E");
    expect(compassLabel(271.5)).toBe("W");
    expect(compassLabel(359)).toBe("N");
    expect(compassLabel(-90)).toBe("W");
  });
});
