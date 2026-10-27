import { cookies, headers } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabaseConfig } from "./config";
import { ssoCookieOptions } from "./cookies";

/**
 * Per-request server Supabase client (Server Components / Route Handlers).
 * Reads the `.sunshade.icu` SSO cookies set by hub.sunshade.icu. Cookie writes
 * are a no-op during Server Component render — session refresh happens in
 * `src/proxy.ts`.
 */
export async function getServerSupabase(): Promise<SupabaseClient | null> {
  const config = getSupabaseConfig();
  if (!config) return null;

  const cookieStore = await cookies();
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const isHttps = (headerStore.get("x-forwarded-proto") ?? "https") === "https";

  return createServerClient(config.url, config.anonKey, {
    cookieOptions: ssoCookieOptions(host, isHttps),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component: cookies are read-only during render.
          // The proxy refreshes and persists the session on the next request.
        }
      },
    },
  });
}

/** Resolves the signed-in SSO user, or `null` for guests / unconfigured envs. */
export async function getSessionUser(): Promise<User | null> {
  const supabase = await getServerSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser();
  if (error) {
    // "Auth session missing" is the normal guest path; anything else is worth surfacing in logs.
    if (error.name !== "AuthSessionMissingError") {
      console.error("[maps-web] supabase.auth.getUser failed:", error.message);
    }
    return null;
  }
  return data.user;
}
