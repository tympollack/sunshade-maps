import { describe, expect, it, vi } from "vitest";
import { createDohResolver, createGuardedFetch, isNonPublicAddress } from "./ssrf";

describe("isNonPublicAddress", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.5",
    "garbage", "1.2.3",
  ])("treats %s as non-public", (ip) => {
    expect(isNonPublicAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "treats %s as public",
    (ip) => {
      expect(isNonPublicAddress(ip)).toBe(false);
    },
  );
});

describe("createGuardedFetch", () => {
  const ok = () => new Response("{}", { status: 200 });

  it("fetches hosts that resolve only to public addresses and caches the verdict", async () => {
    const inner = vi.fn(async (_url: string, _init?: RequestInit) => ok());
    const resolve = vi.fn(async () => ["93.184.216.34"]);
    const guarded = createGuardedFetch(inner, resolve);
    await guarded("https://gis.example.gov/a");
    await guarded("https://gis.example.gov/b");
    expect(inner).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("blocks a public-looking name that resolves to an internal address", async () => {
    const inner = vi.fn(async () => ok());
    const guarded = createGuardedFetch(inner, async () => ["93.184.216.34", "169.254.169.254"]);
    await expect(guarded("https://innocent.example.com/x")).rejects.toThrow("non-public");
    expect(inner).not.toHaveBeenCalled();
  });

  it("fails closed when resolution errors or returns nothing", async () => {
    const inner = vi.fn(async () => ok());
    await expect(createGuardedFetch(inner, async () => { throw new Error("dns down"); })("https://a.example.com")).rejects.toThrow("dns down");
    await expect(createGuardedFetch(inner, async () => [])("https://b.example.com")).rejects.toThrow("did not resolve");
    expect(inner).not.toHaveBeenCalled();
  });
});

describe("createDohResolver", () => {
  it("returns A and AAAA answers and ignores CNAME records", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      new Response(
        JSON.stringify({
          Answer: url.includes("type=AAAA")
            ? [{ type: 28, data: "2606:4700::1" }]
            : [{ type: 5, data: "alias.example.com." }, { type: 1, data: "93.184.216.34" }],
        }),
        { status: 200 },
      ),
    );
    expect((await createDohResolver(fetchImpl)("gis.example.gov")).sort()).toEqual(["2606:4700::1", "93.184.216.34"]);
  });

  it("rejects on a failed lookup", async () => {
    await expect(createDohResolver(async () => new Response("no", { status: 500 }))("x.example.com")).rejects.toThrow("500");
  });
});
