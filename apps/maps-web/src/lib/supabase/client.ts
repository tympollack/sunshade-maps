"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "./config";
import { ssoCookieOptions } from "./cookies";

let browserClient: SupabaseClient | null = null;

/**
 * Browser Supabase client sharing the `.sunshade.icu` SSO session with
 * hub.sunshade.icu. Returns `null` when Supabase env vars are not configured
 * (guest mode) so callers must handle the absence explicitly.
 */
export function getBrowserSupabase(): SupabaseClient | null {
  if (browserClient) return browserClient;
  const config = getSupabaseConfig();
  if (!config || typeof window === "undefined") return null;

  browserClient = createBrowserClient(config.url, config.anonKey, {
    cookieOptions: ssoCookieOptions(window.location.hostname, window.location.protocol === "https:"),
  });
  return browserClient;
}
