/**
 * Shared SunShade SSO cookie configuration.
 *
 * Mirrors `@digitalcanopy/supabase` (sunshade-packages): when served from any
 * `*.sunshade.icu` host, Supabase auth cookies are scoped to `.sunshade.icu`
 * so a session established on hub.sunshade.icu is visible to maps.sunshade.icu.
 * On localhost / preview hosts the domain attribute is omitted (browsers reject
 * cookies whose domain doesn't match the current host).
 */
export const SSO_COOKIE_DOMAIN = ".sunshade.icu";

export function isSunShadeHost(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  // Strip an optional :port suffix (Host headers include it).
  const host = hostname.toLowerCase().replace(/:\d+$/, "");
  return host === "sunshade.icu" || host.endsWith(SSO_COOKIE_DOMAIN);
}

export function ssoCookieDomain(hostname: string | null | undefined): string | undefined {
  return isSunShadeHost(hostname) ? SSO_COOKIE_DOMAIN : undefined;
}

export interface SsoCookieOptions {
  path: string;
  sameSite: "lax";
  secure: boolean;
  domain?: string;
}

export function ssoCookieOptions(
  hostname: string | null | undefined,
  isHttps: boolean,
): SsoCookieOptions {
  const domain = ssoCookieDomain(hostname);
  return {
    path: "/",
    sameSite: "lax",
    secure: isHttps,
    ...(domain ? { domain } : {}),
  };
}
