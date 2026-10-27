import type { DiscoveryJob, DiscoveryQueue } from "./resolveJurisdiction";

export interface CloudflareQueueConfig {
  accountId: string;
  /** Queue id (not name) of `gis-discovery-jobs`. */
  queueId: string;
  /** API token with Queues:Edit. Must come from the environment / a secret store. */
  apiToken: string;
  fetchImpl?: typeof fetch;
}

/**
 * Producer for runtimes without a Queues binding (e.g. the Next.js server) using Cloudflare's
 * "Push message" REST endpoint. Workers should pass their `env.GIS_DISCOVERY_JOBS` binding
 * directly instead - it satisfies {@link DiscoveryQueue} as-is.
 */
export function createCloudflareHttpQueue(config: CloudflareQueueConfig): DiscoveryQueue {
  const doFetch = config.fetchImpl ?? fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/queues/${encodeURIComponent(config.queueId)}/messages`;
  return {
    async send(message: DiscoveryJob): Promise<void> {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: message, content_type: "json" }),
      });
      if (!response.ok) {
        throw new Error(`Cloudflare Queues responded with HTTP ${response.status}`);
      }
      const payload = (await response.json().catch(() => null)) as { success?: boolean } | null;
      if (payload && payload.success === false) {
        throw new Error("Cloudflare Queues rejected the message");
      }
    },
  };
}

/** Builds the HTTP queue from env vars, or `undefined` when discovery dispatch isn't configured. */
export function cloudflareQueueFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): DiscoveryQueue | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const queueId = env.CLOUDFLARE_DISCOVERY_QUEUE_ID;
  const apiToken = env.CLOUDFLARE_QUEUES_API_TOKEN;
  if (!accountId || !queueId || !apiToken) return undefined;
  return createCloudflareHttpQueue({ accountId, queueId, apiToken, fetchImpl });
}
