"use client";

import { formatCoordinate } from "@/lib/map/coordinates";
import { NOT_RECORDED } from "@/lib/inspector/format";
import { DECAY_COLORS, compassLabel, type PatchworkNodeSelection } from "@/lib/patchwork/nodes";

function formatTimestamp(iso: string | null): string {
  if (!iso) return NOT_RECORDED;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? NOT_RECORDED : d.toLocaleString();
}

/** Details of a selected PatchWork node: sightline azimuth, timestamp, verification hash. */
export function NodeDetails({ node }: { node: PatchworkNodeSelection }) {
  const { decay_state, az_heading, verified_at, verification_hash, expires_at_yellow, expires_at_red } = node;

  return (
    <div>
      <div className="flex items-center gap-2 text-ink">
        <span aria-hidden className="inline-block h-2.5 w-2.5" style={{ backgroundColor: DECAY_COLORS[decay_state] }} />
        <span className="uppercase tracking-wide">{decay_state === "unknown" ? "No expiry set" : decay_state}</span>
      </div>
      <dl className="mt-2 space-y-1.5">
        <Row label="Sightline azimuth">
          {az_heading === null ? NOT_RECORDED : `${az_heading.toFixed(1)}° ${compassLabel(az_heading)}`}
        </Row>
        <Row label="Verified">{formatTimestamp(verified_at)}</Row>
        <Row label="Verification hash">
          {verification_hash ? <span className="break-all">{verification_hash}</span> : NOT_RECORDED}
        </Row>
        {expires_at_yellow && <Row label="Warns">{formatTimestamp(expires_at_yellow)}</Row>}
        {expires_at_red && <Row label="Expires">{formatTimestamp(expires_at_red)}</Row>}
        <Row label="Location">{formatCoordinate({ lng: node.lng, lat: node.lat })}</Row>
      </dl>
    </div>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular-nums text-ink">{children}</dd>
    </div>
  );
}
