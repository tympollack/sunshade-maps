import { describe, expect, it } from "vitest";
import { DEFAULT_HANDOFF_ZOOM, buildFieldVerifyUrl, parseCommandCenterParams } from "./deeplink";

const ID = "11111111-1111-1111-1111-111111111111";

describe("parseCommandCenterParams", () => {
  it("parses a full link", () => {
    expect(parseCommandCenterParams(`?node=${ID.toUpperCase()}&lat=39.1&lng=-84.5&z=15`)).toEqual({
      center: { lng: -84.5, lat: 39.1 },
      zoom: 15,
      nodeId: ID,
    });
  });
  it("defaults zoom and drops invalid node ids", () => {
    const t = parseCommandCenterParams("lat=39.1&lng=-84.5&node=nope");
    expect(t?.zoom).toBe(DEFAULT_HANDOFF_ZOOM);
    expect(t?.nodeId).toBeNull();
  });
  it("clamps zoom and wraps longitude", () => {
    const t = parseCommandCenterParams("lat=10&lng=190&z=99");
    expect(t?.zoom).toBe(20);
    expect(t?.center.lng).toBe(-170);
  });
  it("rejects missing or invalid coordinates", () => {
    expect(parseCommandCenterParams("")).toBeNull();
    expect(parseCommandCenterParams("lat=91&lng=0")).toBeNull();
    expect(parseCommandCenterParams("lat=abc&lng=0")).toBeNull();
  });
});

describe("buildFieldVerifyUrl", () => {
  it("builds a URL under the PatchWork origin", () => {
    const url = buildFieldVerifyUrl("https://patchwork.sunshade.icu/", ID, { lng: -84.5, lat: 39.1 });
    expect(url).toBe(`https://patchwork.sunshade.icu/verify?node=${ID}&lat=39.100000&lng=-84.500000&source=maps`);
  });
  it("returns null when unconfigured or unsafe", () => {
    expect(buildFieldVerifyUrl(undefined, ID, { lng: 0, lat: 0 })).toBeNull();
    expect(buildFieldVerifyUrl("not a url", ID, { lng: 0, lat: 0 })).toBeNull();
    expect(buildFieldVerifyUrl("javascript:alert(1)", ID, { lng: 0, lat: 0 })).toBeNull();
  });
});
