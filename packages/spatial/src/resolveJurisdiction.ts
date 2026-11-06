/**
 * Administrative resolution for incoming coordinates.
 *
 * Resolves a WGS84 point to its US county via PostGIS `ST_Contains` against the Census TIGER
 * boundaries in `maps.us_counties` (see `maps.resolve_jurisdiction`). When the county has no
 * ACTIVE registry entry (`is_registered === false`) an asynchronous discovery job is published
 * to the Cloudflare Queue `gis-discovery-jobs`. Publishing never blocks or fails the caller.
 */

export const DISCOVERY_QUEUE_NAME = "gis-discovery-jobs";

export interface JurisdictionResolution {
  fips_code: string;
  county_name: string;
  state_code: string;
  is_registered: boolean;
}

/** Message body consumed by `workers/gis-discovery-agent`. */
export interface DiscoveryJob {
  fips_code: string;
  county_name: string;
  state_code: string;
}

export interface LngLatPoint {
  lng: number;
  lat: number;
}

/** Data source for the county lookup (Supabase RPC in production, a stub in tests). */
export interface JurisdictionDb {
  /** Resolves to `null` when no county covers the point (offshore / outside the US). */
  resolveCounty(point: LngLatPoint, signal?: AbortSignal): Promise<JurisdictionResolution | null>;
}

/** Structural match for a Cloudflare Queues producer binding (`env.GIS_DISCOVERY_JOBS`). */
export interface DiscoveryQueue {
  send(message: DiscoveryJob): Promise<void>;
}

export interface ResolveJurisdictionDeps {
  db: JurisdictionDb;
  /** Omit to disable discovery dispatch (e.g. queue not configured in this environment). */
  queue?: DiscoveryQueue;
  /**
   * Keeps the dispatch alive after the response is sent (`ctx.waitUntil` on Workers,
   * `after()` on Next.js). Without it the publish is still fire-and-forget.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Called when publishing fails; the failure never reaches the caller. */
  onDispatchError?: (error: unknown, job: DiscoveryJob) => void;
  /** Suppress repeat jobs for the same county within this window. Default 15 minutes. */
  dedupeTtlMs?: number;
  signal?: AbortSignal;
  /** Injectable clock for tests. */
  now?: () => number;
}

export const DEFAULT_DEDUPE_TTL_MS = 15 * 60 * 1000;

/**
 * Per-isolate dedupe of in-flight / recently published jobs. This is a best-effort throttle so a
 * busy unregistered county doesn't enqueue one job per request; the worker is idempotent anyway.
 */
const recentlyDispatched = new Map<string, number>();

/** Test helper: forget dispatch history. */
export function resetDispatchCache(): void {
  recentlyDispatched.clear();
}

export class InvalidCoordinateError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCoordinateError";
  }
}

export function assertValidPoint(point: LngLatPoint): void {
  const { lng, lat } = point;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new InvalidCoordinateError("lng and lat must be finite numbers");
  }
  if (lng < -180 || lng > 180) throw new InvalidCoordinateError("lng must be within [-180, 180]");
  if (lat < -90 || lat > 90) throw new InvalidCoordinateError("lat must be within [-90, 90]");
}

function claimDispatch(fips: string, now: number, ttl: number): boolean {
  for (const [key, expires] of recentlyDispatched) {
    if (expires <= now) recentlyDispatched.delete(key);
  }
  if (recentlyDispatched.has(fips)) return false;
  recentlyDispatched.set(fips, now + ttl);
  return true;
}

function dispatchDiscovery(resolution: JurisdictionResolution, deps: ResolveJurisdictionDeps): void {
  const { queue } = deps;
  if (!queue) return;
  const now = (deps.now ?? Date.now)();
  if (!claimDispatch(resolution.fips_code, now, deps.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS)) return;

  const job: DiscoveryJob = {
    fips_code: resolution.fips_code,
    county_name: resolution.county_name,
    state_code: resolution.state_code,
  };

  // `send` may throw synchronously (misconfigured binding) - normalise into a rejected promise.
  const publish = Promise.resolve()
    .then(() => queue.send(job))
    .catch((error: unknown) => {
      // Let a later request retry instead of being throttled by a failed publish.
      recentlyDispatched.delete(job.fips_code);
      try {
        deps.onDispatchError?.(error, job);
      } catch {
        // An error reporter must never break resolution.
      }
    });

  deps.waitUntil?.(publish);
}

/**
 * Resolves `point` to its county. Resolves `null` when no county covers it. Throws
 * {@link InvalidCoordinateError} for out-of-range input and propagates database failures
 * (a failed lookup must never be reported as "unregistered", or it would trigger discovery).
 */
export async function resolveJurisdiction(
  point: LngLatPoint,
  deps: ResolveJurisdictionDeps,
): Promise<JurisdictionResolution | null> {
  assertValidPoint(point);
  const resolution = await deps.db.resolveCounty(point, deps.signal);
  if (!resolution) return null;
  if (!resolution.is_registered) dispatchDiscovery(resolution, deps);
  return resolution;
}
