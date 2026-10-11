import { describe, expect, it } from "vitest";
import { latLngToCell } from "h3-js";
import {
  K_MIN_RESPONDENTS,
  MAX_CELLS_PER_REQUEST,
  VALERIE_H3_RESOLUTION,
  confidenceHeight,
  sentimentColor,
  sentimentRowsToFeatureCollection,
  viewportCells,
  type SentimentRow,
} from "./sentiment";

const CELL = latLngToCell(39.1031, -84.512, VALERIE_H3_RESOLUTION);

function row(overrides: Partial<SentimentRow> = {}): SentimentRow {
  return { h3_hex_index: CELL, respondent_count: 12, avg_likert: 1.25, avg_confidence: "80.0", ...overrides };
}

describe("sentimentColor", () => {
  it("hits the crimson / amber / emerald stops exactly", () => {
    expect(sentimentColor(-2)).toBe("#DC143C");
    expect(sentimentColor(0)).toBe("#FFBF00");
    expect(sentimentColor(2)).toBe("#50C878");
  });

  it("interpolates between stops and clamps out-of-range scores", () => {
    expect(sentimentColor(-1)).toBe("#EE6A1E");
    expect(sentimentColor(-99)).toBe("#DC143C");
    expect(sentimentColor(99)).toBe("#50C878");
  });
});

describe("confidenceHeight", () => {
  it("scales 0–100% to 0–800 m and clamps", () => {
    expect(confidenceHeight(0)).toBe(0);
    expect(confidenceHeight(50)).toBe(400);
    expect(confidenceHeight(100)).toBe(800);
    expect(confidenceHeight(250)).toBe(800);
    expect(confidenceHeight(-5)).toBe(0);
  });
});

describe("sentimentRowsToFeatureCollection (K-anonymity)", () => {
  it("returns an empty collection for no rows (empty state, nothing fabricated)", () => {
    expect(sentimentRowsToFeatureCollection([])).toEqual({ type: "FeatureCollection", features: [] });
  });

  it("renders a closed hexagon with only h3 / likert / confidence properties", () => {
    const fc = sentimentRowsToFeatureCollection([row()]);
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    const ring = f.geometry.coordinates[0];
    expect(ring).toHaveLength(7); // 6 vertices, closed
    expect(ring[0]).toEqual(ring[6]);
    expect(Object.keys(f.properties).sort()).toEqual(["avg_confidence", "avg_likert", "h3"]);
    expect(f.properties).toMatchObject({ h3: CELL, avg_likert: 1.25, avg_confidence: 80 });
  });

  it(`suppresses cells with fewer than ${K_MIN_RESPONDENTS} respondents entirely`, () => {
    const fc = sentimentRowsToFeatureCollection([
      row({ respondent_count: 9 }),
      row({ respondent_count: 0 }),
      row({ respondent_count: K_MIN_RESPONDENTS }),
    ]);
    expect(fc.features).toHaveLength(1);
  });

  it("never leaks respondent counts, user ids or GPS", () => {
    const leaky = { ...row(), user_id: "secret-user", lat: 39.1, lng: -84.5 } as SentimentRow;
    const json = JSON.stringify(sentimentRowsToFeatureCollection([leaky]));
    expect(json).not.toContain("secret-user");
    expect(json).not.toContain("respondent_count");
    expect(json).not.toContain('"lat"');
  });

  it("drops invalid H3 ids and non-numeric aggregates instead of defaulting them", () => {
    const fc = sentimentRowsToFeatureCollection([
      row({ h3_hex_index: "not-an-h3-cell" }),
      row({ avg_likert: "NaN" }),
      row({ avg_confidence: Number.NaN }),
    ]);
    expect(fc.features).toHaveLength(0);
  });

  it("clamps aggregates into their valid ranges", () => {
    const f = sentimentRowsToFeatureCollection([row({ avg_likert: 7, avg_confidence: 400 })]).features[0];
    expect(f.properties.avg_likert).toBe(2);
    expect(f.properties.avg_confidence).toBe(100);
  });
});

describe("viewportCells", () => {
  it("covers a metro-scale viewport with resolution-7 cells", () => {
    const result = viewportCells([-84.7, 38.9, -84.3, 39.3]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cells.length).toBeGreaterThan(50);
      expect(result.cells).toContain(CELL);
    }
  });

  it("refuses viewports that would exceed the cell cap", () => {
    const result = viewportCells([-90, 35, -80, 45]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(MAX_CELLS_PER_REQUEST));
  });
});
