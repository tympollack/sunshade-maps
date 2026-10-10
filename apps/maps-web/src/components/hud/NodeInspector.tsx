"use client";

import { useInspector } from "@/components/map/InspectorContext";
import { formatCoordinate } from "@/lib/map/coordinates";
import { DECAY_COLORS, compassLabel } from "@/lib/patchwork/nodes";

function formatTimestamp(iso: string | null): string {
  if (!iso) return "Not recorded";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Not recorded" : d.toLocaleString();
}

/** Inspector HUD card for a selected PatchWork node: sightline azimuth, timestamp, verification hash. */
export function NodeInspector() {
  const { selectedNode, setSelectedNode } = useInspector();
  if (!selectedNode) return null;

  const { decay_state, az_heading, verified_at, verification_hash, expires_at_yellow, expires_at_red } = selectedNode;

  return (
    <section
      aria-label="PatchWork node inspector"
      className="hud-panel absolute left-4 top-24 w-72 max-w-[calc(100vw-2rem)] px-3 py-2 font-mono text-xs"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="hud-label">PatchWork Node</div>
          <div className="mt-0.5 flex items-center gap-2 text-ink">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5"
              style={{ backgroundColor: DECAY_COLORS[decay_state] }}
            />
            <span className="uppercase tracking-wide">{decay_state === "unknown" ? "No expiry set" : decay_state}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSelectedNode(null)}
          aria-label="Close node inspector"
          className="border border-cornflower px-1.5 leading-5 text-ink-muted hover:text-cyan"
        >
          ×
        </button>
      </div>

      <dl className="mt-2 space-y-1.5">
        <Row label="Sightline azimuth">
          {az_heading === null ? "Not recorded" : `${az_heading.toFixed(1)}° ${compassLabel(az_heading)}`}
        </Row>
        <Row label="Verified">{formatTimestamp(verified_at)}</Row>
        <Row label="Verification hash">
          {verification_hash ? <span className="break-all">{verification_hash}</span> : "Not recorded"}
        </Row>
        {expires_at_yellow && <Row label="Warns">{formatTimestamp(expires_at_yellow)}</Row>}
        {expires_at_red && <Row label="Expires">{formatTimestamp(expires_at_red)}</Row>}
        <Row label="Location">{formatCoordinate({ lng: selectedNode.lng, lat: selectedNode.lat })}</Row>
      </dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular-nums text-ink">{children}</dd>
    </div>
  );
}
