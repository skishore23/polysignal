import { afterEach, describe, expect, it, vi } from "vitest";
import { GammaClient } from "../../packages/data/src/gamma.js";

describe("GammaClient retry behavior", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("retries transient ECONNRESET and succeeds", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        const err = new Error("fetch failed: read ECONNRESET");
        (err as Error & { code?: string }).code = "ECONNRESET";
        throw err;
      }
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: "m1",
            slug: "market-1",
            question: "q",
            active: true,
            closed: false,
            liquidity: 100,
            volume: 1000,
            conditionId: "c1",
            clobTokenIds: ["t1", "t2"]
          }
        ]
      } as Response;
    }) as typeof fetch;

    const logger = {
      info: vi.fn(),
      warn: vi.fn()
    };

    const client = new GammaClient();
    const rows = await client.getTopMarkets({ limit: 1, logger });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenIds).toEqual(["t1", "t2"]);
    expect(calls).toBe(3);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("does not retry on non-retriable 4xx", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return {
        ok: false,
        status: 400,
        text: async () => "bad request"
      } as Response;
    }) as typeof fetch;

    const client = new GammaClient();
    await expect(client.getTopMarkets({ limit: 1 })).rejects.toThrow(/Gamma API error: 400/);
    expect(calls).toBe(1);
  });
});
