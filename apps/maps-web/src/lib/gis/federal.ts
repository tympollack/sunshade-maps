/**
 * Universal federal baseline raster feeds (nationwide, no per-county registry needed):
 *   - USGS 3DEP elevation products (slope + contours) via the National Map WMS
 *   - FEMA National Flood Hazard Layer (NFHL) 100-year flood zones via ArcGIS `export`
 *
 * Endpoints verified live: both return `image/png` tiles and send permissive CORS headers
 * (3DEP `Access-Control-Allow-Origin: *`; FEMA reflects the request origin).
 * Framework-free so it is unit testable in node.
 */

export type FederalLayerId = "flood" | "slope" | "contours";

export interface FederalLayerConfig {
  id: FederalLayerId;
  label: string;
  description: string;
  /** MapLibre raster tile template ({bbox-epsg-3857} is substituted per tile). */
  tileUrl: string;
  tileSize: number;
  /** Below this zoom the upstream service renders nothing (FEMA NFHL scale limit) or is too coarse. */
  minZoom: number;
  maxZoom: number;
  opacity: number;
  /** Whether the layer starts enabled. Heavy terrain rasters start off. */
  defaultVisible: boolean;
  attribution: string;
}

const USGS_3DEP_WMS = "https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WMSServer";
const FEMA_NFHL_MAPSERVER = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer";

/** FEMA NFHL sublayer "Flood Hazard Zones" (verified against the service directory). */
export const FEMA_FLOOD_HAZARD_ZONES_LAYER_ID = 28;

function threeDepWmsTemplate(layerName: string): string {
  const params = new URLSearchParams({
    service: "WMS",
    version: "1.3.0",
    request: "GetMap",
    layers: layerName,
    styles: "",
    crs: "EPSG:3857",
    width: "256",
    height: "256",
    format: "image/png",
    transparent: "true",
  });
  // The bbox token must stay literal (URLSearchParams would percent-encode the braces).
  return `${USGS_3DEP_WMS}?${params.toString()}&bbox={bbox-epsg-3857}`;
}

export const FEDERAL_LAYERS: readonly FederalLayerConfig[] = [
  {
    id: "flood",
    label: "FEMA Flood Zones (100-yr)",
    description: "FEMA NFHL flood hazard zones",
    tileUrl:
      `${FEMA_NFHL_MAPSERVER}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256` +
      `&format=png32&transparent=true&layers=show:${FEMA_FLOOD_HAZARD_ZONES_LAYER_ID}&f=image`,
    tileSize: 256,
    minZoom: 12,
    maxZoom: 19,
    opacity: 0.55,
    defaultVisible: true,
    attribution:
      '<a href="https://www.fema.gov/flood-maps/national-flood-hazard-layer" target="_blank" rel="noreferrer">FEMA NFHL</a>',
  },
  {
    id: "slope",
    label: "USGS Terrain Slope",
    description: "USGS 3DEP slope map",
    tileUrl: threeDepWmsTemplate("3DEPElevation:Slope Map"),
    tileSize: 256,
    minZoom: 6,
    maxZoom: 18,
    opacity: 0.5,
    defaultVisible: false,
    attribution:
      '<a href="https://www.usgs.gov/3d-elevation-program" target="_blank" rel="noreferrer">USGS 3DEP</a>',
  },
  {
    id: "contours",
    label: "USGS Contours (25 ft)",
    description: "USGS 3DEP elevation contours",
    tileUrl: threeDepWmsTemplate("3DEPElevation:Contour 25"),
    tileSize: 256,
    minZoom: 12,
    maxZoom: 19,
    opacity: 0.8,
    defaultVisible: false,
    attribution:
      '<a href="https://www.usgs.gov/3d-elevation-program" target="_blank" rel="noreferrer">USGS 3DEP</a>',
  },
];

export function defaultFederalVisibility(): Record<FederalLayerId, boolean> {
  return Object.fromEntries(FEDERAL_LAYERS.map((l) => [l.id, l.defaultVisible])) as Record<FederalLayerId, boolean>;
}
