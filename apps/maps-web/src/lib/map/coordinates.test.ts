import { describe, expect, it } from "vitest";
import { formatCoordinate, wrapLng } from "./coordinates";

describe("formatCoordinate", () => {
  it("formats Cincinnati with hemisphere suffixes", () => {
    expect(formatCoordinate({ lng: -84.512, lat: 39.1031 })).toBe("39.103100° N  84.512000° W");
  });

  it("handles southern / eastern hemispheres and precision", () => {
    expect(formatCoordinate({ lng: 151.2093, lat: -33.8688 }, 2)).toBe("33.87° S  151.21° E");
  });
});

describe("wrapLng", () => {
  it.each([
    [0, 0],
    [-84.5, -84.5],
    [275.5, -84.5],
    [-444.5, -84.5],
    [180, -180],
  ])("wrapLng(%s) === %s", (input, expected) => {
    expect(wrapLng(input)).toBeCloseTo(expected, 9);
  });
});
