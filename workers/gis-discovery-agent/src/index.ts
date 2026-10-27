import { discoverJurisdiction, parseJob } from "./discover";
import { createGeminiExtractor } from "./extract";
import { createGoogleSearchClient } from "./search";
import { createSupabaseStore } from "./store";

/** Secrets/config bound to the worker (see wrangler.toml). Never hardcode these. */
export interface Env {
  SEARCH_API_KEY: string;
  SEARCH_ENGINE_ID: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

/** Minimal structural types so the worker needs no @cloudflare/workers-types dependency. */
interface QueueMessage {
  body: unknown;
  ack(): void;
  retry(): void;
}
interface QueueBatch {
  messages: readonly QueueMessage[];
}

function missingConfig(env: Partial<Env>): string[] {
  const required: (keyof Env)[] = [
    "SEARCH_API_KEY",
    "SEARCH_ENGINE_ID",
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  return required.filter((k) => !env[k]);
}

export default {
  async queue(batch: QueueBatch, env: Env): Promise<void> {
    const missing = missingConfig(env);
    if (missing.length > 0) {
      // Misconfiguration is not the message's fault: retry later instead of dropping jobs.
      console.error(`[gis-discovery-agent] missing config: ${missing.join(", ")}`);
      batch.messages.forEach((m) => m.retry());
      return;
    }

    const deps = {
      search: createGoogleSearchClient({ apiKey: env.SEARCH_API_KEY, engineId: env.SEARCH_ENGINE_ID }),
      extractor: createGeminiExtractor({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }),
      store: createSupabaseStore({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY }),
      fetchImpl: (input: string, init?: RequestInit) => fetch(input, init),
    };

    for (const message of batch.messages) {
      const job = parseJob(message.body);
      if (!job) {
        console.error("[gis-discovery-agent] dropping malformed job");
        message.ack();
        continue;
      }
      try {
        const outcome = await discoverJurisdiction(job, deps);
        console.log(`[gis-discovery-agent] ${job.fips_code} ${job.county_name}, ${job.state_code}: ${outcome.status}`);
        message.ack();
      } catch (error) {
        console.error(`[gis-discovery-agent] ${job.fips_code} failed:`, error instanceof Error ? error.message : error);
        message.retry();
      }
    }
  },
};
