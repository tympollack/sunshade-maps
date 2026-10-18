import { getServerSupabase } from "@/lib/supabase/server";
import { parseBBoxParam } from "@/lib/patchwork/nodes";
import {
  parseCellParam,
  sentimentRowsToFeatureCollection,
  viewportCells,
  type SentimentRow,
} from "@/lib/valerie/sentiment";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/spatial/valerie?bbox=west,south,east,north[&poll_id=<uuid>]
 * GET /api/spatial/valerie?h3=<res-7 cell>[&poll_id=<uuid>]   (single cell, used by the Inspector drawer)
 *
 * K-anonymous (N >= 10), commit-and-reveal-gated Project Valerie sentiment per H3 cell.
 * Requires the shared `.sunshade.icu` SSO session (the aggregation RPC is authenticated-only).
 * Returns hexagon polygons with mean Likert + mean confidence only - no user ids, GPS
 * points, comments or respondent counts. Cells under the threshold are simply absent.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const pollId = params.get("poll_id");
  if (pollId !== null && !UUID_RE.test(pollId)) {
    return Response.json({ error: "poll_id must be a UUID" }, { status: 400 });
  }

  const cellParam = params.get("h3");
  let cells: string[];
  if (cellParam !== null) {
    const cell = parseCellParam(cellParam);
    if (!cell.ok) {
      return Response.json({ error: cell.error }, { status: 400 });
    }
    cells = [cell.cell];
  } else {
    const parsed = parseBBoxParam(params.get("bbox"));
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    const cover = viewportCells(parsed.bbox);
    if (!cover.ok) {
      return Response.json({ error: cover.error }, { status: 400 });
    }
    cells = cover.cells;
  }

  const supabase = await getServerSupabase();
  if (!supabase) {
    return Response.json({ error: "Spatial backend is not configured" }, { status: 503 });
  }

  const { data: userData, error: authError } = await supabase.auth.getUser();
  if (authError || !userData.user) {
    return Response.json({ error: "Sign in to view community sentiment" }, { status: 401 });
  }

  const { data, error } = await supabase.schema("valerie").rpc("h3_sentiment_cells", {
    p_cells: cells,
    p_poll_id: pollId,
  });

  if (error) {
    console.error("[maps-web] valerie.h3_sentiment_cells failed:", error.message);
    return Response.json({ error: "Failed to load community sentiment" }, { status: 502 });
  }

  return Response.json(sentimentRowsToFeatureCollection((data ?? []) as SentimentRow[]), {
    // Per-user (session-gated) response: never shareable via CDN/proxy caches.
    headers: { "Cache-Control": "private, no-store" },
  });
}
