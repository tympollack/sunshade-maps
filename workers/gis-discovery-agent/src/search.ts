import type { DiscoveryJob, FetchLike, SearchClient, SearchResult } from "./types";

/** Queries required by the discovery spec, in priority order. */
export function discoveryQueries(job: DiscoveryJob): string[] {
  return [
    `${job.county_name} County ${job.state_code} GIS parcel FeatureServer REST`,
    `${job.county_name} County auditor property search`,
  ];
}

interface GoogleItem {
  title?: string;
  link?: string;
  snippet?: string;
}

/** Google Programmable Search (Custom Search JSON API). Keys come from worker secrets only. */
export function createGoogleSearchClient(config: { apiKey: string; engineId: string; fetchImpl?: FetchLike }): SearchClient {
  const doFetch: FetchLike = config.fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    async search(query, signal) {
      const params = new URLSearchParams({ key: config.apiKey, cx: config.engineId, q: query, num: "5" });
      const response = await doFetch(`https://www.googleapis.com/customsearch/v1?${params.toString()}`, { signal });
      if (!response.ok) throw new Error(`Search API responded with HTTP ${response.status}`);
      const body = (await response.json()) as { items?: GoogleItem[] };
      return (body.items ?? [])
        .filter((i): i is GoogleItem & { link: string } => typeof i.link === "string")
        .map((i) => ({ title: i.title ?? "", url: i.link, snippet: i.snippet ?? "" }));
    },
  };
}

/** Runs every discovery query and returns the top 5 de-duplicated results. */
export async function gatherResults(search: SearchClient, job: DiscoveryJob, signal?: AbortSignal): Promise<SearchResult[]> {
  const settled = await Promise.allSettled(discoveryQueries(job).map((q) => search.search(q, signal)));
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  // Interleave so both queries contribute to the top 5.
  const lists = settled.map((s) => (s.status === "fulfilled" ? s.value : []));
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i += 1) {
    for (const list of lists) {
      const item = list[i];
      if (item && !seen.has(item.url)) {
        seen.add(item.url);
        merged.push(item);
      }
    }
  }
  if (merged.length === 0 && settled.every((s) => s.status === "rejected")) {
    throw new Error("All search queries failed");
  }
  return merged.slice(0, 5);
}
