/** Message published to `gis-discovery-jobs` by `@sunshade/spatial` `resolveJurisdiction`. */
export interface DiscoveryJob {
  fips_code: string;
  county_name: string;
  state_code: string;
}

export type LayerType = "parcels" | "zoning" | "streets" | "auditor_search";

export const LAYER_TYPES: readonly LayerType[] = ["parcels", "zoning", "streets", "auditor_search"];

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Search engine abstraction (Google Programmable Search in production, a stub in tests). */
export interface SearchClient {
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
}

/** Candidate endpoints proposed by the LLM; every one is untrusted until probed. */
export type CandidateEndpoints = Partial<Record<LayerType, string[]>>;

/** LLM abstraction returning structured candidates for the supplied search results. */
export interface EndpointExtractor {
  extract(job: DiscoveryJob, results: readonly SearchResult[], signal?: AbortSignal): Promise<CandidateEndpoints>;
}

export type SourceFormat = "esri_feature" | "portal_link";

/** A candidate that survived probing, ready for `maps.jurisdiction_layers`. */
export interface VerifiedLayer {
  layer_type: LayerType;
  source_format: SourceFormat;
  endpoint_url: string;
  parcel_id_field: string | null;
  zoning_code_field: string | null;
  is_cors_enabled: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type DiscoveryOutcome =
  | { status: "active"; layers: VerifiedLayer[] }
  | { status: "failed"; reason: string };

/** Persistence abstraction (Supabase PostgREST in production). */
export interface DiscoveryStore {
  /** Upserts the jurisdiction + layers and sets `discovery_status`. */
  save(job: DiscoveryJob, outcome: DiscoveryOutcome): Promise<void>;
}
