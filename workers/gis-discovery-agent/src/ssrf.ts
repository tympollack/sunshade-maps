/**
 * SSRF guard for discovery probes. `sanitizeUrl` only inspects the spelling of a hostname; an
 * attacker-controlled public-looking name can still resolve to an internal address. Every probe
 * request therefore goes through {@link createGuardedFetch}, which resolves the host first
 * (DNS-over-HTTPS) and refuses private, loopback, link-local, CGNAT and other non-public answers.
 * Resolution failures fail closed. Redirects are never followed (see probe.ts), so each hop that
 * matters is checked explicitly by the caller.
 *
 * Residual risk: a rebinding race between this lookup and the connection. Cloudflare Workers also
 * cannot reach private address space at the platform level, so this is defence in depth.
 */
import type { FetchLike } from "./types";

/** Resolves a hostname to its A/AAAA addresses; rejects when it cannot. */
export type HostResolver = (host: string) => Promise<string[]>;

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/**
 * Expands an IPv6 literal (any valid textual form, incl. `::` and a dotted-quad tail) into its
 * eight 16-bit groups, or `null` when it is malformed.
 */
function parseIpv6(ip: string): number[] | null {
  let text = ip.replace(/^\[|\]$/g, "");
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const tail = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (tail) {
    const octets = tail.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return null;
    text = `${text.slice(0, tail.index)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string): string[] => (s === "" ? [] : s.split(":"));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

/** True for any address that is not publicly routable (v4 or v6, incl. every v4-embedded v6 form). */
export function isNonPublicAddress(address: string): boolean {
  const ip = address.trim().toLowerCase();
  if (ip.includes(":")) {
    const g = parseIpv6(ip);
    if (!g) return true; // unparseable => fail closed
    const embeddedV4 = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    const zeroPrefix = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
    if (zeroPrefix(7) && g[7] <= 1) return true; // :: and ::1
    // ::ffff:a.b.c.d (v4-mapped), ::a.b.c.d (deprecated v4-compatible), ::ffff:0:a.b.c.d (SIIT)
    if (zeroPrefix(5) && g[5] === 0xffff) return isNonPublicAddress(embeddedV4(g[6], g[7]));
    if (zeroPrefix(6)) return isNonPublicAddress(embeddedV4(g[6], g[7]));
    if (zeroPrefix(4) && g[4] === 0xffff && g[5] === 0) return isNonPublicAddress(embeddedV4(g[6], g[7]));
    // 64:ff9b::/96 NAT64 well-known prefix embeds a v4 address
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
      return isNonPublicAddress(embeddedV4(g[6], g[7]));
    }
    if (g[0] === 0x2002) return isNonPublicAddress(embeddedV4(g[1], g[2])); // 6to4
    if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo (obfuscated v4); never a GIS host
    if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return true; // 100::/64 discard
    const first = g[0];
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && parts[2] === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved
  );
}

/** DNS-over-HTTPS resolver (Cloudflare JSON API). */
export function createDohResolver(fetchImpl: FetchLike = (input, init) => fetch(input, init)): HostResolver {
  const lookup = async (host: string, type: "A" | "AAAA"): Promise<string[]> => {
    const response = await fetchImpl(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`DoH lookup failed: HTTP ${response.status}`);
    const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
    // Type 1 = A, 28 = AAAA (CNAME answers are followed by the resolver and ignored here).
    return (body.Answer ?? []).filter((a) => a.type === (type === "A" ? 1 : 28)).map((a) => a.data);
  };
  return async (host) => {
    const [v4, v6] = await Promise.all([lookup(host, "A"), lookup(host, "AAAA")]);
    return [...v4, ...v6];
  };
}

/**
 * Wraps a fetch so that every request first proves its hostname resolves only to public addresses.
 * Verdicts are cached per host for the lifetime of the wrapper (one discovery run).
 */
export function createGuardedFetch(fetchImpl: FetchLike, resolve: HostResolver = createDohResolver()): FetchLike {
  const verdicts = new Map<string, Promise<void>>();

  const assertPublic = (host: string): Promise<void> => {
    let verdict = verdicts.get(host);
    if (!verdict) {
      verdict = resolve(host).then((addresses) => {
        if (addresses.length === 0) throw new Error(`blocked: ${host} did not resolve`);
        if (addresses.some(isNonPublicAddress)) throw new Error(`blocked: ${host} resolves to a non-public address`);
      });
      verdicts.set(host, verdict);
    }
    return verdict;
  };

  return async (input, init) => {
    await assertPublic(new URL(input).hostname.toLowerCase());
    return fetchImpl(input, init);
  };
}
