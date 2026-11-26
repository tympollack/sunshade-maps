"use client";

import { useEffect, useState } from "react";
import { isAbortError, queryParcelAtPoint } from "@/lib/gis/cagis";
import { snapPointToParcel, type SnapResult } from "@/lib/patchwork/snap";
import { compareHash, isValidSha256, sha256Hex, type HashVerification } from "@/lib/patchwork/verify";
import { formatCoordinate } from "@/lib/map/coordinates";
import { NOT_RECORDED } from "@/lib/inspector/format";
import { DECAY_COLORS, compassLabel, type PatchworkNodeSelection } from "@/lib/patchwork/nodes";

function formatTimestamp(iso: string | null): string {
  if (!iso) return NOT_RECORDED;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? NOT_RECORDED : d.toLocaleString();
}

type SnapState =
  | { status: "loading" }
  | { status: "no-parcel" }
  | { status: "error" }
  | { status: "ready"; result: SnapResult };

/** Looks up the CAGIS parcel under the node and snaps the pin to it (Turf.js). */
function usePinSnap(node: PatchworkNodeSelection): SnapState {
  const { node_id, lng, lat } = node;
  const [result, setResult] = useState<{ key: string; state: Exclude<SnapState, { status: "loading" }> } | null>(null);
  const key = `${node_id}:${lng}:${lat}`;

  useEffect(() => {
    const controller = new AbortController();
    queryParcelAtPoint({ lng, lat }, { signal: controller.signal })
      .then((parcel) => {
        if (controller.signal.aborted) return;
        const snap = parcel ? snapPointToParcel({ lng, lat }, parcel) : null;
        setResult({ key, state: snap ? { status: "ready", result: snap } : { status: "no-parcel" } });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        console.error("[maps-web] pin snap parcel lookup failed:", error);
        setResult({ key, state: { status: "error" } });
      });
    return () => controller.abort();
  }, [key, lng, lat]);

  return result?.key === key ? result.state : { status: "loading" };
}

function HashVerifier({ recorded }: { recorded: string | null }) {
  const [state, setState] = useState<{ fileName: string; verification: HashVerification } | { error: string } | null>(null);
  const recordedValid = isValidSha256(recorded);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const computed = await sha256Hex(await file.arrayBuffer());
      setState({ fileName: file.name, verification: compareHash(recorded, computed) });
    } catch (error) {
      console.error("[maps-web] evidence hashing failed:", error);
      setState({ error: "Could not read that file" });
    }
  };

  return (
    <div className="mt-2 border-t border-cornflower/40 pt-2">
      <div className="hud-label">Verify evidence (SHA-256)</div>
      {!recorded ? (
        <p className="mt-1 text-ink-muted">{NOT_RECORDED}: no hash to verify against</p>
      ) : !recordedValid ? (
        <p className="mt-1 text-ink-muted">Recorded hash is not a valid SHA-256 digest</p>
      ) : (
        <>
          <input
            type="file"
            aria-label="Evidence file to hash"
            onChange={(e) => void onFile(e.target.files?.[0])}
            className="mt-1 block w-full text-ink-muted file:mr-2 file:border file:border-cornflower file:bg-transparent file:px-1.5 file:text-ink-muted"
          />
          <p className="mt-0.5 text-[10px] text-ink-muted">Hashed locally in your browser; the file is never uploaded.</p>
          <div aria-live="polite" className="mt-1">
            {state && "error" in state && <span className="text-ink-muted">{state.error}</span>}
            {state && "verification" in state && state.verification.status === "match" && (
              <span style={{ color: DECAY_COLORS.green }}>✓ Matches recorded hash ({state.fileName})</span>
            )}
            {state && "verification" in state && state.verification.status === "mismatch" && (
              <span style={{ color: DECAY_COLORS.red }}>✗ Does not match recorded hash ({state.fileName})</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Details of a selected PatchWork node: azimuth, timestamp, hash verification, parcel-snapped pin. */
export function NodeDetails({ node }: { node: PatchworkNodeSelection }) {
  const { decay_state, az_heading, verified_at, verification_hash, expires_at_yellow, expires_at_red } = node;
  const snap = usePinSnap(node);

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
        <Row label="Parcel-snapped pin">
          {snap.status === "loading" && "Resolving parcel…"}
          {snap.status === "no-parcel" && "No CAGIS parcel at this location"}
          {snap.status === "error" && "Parcel lookup unavailable"}
          {snap.status === "ready" &&
            (snap.result.snapped
              ? `${formatCoordinate(snap.result.point)} (moved ${snap.result.distanceMeters.toFixed(1)} m)`
              : "On parcel, no adjustment needed")}
        </Row>
      </dl>
      <HashVerifier key={node.node_id} recorded={verification_hash} />
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
