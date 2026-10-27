import { getHubUrl } from "@/lib/supabase/config";
import { getSessionUser } from "@/lib/supabase/server";

/** Server-rendered SSO status chip. Users signed in on the Hub arrive authenticated. */
export async function AuthBadge() {
  const user = await getSessionUser();
  const hubUrl = getHubUrl();

  return (
    <div className="hud-panel absolute right-4 top-4 px-3 py-2 font-mono text-xs">
      <div className="hud-label">Operator</div>
      {user ? (
        <div className="mt-1 max-w-56 truncate text-ink" title={user.email ?? user.id}>
          {user.email ?? "Signed in"}
        </div>
      ) : (
        <a
          href={hubUrl}
          className="mt-1 block text-cornflower underline-offset-2 hover:text-cyan hover:underline"
        >
          Guest · Sign in at Hub
        </a>
      )}
    </div>
  );
}
