# maps-web

Next.js 16 (App Router) client for **maps.sunshade.icu**: the SunShade Civic Field Guide.

## Stack
- **MapLibre GL JS** full-screen WebGL canvas with a hand-built Tech-Blueprint basemap (`src/lib/map/blueprintStyle.ts`) over keyless OpenFreeMap vector tiles.
- **Tailwind CSS v4** blueprint tokens (`src/app/globals.css`, mirrored in `src/lib/theme.ts`): navy `#0B132B`, cornflower `#4A90E2`, cyan `#00E5FF`, 0px corners.
- **@supabase/ssr** with shared SunShade SSO. On `*.sunshade.icu` hosts, auth cookies are scoped to `.sunshade.icu`, so a session from hub.sunshade.icu carries over. `src/proxy.ts` refreshes the session on each navigation. Next 16 renamed `middleware` to `proxy`.

## Inspector Reticle
There are no navigation or transit controls. A fixed crosshair marks the map center:
- **Drag**: the coordinate under the reticle is captured on `moveend`.
- **Click**: the map glides the clicked point under the reticle, then captures it.

## Develop
```sh
cp .env.example .env.local   # fill in Supabase URL + anon key
npm install                  # from repo root (npm workspaces)
npm run dev --workspace=@sunshade/maps-web
```

Without Supabase env vars the map still renders in guest mode.

## Verify
```sh
npx tsc --noEmit
npm test -- --passWithNoTests
npm run build
```
