import { MapShell } from "@/components/map/MapShell";
import { AuthBadge } from "@/components/hud/AuthBadge";

export default function Home() {
  return (
    <main className="relative h-dvh w-full overflow-hidden bg-navy">
      <MapShell />

      <header className="hud-panel pointer-events-none absolute left-4 top-4 px-3 py-2">
        <div className="hud-label">SunShade · Civic Field Guide</div>
        <h1 className="mt-0.5 font-mono text-sm tracking-wide text-ink">maps.sunshade.icu</h1>
      </header>

      <AuthBadge />
    </main>
  );
}
