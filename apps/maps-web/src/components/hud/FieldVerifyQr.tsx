"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { buildFieldVerifyUrl } from "@/lib/handoff/deeplink";
import type { PatchworkNodeSelection } from "@/lib/patchwork/nodes";

/** Outbound handoff: QR code that opens the selected node in the PatchWork mobile PWA. */
export function FieldVerifyQr({ node }: { node: PatchworkNodeSelection }) {
  const url = buildFieldVerifyUrl(process.env.NEXT_PUBLIC_PATCHWORK_URL, node.node_id, { lng: node.lng, lat: node.lat });
  const [qr, setQr] = useState<{ url: string; dataUrl: string } | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    QRCode.toDataURL(url, { margin: 1, width: 192, color: { dark: "#0B1B3A", light: "#FFFFFF" } })
      .then((dataUrl) => {
        if (!cancelled) setQr({ url, dataUrl });
      })
      .catch((error: unknown) => console.error("[maps-web] QR generation failed:", error));
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!url) return null;

  return (
    <section aria-label="Field verify" className="border-t border-cornflower/40 pt-2">
      <h3 className="hud-label">Field Verify</h3>
      <p className="mt-1 text-ink-muted">Scan on a phone to re-verify this node in the PatchWork app.</p>
      {qr?.url === url && (
        // eslint-disable-next-line @next/next/no-img-element -- generated data URL, nothing to optimise
        <img src={qr.dataUrl} alt="QR code opening this node in PatchWork" width={192} height={192} className="mt-1.5 bg-white" />
      )}
      <a href={url} className="mt-1 block break-all text-cyan underline">
        Open in PatchWork
      </a>
    </section>
  );
}
