"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useInspector } from "@/components/map/InspectorContext";

/**
 * Renders a HUD panel into the shared bottom-right panel stack (see MapShell), so layer
 * groups never need hard-coded offsets to avoid overlapping each other.
 */
export function LayerPanel({ children, interactive = false }: { children: ReactNode; interactive?: boolean }) {
  const { panelHost } = useInspector();
  if (!panelHost) return null;
  return createPortal(
    <div className={`hud-panel px-3 py-2 font-mono text-xs ${interactive ? "pointer-events-auto" : "pointer-events-none"}`}>
      {children}
    </div>,
    panelHost,
  );
}
