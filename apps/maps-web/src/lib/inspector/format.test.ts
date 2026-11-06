import { describe, expect, it } from "vitest";
import { NOT_RECORDED, formatAcres, formatBoolean, formatIsoDate, formatSigned, formatUsd } from "./format";

describe("inspector formatters", () => {
  it("renders null as Not recorded", () => {
    expect(formatUsd(null)).toBe(NOT_RECORDED);
    expect(formatBoolean(null)).toBe(NOT_RECORDED);
    expect(formatIsoDate(null)).toBe(NOT_RECORDED);
    expect(formatAcres(null)).toBe(NOT_RECORDED);
  });
  it("keeps a genuine $0 value", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(1234567)).toBe("$1,234,567");
  });
  it("treats 0 acres as unrecorded", () => {
    expect(formatAcres(0)).toBe(NOT_RECORDED);
    expect(formatAcres(0.25)).toBe("0.250 ac");
    expect(formatAcres(12.345)).toBe("12.35 ac");
  });
  it("formats dates and booleans", () => {
    expect(formatIsoDate("2019-05-17")).toBe("5/17/2019");
    expect(formatIsoDate("garbage")).toBe(NOT_RECORDED);
    expect(formatBoolean(true)).toBe("Yes");
    expect(formatBoolean(false)).toBe("No");
  });
  it("signs positive scores", () => {
    expect(formatSigned(1.25)).toBe("+1.25");
    expect(formatSigned(-0.5)).toBe("-0.50");
    expect(formatSigned(0)).toBe("0.00");
  });
});
