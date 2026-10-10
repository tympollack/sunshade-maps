"use client";

import { useEffect, useRef } from "react";
import { Map as MapLibreMap, type MapMouseEvent } from "maplibre-gl";
import { blueprintStyle, DEFAULT_VIEW } from "@/lib/map/blueprintStyle";
import { wrapLng } from "@/lib/map/coordinates";
import { useInspector } from "./InspectorContext";

/**
 * Full-screen MapLibre GL canvas.
 *
 * Deliberately ships no NavigationControl / transit UI — interaction is driven
 * by the Inspector Reticle. React state is only updated on `moveend`/`click`
 * (never per frame) so the WebGL render loop stays at display refresh rate.
 */
export function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { setMap, setReticle, setZoom } = useInspector();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new MapLibreMap({
      container,
      style: blueprintStyle,
      center: DEFAULT_VIEW.center,
      zoom: DEFAULT_VIEW.zoom,
      attributionControl: { compact: true },
      maxPitch: 60,
      fadeDuration: 0,
    });

    const captureCenter = () => {
      const c = map.getCenter();
      setReticle({ lng: wrapLng(c.lng), lat: c.lat });
      setZoom(map.getZoom());
    };

    // Click: glide the clicked point under the reticle; moveend then captures it.
    // Feature layers (parcels etc.) handle their own clicks and still trigger this glide.
    const onClick = (e: MapMouseEvent) => {
      map.easeTo({ center: e.lngLat, duration: 350 });
    };

    map.on("load", () => {
      captureCenter();
      setMap(map);
    });
    map.on("moveend", captureCenter);
    map.on("click", onClick);

    return () => {
      setMap(null);
      map.remove();
    };
  }, [setMap, setReticle, setZoom]);

  return <div ref={containerRef} className="absolute inset-0" aria-label="Civic map canvas" role="region" />;
}
