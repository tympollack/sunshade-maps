import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { ssoCookieOptions } from "@/lib/supabase/cookies";

/**
 * Refreshes the shared `.sunshade.icu` Supabase session on each navigation so
 * a user signed in on hub.sunshade.icu arrives authenticated without re-login.
 * The map is public — this never redirects or blocks guests.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const config = getSupabaseConfig();
  if (!config) return response;

  const host = request.headers.get("x-forwarded-host") ?? request.nextUrl.host;
  const isHttps = request.nextUrl.protocol === "https:";

  const supabase = createServerClient(config.url, config.anonKey, {
    cookieOptions: ssoCookieOptions(host, isHttps),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        // Auth-cookie responses must never be CDN-cached (prevents cross-user session leaks).
        Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
      },
    },
  });

  // Triggers token refresh when needed; result intentionally unused (guests are allowed).
  const { error } = await supabase.auth.getUser();
  if (error && error.name !== "AuthSessionMissingError") {
    console.error("[maps-web] proxy session refresh failed:", error.message);
  }

  return response;
}

export const config = {
  matcher: [
    // Skip static assets, image optimisation and metadata files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
