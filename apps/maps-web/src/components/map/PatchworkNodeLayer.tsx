"use client";

import { useEffect, useState } from "react";
import type { ExpressionSpecification, GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import { BLUEPRINT } from "@/lib/theme";
import { bboxContains, isAbortError, padBBox, queryParcelAtPoint, type BBox } from "@/lib/gis/cagis";
import {
  DECAY_COLORS,
  toDecayState,
  type PatchworkNodeCollection,
  type PatchworkNodeSelection,
} from "@/lib/patchwork/nodes";
import { LayerPanel } from "@/components/hud/LayerPanel";
import { useInspector } from "./InspectorContext";

const SOURCE = "patchwork-nodes";
const PARCEL_SOURCE = "patchwork-node-parcel";

const CLUSTERS = "pw-clusters";
const CLUSTER_COUNT = "pw-cluster-count";
const PULSE = "pw-pulse";
const NODES = "pw-nodes";
const SELECTED = "pw-node-selected";
const PARCEL_FILL = "pw-node-parcel-fill";
const PARCEL_LINE = "pw-node-parcel-line";
const ALL_LAYERS = [PARCEL_LINE, PARCEL_FILL, SELECTED, NODES, PULSE, CLUSTER_COUNT, CLUSTERS];

const MIN_ZOOM = 9;
const FETCH_DEBOUNCE_MS = 300;
const PREFETCH_PAD_RATIO = 0.25;
/** Decay colours are NOW()-relative, so reuse of already-loaded data expires. */
const MAX_DATA_AGE_MS = 60_000;
const PULSE_PERIOD_MS = 1600;
const PULSE_FRAME_MS = 33;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const NODE_COLOR: ExpressionSpecification = [
  "match",
  ["get", "severity"],
  3,
  DECAY_COLORS.red,
  2,
  DECAY_COLORS.yellow,
  1,
  DECAY_COLORS.green,
  DECAY_COLORS.unknown,
];
const CLUSTER_COLOR: ExpressionSpecification = [
  "match",
  ["get", "maxSeverity"],
  3,
  DECAY_COLORS.red,
  2,
  DECAY_COLORS.yellow,
  1,
  DECAY_COLORS.green,
  DECAY_COLORS.unknown,
];

type Status =
  | { state: "below-min-zoom" }
  | { state: "loading" }
  | { state: "loaded"; count: number; truncated: boolean }
  | { state: "error" };

function isNodeCollection(body: unknown): body is PatchworkNodeCollection {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { type?: unknown }).type === "FeatureCollection" &&
    Array.isArray((body as { features?: unknown }).features)
  );
}

/** MapLibre drops/serialises feature properties; normalise back to our selection shape. */
function toSelection(props: Record<string, unknown>, lng: number, lat: number): PatchworkNodeSelection | null {
  if (typeof props.node_id !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const az = typeof props.az_heading === "number" && Number.isFinite(props.az_heading) ? props.az_heading : null;
  const decay = toDecayState(props.decay_state);
  return {
    node_id: props.node_id,
    decay_state: decay,
    severity: typeof props.severity === "number" ? props.severity : 0,
    expires_at_yellow: str(props.expires_at_yellow),
    expires_at_red: str(props.expires_at_red),
    verification_hash: str(props.verification_hash),
    verified_at: str(props.verified_at),
    az_heading: az,
    lng,
    lat,
  };
}

/**
 * PatchWork verified-infrastructure overlay. Nodes stream per viewport from
 * `/api/v1/spatial/nodes`, cluster with MapLibre's built-in supercluster, and render as
 * WebGL circles coloured by decay state (decaying nodes pulse). Clicking a node publishes
 * it to the Inspector HUD and highlights the CAGIS parcel it sits on.
 */
export function PatchworkNodeLayer() {
  const { map, setSelectedNode } = useInspector();
  const [status, setStatus] = useState<Status>({ state: "below-min-zoom" });

  useEffect(() => {
    if (!map) return;
    const activeMap = map;

    activeMap.addSource(SOURCE, {
      type: "geojson",
      data: EMPTY,
      cluster: true,
      clusterRadius: 48,
      clusterMaxZoom: 14,
      clusterProperties: { maxSeverity: ["max", ["get", "severity"]] },
    });
    activeMap.addSource(PARCEL_SOURCE, { type: "geojson", data: EMPTY });

    activeMap.addLayer({
      id: PARCEL_FILL,
      type: "fill",
      source: PARCEL_SOURCE,
      paint: { "fill-color": BLUEPRINT.cyan, "fill-opacity": 0.12 },
    });
    activeMap.addLayer({
      id: PARCEL_LINE,
      type: "line",
      source: PARCEL_SOURCE,
      paint: { "line-color": BLUEPRINT.cyan, "line-width": 2.5 },
    });
    activeMap.addLayer({
      id: CLUSTERS,
      type: "circle",
      source: SOURCE,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": CLUSTER_COLOR,
        "circle-opacity": 0.85,
        "circle-radius": ["step", ["get", "point_count"], 14, 10, 18, 50, 24, 200, 30],
        "circle-stroke-color": BLUEPRINT.navy,
        "circle-stroke-width": 2,
      },
    });
    activeMap.addLayer({
      id: CLUSTER_COUNT,
      type: "symbol",
      source: SOURCE,
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "text-allow-overlap": true,
      },
      paint: { "text-color": BLUEPRINT.navy },
    });
    // Pulse ring: only decaying (yellow/red) unclustered nodes; animated below.
    activeMap.addLayer({
      id: PULSE,
      type: "circle",
      source: SOURCE,
      filter: ["all", ["!", ["has", "point_count"]], [">=", ["get", "severity"], 2]],
      paint: {
        "circle-color": NODE_COLOR,
        "circle-opacity": 0.35,
        "circle-radius": 12,
        "circle-pitch-alignment": "map",
      },
    });
    activeMap.addLayer({
      id: NODES,
      type: "circle",
      source: SOURCE,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": NODE_COLOR,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 4, 16, 8],
        "circle-stroke-color": BLUEPRINT.navy,
        "circle-stroke-width": 1.5,
      },
    });
    activeMap.addLayer({
      id: SELECTED,
      type: "circle",
      source: SOURCE,
      filter: ["==", ["get", "node_id"], ""],
      paint: {
        "circle-color": "rgba(0,0,0,0)",
        "circle-radius": 13,
        "circle-stroke-color": BLUEPRINT.cyan,
        "circle-stroke-width": 2,
      },
    });

    // ─── Viewport loading ────────────────────────────────────────────────
    let loaded: { bbox: BBox; at: number } | null = null;
    let controller: AbortController | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let hasDecaying = false;

    const source = () => activeMap.getSource(SOURCE) as GeoJSONSource | undefined;

    const load = async () => {
      const zoom = activeMap.getZoom();
      if (zoom < MIN_ZOOM) {
        controller?.abort();
        if (loaded) {
          loaded = null;
          hasDecaying = false;
          source()?.setData(EMPTY);
        }
        if (!disposed) setStatus({ state: "below-min-zoom" });
        return;
      }

      const b = activeMap.getBounds();
      const viewport: BBox = [
        Math.max(-180, b.getWest()),
        Math.max(-90, b.getSouth()),
        Math.min(180, b.getEast()),
        Math.min(90, b.getNorth()),
      ];
      if (loaded && bboxContains(loaded.bbox, viewport) && Date.now() - loaded.at < MAX_DATA_AGE_MS) return;

      controller?.abort();
      const current = new AbortController();
      controller = current;
      if (!disposed) setStatus({ state: "loading" });

      const padded = padBBox(viewport, PREFETCH_PAD_RATIO);
      const bbox: BBox = [Math.max(-180, padded[0]), padded[1], Math.min(180, padded[2]), padded[3]];
      try {
        const res = await fetch(`/api/v1/spatial/nodes?bbox=${bbox.map((n) => n.toFixed(6)).join(",")}`, {
          signal: current.signal,
        });
        if (!res.ok) throw new Error(`Node API responded with HTTP ${res.status}`);
        const body: unknown = await res.json();
        if (!isNodeCollection(body)) throw new Error("Node API returned an unexpected payload");
        if (current.signal.aborted || disposed) return;

        loaded = { bbox, at: Date.now() };
        hasDecaying = body.features.some((f) => f.properties.severity >= 2);
        source()?.setData(body);
        setStatus({ state: "loaded", count: body.features.length, truncated: body.truncated });
      } catch (error) {
        if (isAbortError(error) || current.signal.aborted) return;
        console.error("[maps-web] PatchWork node query failed:", error);
        if (!disposed) setStatus({ state: "error" });
      }
    };

    const scheduleLoad = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void load(), FETCH_DEBOUNCE_MS);
    };
    activeMap.on("moveend", scheduleLoad);
    void load();

    // ─── Pulse animation (decaying nodes only; honours reduced motion) ───
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let lastFrame = 0;
    const animate = (now: number) => {
      raf = requestAnimationFrame(animate);
      if (!hasDecaying || now - lastFrame < PULSE_FRAME_MS) return;
      lastFrame = now;
      const phase = (now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
      activeMap.setPaintProperty(PULSE, "circle-radius", 8 + phase * 16);
      activeMap.setPaintProperty(PULSE, "circle-opacity", 0.45 * (1 - phase));
    };
    if (reducedMotion) {
      activeMap.setPaintProperty(PULSE, "circle-radius", 12);
    } else {
      raf = requestAnimationFrame(animate);
    }

    // ─── Interaction ─────────────────────────────────────────────────────
    let parcelController: AbortController | undefined;

    const clearSelection = () => {
      parcelController?.abort();
      activeMap.setFilter(SELECTED, ["==", ["get", "node_id"], ""]);
      (activeMap.getSource(PARCEL_SOURCE) as GeoJSONSource | undefined)?.setData(EMPTY);
      setSelectedNode(null);
    };

    const onClick = (e: MapMouseEvent) => {
      const hits = activeMap.queryRenderedFeatures(e.point, { layers: [CLUSTERS, NODES] });
      const hit = hits[0];
      if (!hit) {
        clearSelection();
        return;
      }

      if (hit.layer.id === CLUSTERS) {
        const clusterId = hit.properties?.cluster_id;
        if (typeof clusterId !== "number" || hit.geometry.type !== "Point") return;
        const center = hit.geometry.coordinates as [number, number];
        source()
          ?.getClusterExpansionZoom(clusterId)
          .then((z) => activeMap.easeTo({ center, zoom: z + 0.5, duration: 400 }))
          .catch((error: unknown) => console.error("[maps-web] cluster expansion failed:", error));
        return;
      }

      if (hit.geometry.type !== "Point") return;
      const [lng, lat] = hit.geometry.coordinates as [number, number];
      const selection = toSelection(hit.properties ?? {}, lng, lat);
      if (!selection) return;

      setSelectedNode(selection);
      activeMap.setFilter(SELECTED, ["==", ["get", "node_id"], selection.node_id]);

      // Highlight the county parcel this node intersects.
      parcelController?.abort();
      const pc = new AbortController();
      parcelController = pc;
      queryParcelAtPoint({ lng, lat }, { signal: pc.signal })
        .then((parcel) => {
          if (pc.signal.aborted) return;
          const target = activeMap.getSource(PARCEL_SOURCE) as GeoJSONSource | undefined;
          target?.setData(parcel ? { type: "FeatureCollection", features: [parcel] } : EMPTY);
        })
        .catch((error: unknown) => {
          if (isAbortError(error) || pc.signal.aborted) return;
          console.error("[maps-web] parcel highlight lookup failed:", error);
        });
    };

    const onEnter = () => {
      activeMap.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      activeMap.getCanvas().style.cursor = "";
    };

    activeMap.on("click", onClick);
    activeMap.on("mouseenter", CLUSTERS, onEnter);
    activeMap.on("mouseleave", CLUSTERS, onLeave);
    activeMap.on("mouseenter", NODES, onEnter);
    activeMap.on("mouseleave", NODES, onLeave);

    return () => {
      disposed = true;
      clearTimeout(debounce);
      cancelAnimationFrame(raf);
      controller?.abort();
      parcelController?.abort();
      activeMap.off("moveend", scheduleLoad);
      activeMap.off("click", onClick);
      activeMap.off("mouseenter", CLUSTERS, onEnter);
      activeMap.off("mouseleave", CLUSTERS, onLeave);
      activeMap.off("mouseenter", NODES, onEnter);
      activeMap.off("mouseleave", NODES, onLeave);
      setSelectedNode(null);
      // The map may already be torn down (MapCanvas removes it on unmount).
      if (!activeMap.getStyle()) return;
      ALL_LAYERS.forEach((id) => {
        if (activeMap.getLayer(id)) activeMap.removeLayer(id);
      });
      [SOURCE, PARCEL_SOURCE].forEach((id) => {
        if (activeMap.getSource(id)) activeMap.removeSource(id);
      });
    };
  }, [map, setSelectedNode]);

  if (!map) return null;

  return (
    <LayerPanel>
      <div className="hud-label">PatchWork · Verified Nodes</div>
      <div className="mt-1 flex justify-between gap-3 text-ink-muted">
        <span>In view</span>
        <span className="tabular-nums text-ink">{describe(status)}</span>
      </div>
    </LayerPanel>
  );
}

function describe(s: Status): string {
  switch (s.state) {
    case "below-min-zoom":
      return `zoom ≥ ${MIN_ZOOM}`;
    case "loading":
      return "loading…";
    case "loaded":
      return s.truncated ? `${s.count}+ (capped)` : String(s.count);
    case "error":
      return "unavailable";
  }
}
