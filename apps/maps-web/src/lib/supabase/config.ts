/**
 * Supabase public configuration. Returns `null` when env vars are absent so the
 * map shell still renders (guest mode) instead of crashing SSR or `next build`.
 */
export interface SupabasePublicConfig {
  url: string;
  anonKey: string;
}

export function getSupabaseConfig(): SupabasePublicConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** Hub origin used for sign-in hand-off. Non-production should use hub-stag. */
export function getHubUrl(): string {
  return process.env.NEXT_PUBLIC_HUB_URL ?? "https://hub.sunshade.icu";
}
