"use client";

import { useEffect } from "react";
import { fetchNearbyAudits } from "@/lib/inspector/report";
import { isAbortError } from "@/lib/gis/cagis";
import { parseCommandCenterParams } from "@/lib/handoff/deeplink";
import { useInspector } from "./InspectorContext";

/**
 * Inbound half of the PatchWork handoff: when the page is opened from a "View in Command Center"
 * link (`?node=&lat=&lng=&z=`), fly to the node and open it in the Inspector drawer. Runs once.
 */
export function DeepLinkHandoff() {
  const { map, setSelectedNode } = useInspector();

  useEffect(() => {
    if (!map) return;
    const target = parseCommandCenterParams(window.location.search);
    if (!target) return;

    map.jumpTo({ center: [target.center.lng, target.center.lat], zoom: target.zoom });
    if (!target.nodeId) return;

    const controller = new AbortController();
    const { lng, lat } = target.center;
    fetchNearbyAudits([lng, lat, lng, lat], { signal: controller.signal })
      .then(({ nodes }) => {
        if (controller.signal.aborted) return;
        const node = nodes.find((n) => n.node_id.toLowerCase() === target.nodeId);
        if (node) setSelectedNode(node);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        console.error("[maps-web] deep-link node lookup failed:", error);
      });
    return () => controller.abort();
  }, [map, setSelectedNode]);

  return null;
}
