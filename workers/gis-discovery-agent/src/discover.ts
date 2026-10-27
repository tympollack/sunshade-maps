import { gatherResults } from "./search";
import { verifyCandidates } from "./probe";
import type {
  DiscoveryJob,
  DiscoveryOutcome,
  DiscoveryStore,
  EndpointExtractor,
  FetchLike,
  SearchClient,
} from "./types";

export interface DiscoveryDeps {
  search: SearchClient;
  extractor: EndpointExtractor;
  store: DiscoveryStore;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}

const STATE_RE = /^[A-Z]{2}$/;
const FIPS_RE = /^\d{5}$/;
const NAME_RE = /^[\p{L}\p{N} .'’&-]{1,80}$/u;

/** Validates an untrusted queue message body. */
export function parseJob(body: unknown): DiscoveryJob | null {
  if (typeof body !== "object" || body === null) return null;
  const { fips_code, county_name, state_code } = body as Record<string, unknown>;
  if (typeof fips_code !== "string" || !FIPS_RE.test(fips_code)) return null;
  if (typeof state_code !== "string" || !STATE_RE.test(state_code)) return null;
  if (typeof county_name !== "string" || !NAME_RE.test(county_name.trim())) return null;
  return { fips_code, county_name: county_name.trim(), state_code };
}

/**
 * search -> LLM extraction -> endpoint probing -> persist. Throws on infrastructure failures
 * (search/LLM/DB down) so the queue retries; "nothing usable found" is a normal `failed` outcome.
 */
export async function discoverJurisdiction(job: DiscoveryJob, deps: DiscoveryDeps): Promise<DiscoveryOutcome> {
  const results = await gatherResults(deps.search, job, deps.signal);
  const candidates = results.length > 0 ? await deps.extractor.extract(job, results, deps.signal) : {};
  const layers = await verifyCandidates(deps.fetchImpl, candidates);

  const outcome: DiscoveryOutcome =
    layers.length > 0
      ? { status: "active", layers }
      : { status: "failed", reason: results.length === 0 ? "no search results" : "no verifiable endpoints" };

  await deps.store.save(job, outcome);
  return outcome;
}
