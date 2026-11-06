import type { StyleSpecification } from "maplibre-gl";
import { BLUEPRINT } from "@/lib/theme";

/**
 * Keyless OpenMapTiles vector source (OpenFreeMap). Override with
 * NEXT_PUBLIC_MAP_TILES_URL to point at a self-hosted / PMTiles TileJSON.
 */
const TILES_URL = process.env.NEXT_PUBLIC_MAP_TILES_URL ?? "https://tiles.openfreemap.org/planet";
const GLYPHS_URL =
  process.env.NEXT_PUBLIC_MAP_GLYPHS_URL ?? "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

const FONT = ["Noto Sans Regular"];

/** Tech-Blueprint basemap: navy drafting sheet with cornflower linework. */
export const blueprintStyle: StyleSpecification = {
  version: 8,
  name: "SunShade Tech-Blueprint",
  glyphs: GLYPHS_URL,
  sources: {
    openmaptiles: {
      type: "vector",
      url: TILES_URL,
      attribution:
        '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> ' +
        '© <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> ' +
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": BLUEPRINT.navy } },
    {
      id: "park",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "park",
      paint: { "fill-color": BLUEPRINT.navyRaised, "fill-opacity": 0.6 },
    },
    {
      id: "water",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "water",
      paint: { "fill-color": BLUEPRINT.navyDeep, "fill-outline-color": BLUEPRINT.cornflower },
    },
    {
      id: "waterway",
      type: "line",
      source: "openmaptiles",
      "source-layer": "waterway",
      paint: { "line-color": BLUEPRINT.cornflower, "line-opacity": 0.35, "line-width": 1 },
    },
    {
      id: "building",
      type: "line",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 14,
      paint: { "line-color": BLUEPRINT.cornflower, "line-opacity": 0.25, "line-width": 0.5 },
    },
    {
      id: "road-minor",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["minor", "service", "track", "path"]]],
      minzoom: 12,
      paint: {
        "line-color": BLUEPRINT.cornflower,
        "line-opacity": 0.35,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.4, 18, 2],
      },
    },
    {
      id: "road-major",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: [
        "in",
        ["get", "class"],
        ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary"]],
      ],
      paint: {
        "line-color": BLUEPRINT.cornflower,
        "line-opacity": 0.75,
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 18, 4],
      },
    },
    {
      id: "boundary",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter: ["<=", ["get", "admin_level"], 6],
      paint: { "line-color": BLUEPRINT.cyan, "line-opacity": 0.4, "line-dasharray": [3, 2], "line-width": 1 },
    },
    {
      id: "road-label",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "transportation_name",
      minzoom: 14,
      layout: {
        "symbol-placement": "line",
        "text-field": ["get", "name"],
        "text-font": FONT,
        "text-size": 10,
      },
      paint: { "text-color": BLUEPRINT.inkMuted, "text-halo-color": BLUEPRINT.navy, "text-halo-width": 1.5 },
    },
    {
      id: "place-label",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      layout: {
        "text-field": ["get", "name"],
        "text-font": FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 14, 14],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.15,
      },
      paint: { "text-color": BLUEPRINT.ink, "text-halo-color": BLUEPRINT.navy, "text-halo-width": 1.5 },
    },
  ],
};

/** Default view: Hamilton County / Cincinnati testbed. */
export const DEFAULT_VIEW = {
  center: [-84.512, 39.1031] as [number, number],
  zoom: 12,
};
