"use client";

import { formatCoordinate } from "@/lib/map/coordinates";
import { useInspector } from "./InspectorContext";

/**
 * Inspector Reticle — fixed crosshair at the map center plus a coordinate
 * readout. Replaces conventional transit/navigation UI. The coordinate is
 * captured from the map center on drag end or click (see MapCanvas).
 */
export function InspectorReticle() {
  const { reticle, zoom } = useInspector();

  return (
    <>
      {/* Crosshair (purely visual; never intercepts pointer events) */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <div className="relative h-16 w-16">
          <span className="absolute left-1/2 top-0 h-5 w-px -translate-x-1/2 bg-cyan" />
          <span className="absolute bottom-0 left-1/2 h-5 w-px -translate-x-1/2 bg-cyan" />
          <span className="absolute left-0 top-1/2 h-px w-5 -translate-y-1/2 bg-cyan" />
          <span className="absolute right-0 top-1/2 h-px w-5 -translate-y-1/2 bg-cyan" />
          <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 border border-cyan" />
          <span className="absolute inset-3 border border-cornflower/60" />
        </div>
      </div>

      {/* Readout */}
      <div className="hud-panel pointer-events-none absolute bottom-4 left-4 px-3 py-2 font-mono text-xs">
        <div className="hud-label">Inspector Reticle</div>
        <div className="mt-1 tabular-nums text-ink" aria-live="polite">
          {reticle ? formatCoordinate(reticle) : "Acquiring…"}
        </div>
        <div className="mt-0.5 tabular-nums text-ink-muted">
          Z {zoom !== null ? zoom.toFixed(2) : "--"}
        </div>
      </div>
    </>
  );
}
