import { describe, expect, it } from "vitest";
import {
  FEDERAL_LAYERS,
  FEMA_FLOOD_HAZARD_ZONES_LAYER_ID,
  defaultFederalVisibility,
} from "./federal";

describe("federal layer configs", () => {
  it("has unique ids and https tile templates carrying the epsg-3857 bbox token", () => {
    const ids = FEDERAL_LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const layer of FEDERAL_LAYERS) {
      expect(layer.tileUrl.startsWith("https://")).toBe(true);
      expect(layer.tileUrl).toContain("{bbox-epsg-3857}");
      expect(layer.minZoom).toBeLessThan(layer.maxZoom);
      expect(layer.opacity).toBeGreaterThan(0);
      expect(layer.opacity).toBeLessThanOrEqual(1);
    }
  });

  it("targets the verified FEMA Flood Hazard Zones sublayer through ArcGIS export", () => {
    const flood = FEDERAL_LAYERS.find((l) => l.id === "flood");
    expect(flood?.tileUrl).toContain("hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/export");
    expect(flood?.tileUrl).toContain(`layers=show:${FEMA_FLOOD_HAZARD_ZONES_LAYER_ID}`);
    expect(flood?.tileUrl).toContain("transparent=true");
  });

  it("builds 3DEP WMS 1.3.0 GetMap templates with an unencoded bbox token", () => {
    for (const id of ["slope", "contours"] as const) {
      const layer = FEDERAL_LAYERS.find((l) => l.id === id);
      expect(layer?.tileUrl).toContain("elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WMSServer");
      expect(layer?.tileUrl).toContain("version=1.3.0");
      expect(layer?.tileUrl).toContain("crs=EPSG%3A3857");
      expect(layer?.tileUrl.endsWith("&bbox={bbox-epsg-3857}")).toBe(true);
    }
    expect(FEDERAL_LAYERS.find((l) => l.id === "slope")?.tileUrl).toContain("3DEPElevation%3ASlope+Map");
    expect(FEDERAL_LAYERS.find((l) => l.id === "contours")?.tileUrl).toContain("3DEPElevation%3AContour+25");
  });

  it("starts with flood zones on and heavy terrain rasters off", () => {
    expect(defaultFederalVisibility()).toEqual({ flood: true, slope: false, contours: false });
  });
});
