"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useInspector, type ParcelSelection } from "@/components/map/InspectorContext";
import { NodeDetails, Row } from "@/components/hud/NodeInspector";
import { isAbortError } from "@/lib/gis/cagis";
import { formatCoordinate } from "@/lib/map/coordinates";
import { DECAY_COLORS } from "@/lib/patchwork/nodes";
import { sentimentColor } from "@/lib/valerie/sentiment";
import {
  NOT_RECORDED,
  formatAcres,
  formatBoolean,
  formatIsoDate,
  formatSigned,
  formatUsd,
} from "@/lib/inspector/format";
import {
  AUDIT_PAD_DEGREES,
  SignInRequiredError,
  fetchFloodZone,
  fetchNearbyAudits,
  fetchParcelDetails,
  fetchSentimentAt,
  type FloodZoneInfo,
  type NearbyAudits,
  type ParcelDetails,
} from "@/lib/inspector/report";
import type { SentimentCellProperties } from "@/lib/valerie/sentiment";

type Section<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "empty" }
  | { status: "auth" }
  | { status: "error"; message: string };

/**
 * Runs `load` whenever `key` changes (aborting the previous request). `null` key = not started yet.
 * `load` resolving `null` is the empty state. The result is tagged with its key so a stale
 * response is never shown for a newer selection (no synchronous setState inside the effect).
 */
function useSection<T>(key: string | null, load: (signal: AbortSignal) => Promise<T | null>): Section<T> {
  const [result, setResult] = useState<{ key: string; section: Exclude<Section<T>, { status: "loading" }> } | null>(null);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    load(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult({ key, section: data === null ? { status: "empty" } : { status: "ready", data } });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (error instanceof SignInRequiredError) {
          setResult({ key, section: { status: "auth" } });
          return;
        }
        console.error(`[maps-web] inspector section "${key}" failed:`, error);
        setResult({ key, section: { status: "error", message: error instanceof Error ? error.message : "Request failed" } });
      });
    return () => controller.abort();
  }, [key, load]);

  return key !== null && result?.key === key ? result.section : { status: "loading" };
}

function SectionCard<T>({
  title,
  section,
  emptyText,
  authText,
  children,
}: {
  title: string;
  section: Section<T>;
  emptyText: string;
  authText?: string;
  children: (data: T) => ReactNode;
}) {
  return (
    <section aria-label={title} className="border-t border-cornflower/40 pt-2">
      <h3 className="hud-label">{title}</h3>
      <div className="mt-1">
        {section.status === "loading" && <p className="text-ink-muted">Loading…</p>}
        {section.status === "empty" && <p className="text-ink-muted">{emptyText}</p>}
        {section.status === "auth" && <p className="text-ink-muted">{authText ?? "Sign in to view this section"}</p>}
        {section.status === "error" && <p className="text-ink-muted">Unavailable right now ({section.message})</p>}
        {section.status === "ready" && children(section.data)}
      </div>
    </section>
  );
}

/**
 * Slide-out technical drawer unifying everything known about the selected parcel / node:
 * ownership, zoning, tax assessment, FEMA flood risk, nearby PatchWork audits and Valerie sentiment.
 * Every section loads on demand and degrades to an explicit empty / sign-in / error state.
 */
export function InspectorDrawer() {
  const { selectedParcel, selectedNode, setSelectedParcel, setSelectedNode } = useInspector();
  if (!selectedParcel && !selectedNode) return null;

  return (
    <aside
      aria-label="Parcel inspector"
      className="hud-panel hud-drawer absolute bottom-20 left-4 top-24 flex w-80 max-w-[calc(100vw-2rem)] flex-col font-mono text-xs"
    >
      <header className="flex items-start justify-between gap-2 px-3 py-2">
        <div>
          <div className="hud-label">{selectedParcel ? "Parcel Inspector" : "PatchWork Node"}</div>
          {selectedParcel && (
            <div className="mt-0.5 text-ink">
              <div className="tabular-nums">PARCELID {selectedParcel.parcelId}</div>
              <div className="text-ink-muted">{selectedParcel.address ?? "No address on record"}</div>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setSelectedParcel(null);
            setSelectedNode(null);
          }}
          aria-label="Close inspector"
          className="border border-cornflower px-1.5 leading-5 text-ink-muted hover:text-cyan"
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {selectedParcel && <ParcelSections key={selectedParcel.parcelId} parcel={selectedParcel} />}
        {selectedNode && (
          <section aria-label="Selected PatchWork node" className="border-t border-cornflower/40 pt-2">
            <h3 className="hud-label">Selected PatchWork node</h3>
            <div className="mt-1">
              <NodeDetails node={selectedNode} />
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}

function ParcelSections({ parcel }: { parcel: ParcelSelection }) {
  const { setSelectedNode } = useInspector();
  const { parcelId, lngLat } = parcel;
  const { lng, lat } = lngLat;

  const loadDetails = useCallback((signal: AbortSignal) => fetchParcelDetails(parcelId, { signal }), [parcelId]);
  const details = useSection<ParcelDetails>(parcelId, loadDetails);

  const loadFlood = useCallback((signal: AbortSignal) => fetchFloodZone({ lng, lat }, { signal }), [lng, lat]);
  const flood = useSection<FloodZoneInfo>(`flood:${parcelId}`, loadFlood);

  const loadSentiment = useCallback((signal: AbortSignal) => fetchSentimentAt({ lng, lat }, { signal }), [lng, lat]);
  const sentiment = useSection<SentimentCellProperties>(`valerie:${parcelId}`, loadSentiment);

  // Audits need the parcel bounds; fall back to the clicked point if details are unavailable.
  const bounds = details.status === "ready" ? details.data.bounds : null;
  const [w, s, e, n] = bounds ?? [lng, lat, lng, lat];
  const loadAudits = useCallback(
    (signal: AbortSignal) => fetchNearbyAudits([w, s, e, n], { signal }),
    [w, s, e, n],
  );
  const audits = useSection<NearbyAudits>(details.status === "loading" ? null : `audits:${parcelId}:${w}:${s}:${e}:${n}`, loadAudits);

  return (
    <>
      <SectionCard title="Ownership" section={details} emptyText="No CAGIS record for this parcel">
        {(d) => (
          <dl className="space-y-1.5">
            <Row label="Owner">{d.owners.length > 0 ? d.owners.join(" / ") : NOT_RECORDED}</Row>
            <Row label="Mailing address">{d.ownerMailingAddress ?? NOT_RECORDED}</Row>
            <Row label="Last sale">
              {d.lastSaleDate || d.lastSaleAmount !== null
                ? `${formatIsoDate(d.lastSaleDate)} · ${formatUsd(d.lastSaleAmount)}`
                : NOT_RECORDED}
            </Row>
            <Row label="Land use class">{d.landUseClass ?? NOT_RECORDED}</Row>
            <Row label="Deeded acreage">{formatAcres(d.acres)}</Row>
          </dl>
        )}
      </SectionCard>

      <section aria-label="Zoning" className="border-t border-cornflower/40 pt-2">
        <h3 className="hud-label">Zoning</h3>
        <dl className="mt-1 space-y-1.5">
          <Row label="Designation">{parcel.zoningCode ?? NOT_RECORDED}</Row>
          <Row label="Description">{parcel.zoningDescription ?? NOT_RECORDED}</Row>
          <Row label="Jurisdiction">{parcel.zoningJurisdiction ?? NOT_RECORDED}</Row>
        </dl>
      </section>

      <SectionCard title="Tax assessment" section={details} emptyText="No assessment on record">
        {(d) => (
          <dl className="space-y-1.5">
            <Row label="Market value (total)">{formatUsd(d.marketTotalValue)}</Row>
            <Row label="Land / improvements">
              {d.marketLandValue === null && d.marketImprovementValue === null
                ? NOT_RECORDED
                : `${formatUsd(d.marketLandValue)} / ${formatUsd(d.marketImprovementValue)}`}
            </Row>
            <Row label="Annual taxes">{formatUsd(d.annualTaxes)}</Row>
            <Row label="Taxes paid">{formatUsd(d.taxesPaid)}</Row>
            <Row label="Delinquent taxes">{formatUsd(d.delinquentTaxes)}</Row>
            <Row label="Tax district">{d.taxDistrict ?? NOT_RECORDED}</Row>
            <Row label="School district">{d.schoolDistrict ?? NOT_RECORDED}</Row>
            <Row label="Homestead">{formatBoolean(d.homestead)}</Row>
            <Row label="Foreclosure">{formatBoolean(d.foreclosure)}</Row>
          </dl>
        )}
      </SectionCard>

      <SectionCard title="Flood risk (FEMA NFHL)" section={flood} emptyText="No FEMA-mapped flood zone at this location">
        {(f) => (
          <dl className="space-y-1.5">
            <Row label="Zone">{f.zone ?? NOT_RECORDED}</Row>
            <Row label="Classification">{f.subtype ?? NOT_RECORDED}</Row>
            <Row label="Special flood hazard area">{formatBoolean(f.specialFloodHazardArea)}</Row>
            <Row label="Base flood elevation">
              {f.baseFloodElevation === null ? NOT_RECORDED : `${f.baseFloodElevation.toFixed(1)} ft`}
            </Row>
          </dl>
        )}
      </SectionCard>

      <SectionCard
        title="PatchWork audits"
        section={audits}
        emptyText={`No verified audits within ~${Math.round(AUDIT_PAD_DEGREES * 111_000)} m of this parcel`}
      >
        {(a) =>
          a.nodes.length === 0 ? (
            <p className="text-ink-muted">{`No verified audits within ~${Math.round(AUDIT_PAD_DEGREES * 111_000)} m of this parcel`}</p>
          ) : (
            <ul className="space-y-1">
              {a.nodes.map((node) => (
                <li key={node.node_id}>
                  <button
                    type="button"
                    onClick={() => setSelectedNode(node)}
                    className="flex w-full items-center justify-between gap-2 border border-cornflower/40 px-2 py-1 text-left text-ink hover:border-cyan"
                  >
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="inline-block h-2 w-2" style={{ backgroundColor: DECAY_COLORS[node.decay_state] }} />
                      <span className="uppercase">{node.decay_state === "unknown" ? "no expiry" : node.decay_state}</span>
                    </span>
                    <span className="text-ink-muted">{formatCoordinate({ lng: node.lng, lat: node.lat })}</span>
                  </button>
                </li>
              ))}
              {a.truncated && <li className="text-ink-muted">More audits exist than are listed; zoom in.</li>}
            </ul>
          )
        }
      </SectionCard>

      <SectionCard
        title="Community sentiment (Valerie)"
        section={sentiment}
        emptyText="No community sentiment published for this area"
        authText="Sign in to view community sentiment"
      >
        {(c) => (
          <dl className="space-y-1.5">
            <Row label="Mean sentiment (−2 … +2)">
              <span className="flex items-center gap-2">
                <span aria-hidden className="inline-block h-2.5 w-2.5" style={{ backgroundColor: sentimentColor(c.avg_likert) }} />
                {formatSigned(c.avg_likert)}
              </span>
            </Row>
            <Row label="Mean confidence">{`${c.avg_confidence.toFixed(0)}%`}</Row>
            <Row label="Coverage">H3 resolution 7 (~5 km²), anonymised</Row>
          </dl>
        )}
      </SectionCard>
    </>
  );
}
