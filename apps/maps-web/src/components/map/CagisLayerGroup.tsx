"use client";

import { useEffect, useState } from "react";
import { Popup, type GeoJSONSource, type MapMouseEvent } from "maplibre-gl";
import { BLUEPRINT } from "@/lib/theme";
import {
  CAGIS_LAYERS,
  bboxContains,
  fetchLayerFeatures,
  formatParcelAddress,
  isAbortError,
  padBBox,
  queryZoningAtPoint,
  type BBox,
  type CagisLayerKey,
} from "@/lib/gis/cagis";
import { useInspector } from "./InspectorContext";

const SOURCE = (key: CagisLayerKey) => `cagis-${key}`;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const PARCEL_FILL = "cagis-parcels-fill";
const PARCEL_LINE = "cagis-parcels-line";
const PARCEL_HOVER = "cagis-parcels-hover";
const PARCEL_SELECTED = "cagis-parcels-selected";

const FETCH_DEBOUNCE_MS = 250;
const PREFETCH_PAD_RATIO = 0.3;
/** Re-query when zoom drifts this far from the zoom the data was generalised for. */
const ZOOM_REFETCH_DELTA = 1.5;

type LayerStatus =
  | { state: "idle" }
  | { state: "below-min-zoom" }
  | { state: "loading" }
  | { state: "loaded"; count: number; truncated: boolean }
  | { state: "error"; message: string };

type StatusMap = Record<CagisLayerKey, LayerStatus>;

const INITIAL_STATUS: StatusMap = {
  zoning: { state: "idle" },
  streets: { state: "idle" },
  parcels: { state: "idle" },
};

interface LoadedWindow {
  bbox: BBox;
  zoom: number;
}

/**
 * Hamilton County (CAGIS) testbed layers: zoning, street centerlines and parcels.
 * Data is queried per viewport (padded bbox, zoom-gated, abortable) — never the whole county.
 * Clicking a parcel stores its PARCELID and zoning designation in the Inspector context.
 */
export function CagisLayerGroup() {
  const { map, setSelectedParcel } = useInspector();
  const [status, setStatus] = useState<StatusMap>(INITIAL_STATUS);

  useEffect(() => {
    if (!map) return;
    const activeMap = map;

    // ─── Sources & layers ────────────────────────────────────────────────
    (Object.keys(CAGIS_LAYERS) as CagisLayerKey[]).forEach((key) => {
      activeMap.addSource(SOURCE(key), { type: "geojson", data: EMPTY });
    });

    activeMap.addLayer({
      id: "cagis-zoning-fill",
      type: "fill",
      source: SOURCE("zoning"),
      paint: { "fill-color": BLUEPRINT.cyan, "fill-opacity": 0.05 },
    });
    activeMap.addLayer({
      id: "cagis-zoning-line",
      type: "line",
      source: SOURCE("zoning"),
      paint: { "line-color": BLUEPRINT.cyan, "line-opacity": 0.45, "line-width": 1, "line-dasharray": [4, 2] },
    });
    activeMap.addLayer({
      id: "cagis-streets-line",
      type: "line",
      source: SOURCE("streets"),
      paint: { "line-color": BLUEPRINT.cornflower, "line-opacity": 0.5, "line-width": 1 },
    });
    // Fill is near-invisible but keeps parcel interiors hit-testable for hover/click.
    activeMap.addLayer({
      id: PARCEL_FILL,
      type: "fill",
      source: SOURCE("parcels"),
      paint: { "fill-color": BLUEPRINT.cornflower, "fill-opacity": 0.03 },
    });
    activeMap.addLayer({
      id: PARCEL_LINE,
      type: "line",
      source: SOURCE("parcels"),
      paint: { "line-color": "rgba(74, 144, 226, 0.6)", "line-width": 0.8 },
    });
    activeMap.addLayer({
      id: PARCEL_HOVER,
      type: "line",
      source: SOURCE("parcels"),
      filter: ["==", ["get", "PARCELID"], ""],
      paint: { "line-color": BLUEPRINT.cyan, "line-width": 2 },
    });
    activeMap.addLayer({
      id: PARCEL_SELECTED,
      type: "line",
      source: SOURCE("parcels"),
      filter: ["==", ["get", "PARCELID"], ""],
      paint: { "line-color": BLUEPRINT.cyan, "line-width": 3 },
    });

    // ─── Viewport loading ────────────────────────────────────────────────
    const loaded: Partial<Record<CagisLayerKey, LoadedWindow>> = {};
    const controllers: Partial<Record<CagisLayerKey, AbortController>> = {};
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const patchStatus = (key: CagisLayerKey, next: LayerStatus) => {
      if (!disposed) setStatus((prev) => ({ ...prev, [key]: next }));
    };

    const setData = (key: CagisLayerKey, data: GeoJSON.FeatureCollection) => {
      const source = activeMap.getSource(SOURCE(key)) as GeoJSONSource | undefined;
      source?.setData(data);
    };

    const loadLayer = async (key: CagisLayerKey) => {
      const layer = CAGIS_LAYERS[key];
      const zoom = activeMap.getZoom();

      if (zoom < layer.minZoom) {
        controllers[key]?.abort();
        if (loaded[key]) {
          delete loaded[key];
          setData(key, EMPTY);
        }
        patchStatus(key, { state: "below-min-zoom" });
        return;
      }

      const bounds = activeMap.getBounds();
      const viewport: BBox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      const current = loaded[key];
      if (current && bboxContains(current.bbox, viewport) && Math.abs(current.zoom - zoom) < ZOOM_REFETCH_DELTA) {
        return;
      }

      controllers[key]?.abort();
      const controller = new AbortController();
      controllers[key] = controller;
      patchStatus(key, { state: "loading" });

      const bbox = padBBox(viewport, PREFETCH_PAD_RATIO);
      try {
        const result = await fetchLayerFeatures(key, bbox, zoom, { signal: controller.signal });
        if (controller.signal.aborted || disposed) return;
        loaded[key] = { bbox, zoom };
        setData(key, result.collection);
        patchStatus(key, { state: "loaded", count: result.collection.features.length, truncated: result.truncated });
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        // Keep whatever is already drawn; surface the failure instead of faking an empty result.
        console.error(`[maps-web] CAGIS ${key} query failed:`, error);
        patchStatus(key, { state: "error", message: error instanceof Error ? error.message : "Query failed" });
      }
    };

    const loadAll = () => {
      (Object.keys(CAGIS_LAYERS) as CagisLayerKey[]).forEach((key) => void loadLayer(key));
    };
    const scheduleLoad = () => {
      clearTimeout(debounce);
      debounce = setTimeout(loadAll, FETCH_DEBOUNCE_MS);
    };

    activeMap.on("moveend", scheduleLoad);
    loadAll();

    // ─── Hover tooltip (PARCELID) ────────────────────────────────────────
    const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 8 });
    let hoveredId = "";

    const clearHover = () => {
      hoveredId = "";
      activeMap.setFilter(PARCEL_HOVER, ["==", ["get", "PARCELID"], ""]);
      activeMap.getCanvas().style.cursor = "";
      popup.remove();
    };

    const onMouseMove = (e: MapMouseEvent) => {
      const feature = activeMap.queryRenderedFeatures(e.point, { layers: [PARCEL_FILL] })[0];
      const parcelId = feature?.properties?.PARCELID;
      if (typeof parcelId !== "string" || parcelId.length === 0) {
        if (hoveredId) clearHover();
        return;
      }
      activeMap.getCanvas().style.cursor = "pointer";
      if (parcelId !== hoveredId) {
        hoveredId = parcelId;
        activeMap.setFilter(PARCEL_HOVER, ["==", ["get", "PARCELID"], parcelId]);
      }
      const address = formatParcelAddress(feature.properties);
      popup.setLngLat(e.lngLat).setText(address ? `PARCELID ${parcelId} · ${address}` : `PARCELID ${parcelId}`).addTo(activeMap);
    };

    // ─── Click → PARCELID + zoning into Inspector state ──────────────────
    let zoningController: AbortController | undefined;

    const onClick = (e: MapMouseEvent) => {
      const feature = activeMap.queryRenderedFeatures(e.point, { layers: [PARCEL_FILL] })[0];
      const parcelId = feature?.properties?.PARCELID;
      zoningController?.abort();

      if (typeof parcelId !== "string" || parcelId.length === 0) {
        activeMap.setFilter(PARCEL_SELECTED, ["==", ["get", "PARCELID"], ""]);
        setSelectedParcel(null);
        return;
      }

      const lngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      const address = formatParcelAddress(feature.properties);
      activeMap.setFilter(PARCEL_SELECTED, ["==", ["get", "PARCELID"], parcelId]);
      // Publish the parcel immediately; zoning is merged in once the point query resolves.
      const base = {
        parcelId,
        address,
        lngLat,
        zoningCode: null,
        zoningDescription: null,
        zoningJurisdiction: null,
      };
      setSelectedParcel(base);

      const controller = new AbortController();
      zoningController = controller;
      queryZoningAtPoint(lngLat, { signal: controller.signal })
        .then((zoning) => {
          if (controller.signal.aborted || !zoning) return;
          setSelectedParcel({
            ...base,
            zoningCode: zoning.code,
            zoningDescription: zoning.description,
            zoningJurisdiction: zoning.jurisdiction,
          });
        })
        .catch((error: unknown) => {
          if (isAbortError(error) || controller.signal.aborted) return;
          console.error("[maps-web] CAGIS zoning lookup failed:", error);
        });
    };

    activeMap.on("mousemove", onMouseMove);
    activeMap.on("mouseout", clearHover);
    activeMap.on("click", onClick);

    return () => {
      disposed = true;
      clearTimeout(debounce);
      zoningController?.abort();
      Object.values(controllers).forEach((c) => c?.abort());
      activeMap.off("moveend", scheduleLoad);
      activeMap.off("mousemove", onMouseMove);
      activeMap.off("mouseout", clearHover);
      activeMap.off("click", onClick);
      popup.remove();
      setSelectedParcel(null);
      // The map may already be torn down (MapCanvas removes it on unmount).
      if (!activeMap.getStyle()) return;
      [PARCEL_SELECTED, PARCEL_HOVER, PARCEL_LINE, PARCEL_FILL, "cagis-streets-line", "cagis-zoning-line", "cagis-zoning-fill"].forEach(
        (id) => {
          if (activeMap.getLayer(id)) activeMap.removeLayer(id);
        },
      );
      (Object.keys(CAGIS_LAYERS) as CagisLayerKey[]).forEach((key) => {
        if (activeMap.getSource(SOURCE(key))) activeMap.removeSource(SOURCE(key));
      });
    };
  }, [map, setSelectedParcel]);

  if (!map) return null;

  return (
    <div className="hud-panel pointer-events-none absolute bottom-4 right-4 max-w-64 px-3 py-2 font-mono text-xs">
      <div className="hud-label">CAGIS · Hamilton Co.</div>
      <ul className="mt-1 space-y-0.5">
        {(Object.keys(CAGIS_LAYERS) as CagisLayerKey[]).map((key) => (
          <li key={key} className="flex justify-between gap-3 text-ink-muted">
            <span>{CAGIS_LAYERS[key].label}</span>
            <span className="tabular-nums text-ink">{describe(key, status[key])}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function describe(key: CagisLayerKey, s: LayerStatus): string {
  switch (s.state) {
    case "idle":
      return "—";
    case "below-min-zoom":
      return `zoom ≥ ${CAGIS_LAYERS[key].minZoom}`;
    case "loading":
      return "loading…";
    case "loaded":
      return s.truncated ? `${s.count}+ (capped)` : String(s.count);
    case "error":
      return "unavailable";
  }
}
