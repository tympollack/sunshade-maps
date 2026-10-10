import { describe, expect, it } from "vitest";
import { isSunShadeHost, ssoCookieDomain, ssoCookieOptions } from "./cookies";

describe("SSO cookie scoping", () => {
  it.each([
    ["maps.sunshade.icu", true],
    ["maps-stag.sunshade.icu", true],
    ["hub.sunshade.icu:443", true],
    ["sunshade.icu", true],
    ["MAPS.SUNSHADE.ICU", true],
    ["localhost:3000", false],
    ["127.0.0.1", false],
    ["evil-sunshade.icu", false],
    ["sunshade.icu.attacker.com", false],
    ["maps-web-git-feat.vercel.app", false],
  ])("isSunShadeHost(%s) === %s", (host, expected) => {
    expect(isSunShadeHost(host)).toBe(expected);
  });

  it("returns undefined for empty hosts", () => {
    expect(isSunShadeHost(null)).toBe(false);
    expect(ssoCookieDomain(undefined)).toBeUndefined();
  });

  it("scopes cookies to .sunshade.icu on SunShade hosts", () => {
    expect(ssoCookieOptions("maps.sunshade.icu", true)).toEqual({
      path: "/",
      sameSite: "lax",
      secure: true,
      domain: ".sunshade.icu",
    });
  });

  it("omits the domain attribute on localhost", () => {
    const opts = ssoCookieOptions("localhost:3000", false);
    expect(opts).not.toHaveProperty("domain");
    expect(opts.secure).toBe(false);
  });
});
