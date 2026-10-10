"use client";

import type { ReactNode } from "react";
import { InspectorProvider } from "./InspectorContext";
import { MapCanvas } from "./MapCanvas";
import { InspectorReticle } from "./InspectorReticle";

/** Client boundary hosting the WebGL canvas, reticle, and any map layer groups. */
export function MapShell({ children }: { children?: ReactNode }) {
  return (
    <InspectorProvider>
      <MapCanvas />
      <InspectorReticle />
      {children}
    </InspectorProvider>
  );
}
