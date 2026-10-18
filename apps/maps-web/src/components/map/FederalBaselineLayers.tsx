"use client";

import { useEffect, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  FEDERAL_LAYERS,
  defaultFederalVisibility,
  type FederalLayerConfig,
  type FederalLayerId,
} from "@/lib/gis/federal";
import { LayerPanel } from "@/components/hud/LayerPanel";
import { useInspector } from "./InspectorContext";

/** Rasters sit beneath every vector/extrusion layer; pick the lowest one that already exists. */
const ABOVE_CANDIDATES = ["valerie-sentiment-extrusion", "cagis-zoning-fill"] as const;

function firstExisting(map: MapLibreMap): string | undefined {
  return ABOVE_CANDIDATES.find((id) => map.getLayer(id));
}

/** Adds one federal raster feed to the map while `enabled`, removing it on disable/unmount. */
function FederalRasterLayer({ map, config, enabled }: { map: MapLibreMap; config: FederalLayerConfig; enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    const sourceId = `federal-${config.id}`;
    const layerId = `federal-${config.id}-raster`;

    map.addSource(sourceId, {
      type: "raster",
      tiles: [config.tileUrl],
      tileSize: config.tileSize,
      minzoom: config.minZoom,
      maxzoom: config.maxZoom,
      attribution: config.attribution,
    });
    map.addLayer(
      { id: layerId, type: "raster", source: sourceId, paint: { "raster-opacity": config.opacity } },
      firstExisting(map),
    );

    return () => {
      // The map may already be torn down (MapCanvas removes it on unmount).
      if (!map.getStyle()) return;
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
  }, [map, config, enabled]);

  return null;
}

/**
 * Nationwide federal baselines — FEMA flood hazard zones and USGS 3DEP terrain slope / contours.
 * These feeds need no per-county registry entry, so they work everywhere the map is panned.
 */
export function FederalBaselineLayers() {
  const { map, zoom } = useInspector();
  const [visible, setVisible] = useState<Record<FederalLayerId, boolean>>(defaultFederalVisibility);

  if (!map) return null;

  return (
    <>
      {FEDERAL_LAYERS.map((config) => (
        <FederalRasterLayer key={config.id} map={map} config={config} enabled={visible[config.id]} />
      ))}
      <LayerPanel interactive>
        <div className="hud-label">Federal baselines</div>
        <ul className="mt-1 space-y-0.5">
          {FEDERAL_LAYERS.map((config) => {
            const enabled = visible[config.id];
            const outOfRange = enabled && zoom !== null && zoom < config.minZoom;
            return (
              <li key={config.id}>
                <label className="flex cursor-pointer items-center justify-between gap-3 text-ink-muted">
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => setVisible((prev) => ({ ...prev, [config.id]: e.target.checked }))}
                    />
                    {config.label}
                  </span>
                  <span className="tabular-nums text-ink">{outOfRange ? `zoom ≥ ${config.minZoom}` : ""}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </LayerPanel>
    </>
  );
}
