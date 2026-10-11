"use client";

import { useEffect, useState } from "react";
import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";
import { bboxContains, isAbortError, padBBox, type BBox } from "@/lib/gis/cagis";
import {
  CONFIDENCE_METERS_PER_POINT,
  K_MIN_RESPONDENTS,
  SENTIMENT_RAMP,
  type SentimentCollection,
} from "@/lib/valerie/sentiment";
import { useInspector } from "./InspectorContext";

const SOURCE = "valerie-sentiment";
const LAYER = "valerie-sentiment-extrusion";

/** Res-7 cells (~5 km2): below this zoom a viewport would cover too many cells. */
const MIN_ZOOM = 10;
const FETCH_DEBOUNCE_MS = 400;
const PREFETCH_PAD_RATIO = 0.15;
const MAX_DATA_AGE_MS = 120_000;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

// Crimson → Amber → Emerald on mean Likert (−2…+2).
const COLOR: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["get", "avg_likert"],
  ...SENTIMENT_RAMP.flatMap((stop) => [stop.score, stop.color]),
] as unknown as ExpressionSpecification;

// Confidence (0–100%) drives 3D extrusion height.
const HEIGHT: ExpressionSpecification = ["*", ["get", "avg_confidence"], CONFIDENCE_METERS_PER_POINT];

type Status =
  | { state: "hidden" }
  | { state: "below-min-zoom" }
  | { state: "loading" }
  | { state: "loaded"; cells: number }
  | { state: "signed-out" }
  | { state: "error"; message: string };

function isSentimentCollection(body: unknown): body is SentimentCollection {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { type?: unknown }).type === "FeatureCollection" &&
    Array.isArray((body as { features?: unknown }).features)
  );
}

class SignedOutError extends Error {}

/**
 * Project Valerie bivariate sentiment heatmap: H3 hexagons coloured by mean Likert and
 * extruded by mean confidence. Cells below the K-anonymity threshold are never sent by the
 * server, so nothing is drawn for them. Requires the shared SSO session.
 */
export function ValerieSentimentLayer() {
  const { map } = useInspector();
  const [visible, setVisible] = useState(true);
  const [status, setStatus] = useState<Status>({ state: "hidden" });

  useEffect(() => {
    if (!map || !visible) return;
    const activeMap = map;

    activeMap.addSource(SOURCE, { type: "geojson", data: EMPTY });
    activeMap.addLayer({
      id: LAYER,
      type: "fill-extrusion",
      source: SOURCE,
      paint: {
        "fill-extrusion-color": COLOR,
        "fill-extrusion-height": HEIGHT,
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.6,
      },
    });

    let loaded: { bbox: BBox; at: number } | null = null;
    let controller: AbortController | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let signedOut = false;

    const update = (next: Status) => {
      if (!disposed) setStatus(next);
    };

    const load = async () => {
      if (signedOut) return;
      const zoom = activeMap.getZoom();
      if (zoom < MIN_ZOOM) {
        controller?.abort();
        if (loaded) {
          loaded = null;
          (activeMap.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(EMPTY);
        }
        update({ state: "below-min-zoom" });
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
      update({ state: "loading" });

      const padded = padBBox(viewport, PREFETCH_PAD_RATIO);
      const bbox: BBox = [Math.max(-180, padded[0]), Math.max(-90, padded[1]), Math.min(180, padded[2]), Math.min(90, padded[3])];
      try {
        const res = await fetch(`/api/spatial/valerie?bbox=${bbox.map((n) => n.toFixed(6)).join(",")}`, {
          signal: current.signal,
          credentials: "same-origin",
        });
        if (res.status === 401) throw new SignedOutError();
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error ?? `Sentiment API responded with HTTP ${res.status}`);
        }
        const body: unknown = await res.json();
        if (!isSentimentCollection(body)) throw new Error("Sentiment API returned an unexpected payload");
        if (current.signal.aborted || disposed) return;

        loaded = { bbox, at: Date.now() };
        (activeMap.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(body);
        update({ state: "loaded", cells: body.features.length });
      } catch (error) {
        if (isAbortError(error) || current.signal.aborted) return;
        if (error instanceof SignedOutError) {
          signedOut = true;
          update({ state: "signed-out" });
          return;
        }
        console.error("[maps-web] Valerie sentiment query failed:", error);
        update({ state: "error", message: error instanceof Error ? error.message : "Query failed" });
      }
    };

    const scheduleLoad = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void load(), FETCH_DEBOUNCE_MS);
    };
    activeMap.on("moveend", scheduleLoad);
    void load();

    return () => {
      disposed = true;
      clearTimeout(debounce);
      controller?.abort();
      activeMap.off("moveend", scheduleLoad);
      if (!activeMap.getStyle()) return; // map already torn down by MapCanvas
      if (activeMap.getLayer(LAYER)) activeMap.removeLayer(LAYER);
      if (activeMap.getSource(SOURCE)) activeMap.removeSource(SOURCE);
    };
  }, [map, visible]);

  if (!map) return null;

  const gradient = `linear-gradient(to right, ${SENTIMENT_RAMP.map((s) => s.color).join(", ")})`;

  return (
    <div className="hud-panel absolute bottom-48 right-4 w-64 px-3 py-2 font-mono text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="hud-label">Valerie · Sentiment</div>
        <label className="flex cursor-pointer items-center gap-1.5 text-ink-muted">
          <input
            type="checkbox"
            checked={visible}
            onChange={(e) => {
              setVisible(e.target.checked);
              if (!e.target.checked) setStatus({ state: "hidden" });
            }}
            className="accent-cyan"
          />
          Show
        </label>
      </div>

      <div className="mt-1.5 h-2 w-full" style={{ background: gradient }} aria-hidden />
      <div className="mt-0.5 flex justify-between text-[10px] text-ink-muted">
        <span>Negative</span>
        <span>Positive</span>
      </div>
      <div className="mt-0.5 text-[10px] text-ink-muted">Height = confidence</div>

      <div className="mt-1.5 text-ink" aria-live="polite">
        {describe(status)}
      </div>
    </div>
  );
}

function describe(s: Status): string {
  switch (s.state) {
    case "hidden":
      return "Layer hidden";
    case "below-min-zoom":
      return `Zoom in to zoom ≥ ${MIN_ZOOM}`;
    case "loading":
      return "Loading…";
    case "loaded":
      return s.cells === 0
        ? `No cells meet the ${K_MIN_RESPONDENTS}-respondent privacy threshold`
        : `${s.cells} cell${s.cells === 1 ? "" : "s"} · N ≥ ${K_MIN_RESPONDENTS}`;
    case "signed-out":
      return "Sign in to view community sentiment";
    case "error":
      return "Sentiment unavailable";
  }
}
