"use client";

import type { ReactNode } from "react";
import { InspectorProvider, useInspector } from "./InspectorContext";
import { MapCanvas } from "./MapCanvas";
import { InspectorReticle } from "./InspectorReticle";

/** Bottom-right stack that layer groups portal their HUD panels into (first panel sits lowest). */
function PanelHost() {
  const { setPanelHost } = useInspector();
  return (
    <div
      ref={setPanelHost}
      className="pointer-events-none absolute bottom-4 right-4 flex w-64 max-w-[calc(100vw-2rem)] flex-col-reverse gap-2"
    />
  );
}

/** Client boundary hosting the WebGL canvas, reticle, and any map layer groups. */
export function MapShell({ children }: { children?: ReactNode }) {
  return (
    <InspectorProvider>
      <MapCanvas />
      <InspectorReticle />
      <PanelHost />
      {children}
    </InspectorProvider>
  );
}
