import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryMocks = {
  getUniverseSnapshot: vi.fn(() => [])
};

let latestFeatureTs: number | null = null;

vi.doMock("../../apps/web/lib/queries", () => queryMocks);
vi.doMock("../../apps/web/lib/db", () => ({
  getDb: () => ({
    sqlite: {
      prepare: () => ({
        get: () => ({ maxTs: latestFeatureTs })
      })
    }
  })
}));

const createRequest = () => {
  const controller = new AbortController();
  const request = new Request("http://localhost/api/stream/markets?limit=200", {
    signal: controller.signal
  });
  return { request, controller };
};

const readFirstPayload = async (handler: (req: Request) => Promise<Response>) => {
  const { request, controller } = createRequest();
  const response = await handler(request);
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  controller.abort();
  await reader.cancel();
  const decoded = new TextDecoder().decode(value ?? new Uint8Array());
  const chunk = decoded.split("\n\n")[0];
  if (!chunk) throw new Error("Expected SSE chunk");
  const payloadText = chunk.startsWith("data: ") ? chunk.slice("data: ".length) : chunk;
  return JSON.parse(payloadText);
};

describe("Markets SSE health", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    latestFeatureTs = null;
    queryMocks.getUniverseSnapshot.mockReturnValue([]);
    const module = await import("../../apps/web/app/api/stream/markets/route");
    handler = module.GET;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("marks feed stale when latest feature timestamp is missing", async () => {
    latestFeatureTs = null;
    const payload = await readFirstPayload(handler);
    expect(payload.meta.feedFreshnessSec).toBe(999);
    expect(payload.rows).toEqual([]);
  });

  it("reports fresh feed when latest feature timestamp is current", async () => {
    latestFeatureTs = Date.now();
    const payload = await readFirstPayload(handler);
    expect(payload.meta.feedFreshnessSec).toBeLessThanOrEqual(1);
    expect(payload.rows).toEqual([]);
  });
});
