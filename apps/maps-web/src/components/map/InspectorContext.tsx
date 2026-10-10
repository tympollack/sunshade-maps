"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { LngLat } from "@/lib/map/coordinates";

/** Parcel attributes extracted on click (populated by GIS layer groups). */
export interface ParcelSelection {
  parcelId: string;
  zoningCode: string | null;
  zoningDescription: string | null;
  zoningJurisdiction: string | null;
  address: string | null;
  lngLat: LngLat;
}

interface InspectorState {
  map: MapLibreMap | null;
  setMap: (map: MapLibreMap | null) => void;
  /** Coordinate under the Inspector Reticle (map center), updated on drag end / click. */
  reticle: LngLat | null;
  setReticle: (lngLat: LngLat) => void;
  zoom: number | null;
  setZoom: (zoom: number) => void;
  selectedParcel: ParcelSelection | null;
  setSelectedParcel: (parcel: ParcelSelection | null) => void;
}

const InspectorContext = createContext<InspectorState | null>(null);

export function InspectorProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [reticle, setReticle] = useState<LngLat | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [selectedParcel, setSelectedParcel] = useState<ParcelSelection | null>(null);

  const value = useMemo<InspectorState>(
    () => ({ map, setMap, reticle, setReticle, zoom, setZoom, selectedParcel, setSelectedParcel }),
    [map, reticle, zoom, selectedParcel],
  );

  return <InspectorContext.Provider value={value}>{children}</InspectorContext.Provider>;
}

export function useInspector(): InspectorState {
  const ctx = useContext(InspectorContext);
  if (!ctx) throw new Error("useInspector must be used inside <InspectorProvider>");
  return ctx;
}
