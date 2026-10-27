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

/** True for any address that is not publicly routable (v4 or v6, incl. v4-mapped v6). */
export function isNonPublicAddress(address: string): boolean {
  const ip = address.trim().toLowerCase();
  if (ip.includes(":")) {
    if (ip === "::" || ip === "::1") return true;
    const mapped = ip.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isNonPublicAddress(mapped[1]);
    const first = Number.parseInt(ip.split(":")[0] || "0", 16);
    if (Number.isNaN(first)) return true;
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
