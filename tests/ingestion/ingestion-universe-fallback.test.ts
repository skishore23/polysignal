import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BookStore } from "@polysignal/book";
import { IngestionEngine } from "../../apps/worker/src/ingestion/IngestionEngine.js";
import { createTempDb, destroyTempDb, type TempDb } from "../helpers/db-temp.js";

describe("IngestionEngine universe refresh strictness", () => {
  let tempDb: TempDb;

  beforeAll(async () => {
    tempDb = await createTempDb();
  });

  afterAll(async () => {
    await destroyTempDb(tempDb);
  });

  it("does not restore universe from DB rows when Gamma refresh fails", async () => {
    const now = Date.now();
    tempDb.sqlite
      .prepare(
        `INSERT INTO markets (id, condition_id, slug, question, active, volume, liquidity, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("m1", "c1", "market-1", "q", 1, 0, 0, now, now);
    tempDb.sqlite
      .prepare(
        `INSERT INTO tokens (id, market_id, outcome, name, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("t1", "m1", "Yes", "Yes", now);

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn()
    } as any;

    const engine = new IngestionEngine(
      {
        clobWsUrl: "wss://example.invalid/ws",
        universeRefreshSec: 300,
        topN: 10,
        activeTokenLimit: 0,
        activeTokenWindowMinutes: 30,
        clobEventsSampleRate: 0
      },
      {
        db: {},
        sqlite: tempDb.sqlite,
        logger,
        store: new BookStore()
      }
    );

    const err = new Error("fetch failed: read ECONNRESET");
    (engine as any).gamma = {
      getTopMarkets: vi.fn(async () => {
        throw err;
      })
    };

    const ok = await (engine as any).refreshUniverse();

    expect(ok).toBe(false);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "Universe refresh failed; restored universe from existing DB rows"
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: "fetch failed: read ECONNRESET"
      }),
      "Failed to refresh universe"
    );
  });
});
