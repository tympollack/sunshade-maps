import { describe, expect, it } from "vitest";
import { compareHash, isValidSha256, sha256Hex } from "./verify";

const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("sha256Hex", () => {
  it("hashes bytes to lowercase hex", async () => {
    expect(await sha256Hex(new Uint8Array([]))).toBe(EMPTY_SHA);
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("isValidSha256", () => {
  it("accepts 64 hex chars in any case", () => {
    expect(isValidSha256(EMPTY_SHA)).toBe(true);
    expect(isValidSha256(EMPTY_SHA.toUpperCase())).toBe(true);
  });
  it("rejects other values", () => {
    expect(isValidSha256("abc123")).toBe(false);
    expect(isValidSha256(null)).toBe(false);
    expect(isValidSha256("g".repeat(64))).toBe(false);
  });
});

describe("compareHash", () => {
  it("reports match, mismatch, and unusable records", () => {
    expect(compareHash(EMPTY_SHA.toUpperCase(), EMPTY_SHA).status).toBe("match");
    expect(compareHash("a".repeat(64), EMPTY_SHA).status).toBe("mismatch");
    expect(compareHash(null, EMPTY_SHA).status).toBe("no-record");
    expect(compareHash("abc123", EMPTY_SHA).status).toBe("malformed-record");
  });
});
