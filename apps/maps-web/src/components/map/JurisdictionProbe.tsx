"use client";

import { useEffect } from "react";
import { isAbortError } from "@/lib/gis/cagis";
import { useInspector } from "./InspectorContext";

/** Below this zoom the viewport spans too many counties for the centre to mean anything. */
const MIN_ZOOM = 9;
const DEBOUNCE_MS = 1500;
/** Skip the lookup while the centre stays within ~5 km of the last probed point. */
const MIN_MOVE_DEG = 0.05;

/**
 * Headless: when the map settles, resolves the centre's county so unregistered counties get a GIS
 * discovery job queued server-side (see `/api/v1/spatial/jurisdiction`). The response is
 * intentionally ignored — this is fire-and-forget and must never affect the map UI.
 */
export function JurisdictionProbe() {
  const { map } = useInspector();

  useEffect(() => {
    if (!map) return;
    const activeMap = map;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let last: { lng: number; lat: number } | null = null;

    const probe = () => {
      if (activeMap.getZoom() < MIN_ZOOM) return;
      const { lng, lat } = activeMap.getCenter().wrap();
      if (last && Math.abs(last.lng - lng) < MIN_MOVE_DEG && Math.abs(last.lat - lat) < MIN_MOVE_DEG) return;
      last = { lng, lat };
      controller?.abort();
      const current = new AbortController();
      controller = current;
      fetch(`/api/v1/spatial/jurisdiction?lng=${lng.toFixed(5)}&lat=${lat.toFixed(5)}`, { signal: current.signal }).catch(
        (error: unknown) => {
          if (isAbortError(error) || current.signal.aborted) return;
          console.error("[maps-web] jurisdiction probe failed:", error);
        },
      );
    };
    const schedule = () => {
      clearTimeout(debounce);
      debounce = setTimeout(probe, DEBOUNCE_MS);
    };

    activeMap.on("moveend", schedule);
    schedule();
    return () => {
      clearTimeout(debounce);
      controller?.abort();
      activeMap.off("moveend", schedule);
    };
  }, [map]);

  return null;
}
