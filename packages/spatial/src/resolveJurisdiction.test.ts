import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEDUPE_TTL_MS,
  InvalidCoordinateError,
  resetDispatchCache,
  resolveJurisdiction,
  type DiscoveryJob,
  type DiscoveryQueue,
  type JurisdictionDb,
  type JurisdictionResolution,
} from "./resolveJurisdiction";
import { createSupabaseJurisdictionDb } from "./supabaseDb";
import { cloudflareQueueFromEnv, createCloudflareHttpQueue } from "./cloudflareQueue";

const HAMILTON: JurisdictionResolution = { fips_code: "39061", county_name: "Hamilton", state_code: "OH", is_registered: true };
const OWSLEY: JurisdictionResolution = { fips_code: "21189", county_name: "Owsley", state_code: "KY", is_registered: false };

function dbReturning(value: JurisdictionResolution | null): JurisdictionDb & { resolveCounty: ReturnType<typeof vi.fn> } {
  return { resolveCounty: vi.fn(async () => value) };
}

function queueMock(): DiscoveryQueue & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(async (_job: DiscoveryJob) => undefined) };
}

beforeEach(() => resetDispatchCache());

describe("resolveJurisdiction", () => {
  it("returns the county without dispatching when it is registered", async () => {
    const queue = queueMock();
    const result = await resolveJurisdiction({ lng: -84.512, lat: 39.1031 }, { db: dbReturning(HAMILTON), queue });
    expect(result).toEqual(HAMILTON);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("publishes a discovery job for an unregistered county", async () => {
    const queue = queueMock();
    const result = await resolveJurisdiction({ lng: -83.7, lat: 37.4 }, { db: dbReturning(OWSLEY), queue });
    expect(result).toEqual(OWSLEY);
    await Promise.resolve();
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith({ fips_code: "21189", county_name: "Owsley", state_code: "KY" });
  });

  it("does not wait for the queue before responding", async () => {
    let release: () => void = () => undefined;
    const queue: DiscoveryQueue = { send: () => new Promise<void>((resolve) => (release = resolve)) };
    const pending: Promise<unknown>[] = [];
    const result = await resolveJurisdiction({ lng: -83.7, lat: 37.4 }, {
      db: dbReturning(OWSLEY),
      queue,
      waitUntil: (p) => pending.push(p),
    });
    // Resolved even though the publish is still outstanding.
    expect(result?.fips_code).toBe("21189");
    expect(pending).toHaveLength(1);
    release();
    await Promise.all(pending);
  });

  it("swallows publish failures, reports them, and allows a retry", async () => {
    const queue = queueMock();
    queue.send.mockRejectedValueOnce(new Error("queue down"));
    const onDispatchError = vi.fn();
    const pending: Promise<unknown>[] = [];
    const deps = { db: dbReturning(OWSLEY), queue, onDispatchError, waitUntil: (p: Promise<unknown>) => pending.push(p) };

    await expect(resolveJurisdiction({ lng: -83.7, lat: 37.4 }, deps)).resolves.toEqual(OWSLEY);
    await Promise.all(pending);
    expect(onDispatchError).toHaveBeenCalledTimes(1);

    // The failed publish released the claim, so the next request tries again.
    await resolveJurisdiction({ lng: -83.7, lat: 37.4 }, deps);
    await Promise.all(pending);
    expect(queue.send).toHaveBeenCalledTimes(2);
  });

  it("survives a queue that throws synchronously or a throwing error reporter", async () => {
    const queue: DiscoveryQueue = {
      send: () => {
        throw new Error("binding missing");
      },
    };
    const pending: Promise<unknown>[] = [];
    await expect(
      resolveJurisdiction({ lng: -83.7, lat: 37.4 }, {
        db: dbReturning(OWSLEY),
        queue,
        onDispatchError: () => {
          throw new Error("reporter bug");
        },
        waitUntil: (p) => pending.push(p),
      }),
    ).resolves.toEqual(OWSLEY);
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });

  it("throttles repeat jobs for the same county until the TTL elapses", async () => {
    const queue = queueMock();
    let now = 1_000;
    const deps = { db: dbReturning(OWSLEY), queue, now: () => now };
    await resolveJurisdiction({ lng: -83.7, lat: 37.4 }, deps);
    await resolveJurisdiction({ lng: -83.71, lat: 37.41 }, deps);
    await Promise.resolve();
    expect(queue.send).toHaveBeenCalledTimes(1);

    now += DEFAULT_DEDUPE_TTL_MS + 1;
    await resolveJurisdiction({ lng: -83.7, lat: 37.4 }, deps);
    await Promise.resolve();
    expect(queue.send).toHaveBeenCalledTimes(2);
  });

  it("works without a queue configured", async () => {
    await expect(resolveJurisdiction({ lng: -83.7, lat: 37.4 }, { db: dbReturning(OWSLEY) })).resolves.toEqual(OWSLEY);
  });

  it("returns null (and never dispatches) when no county covers the point", async () => {
    const queue = queueMock();
    expect(await resolveJurisdiction({ lng: -40, lat: 30 }, { db: dbReturning(null), queue })).toBeNull();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("propagates database failures instead of treating them as unregistered", async () => {
    const queue = queueMock();
    const db: JurisdictionDb = {
      resolveCounty: async () => {
        throw new Error("db down");
      },
    };
    await expect(resolveJurisdiction({ lng: 0, lat: 0 }, { db, queue })).rejects.toThrow("db down");
    expect(queue.send).not.toHaveBeenCalled();
  });

  it.each([
    [{ lng: Number.NaN, lat: 0 }],
    [{ lng: 0, lat: Number.POSITIVE_INFINITY }],
    [{ lng: 181, lat: 0 }],
    [{ lng: 0, lat: -91 }],
  ])("rejects invalid coordinate %j before querying", async (point) => {
    const db = dbReturning(HAMILTON);
    await expect(resolveJurisdiction(point, { db })).rejects.toBeInstanceOf(InvalidCoordinateError);
    expect(db.resolveCounty).not.toHaveBeenCalled();
  });
});

describe("createSupabaseJurisdictionDb", () => {
  function clientWith(result: { data: unknown; error: { message: string } | null }) {
    const rpc = vi.fn(async (_fn: "resolve_jurisdiction", _args: { p_lng: number; p_lat: number }) => result);
    const schema = vi.fn((_name: "maps") => ({ rpc }));
    return { client: { schema }, rpc, schema };
  }

  it("calls maps.resolve_jurisdiction with lng/lat and returns the first row", async () => {
    const { client, rpc, schema } = clientWith({ data: [HAMILTON], error: null });
    expect(await createSupabaseJurisdictionDb(client).resolveCounty({ lng: -84.5, lat: 39.1 })).toEqual(HAMILTON);
    expect(schema).toHaveBeenCalledWith("maps");
    expect(rpc).toHaveBeenCalledWith("resolve_jurisdiction", { p_lng: -84.5, p_lat: 39.1 });
  });

  it("maps an empty result to null", async () => {
    const { client } = clientWith({ data: [], error: null });
    expect(await createSupabaseJurisdictionDb(client).resolveCounty({ lng: 0, lat: 0 })).toBeNull();
  });

  it("throws on RPC errors and malformed rows", async () => {
    await expect(
      createSupabaseJurisdictionDb(clientWith({ data: null, error: { message: "boom" } }).client).resolveCounty({ lng: 0, lat: 0 }),
    ).rejects.toThrow("boom");
    await expect(
      createSupabaseJurisdictionDb(clientWith({ data: [{ fips_code: 1 }], error: null }).client).resolveCounty({ lng: 0, lat: 0 }),
    ).rejects.toThrow("unexpected row shape");
  });
});

describe("Cloudflare HTTP queue", () => {
  const job: DiscoveryJob = { fips_code: "21189", county_name: "Owsley", state_code: "KY" };

  it("posts a JSON message with a bearer token", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const queue = createCloudflareHttpQueue({ accountId: "acct", queueId: "q1", apiToken: "tok", fetchImpl: fetchImpl as typeof fetch });
    await queue.send(job);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/queues/q1/messages");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init?.body as string)).toEqual({ body: job, content_type: "json" });
  });

  it("throws on HTTP failure or success:false", async () => {
    const failing = createCloudflareHttpQueue({
      accountId: "a",
      queueId: "q",
      apiToken: "t",
      fetchImpl: (async () => new Response("no", { status: 403 })) as typeof fetch,
    });
    await expect(failing.send(job)).rejects.toThrow("403");
    const rejected = createCloudflareHttpQueue({
      accountId: "a",
      queueId: "q",
      apiToken: "t",
      fetchImpl: (async () => new Response(JSON.stringify({ success: false }), { status: 200 })) as typeof fetch,
    });
    await expect(rejected.send(job)).rejects.toThrow("rejected");
  });

  it("is only created when all env vars are present", () => {
    expect(cloudflareQueueFromEnv({})).toBeUndefined();
    expect(cloudflareQueueFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_DISCOVERY_QUEUE_ID: "q" })).toBeUndefined();
    expect(
      cloudflareQueueFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_DISCOVERY_QUEUE_ID: "q", CLOUDFLARE_QUEUES_API_TOKEN: "t" }),
    ).toBeDefined();
  });
});
