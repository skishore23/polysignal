import { afterAll, describe, expect, it } from "vitest";
import { ShadowExecutionLoop } from "../../apps/worker/src/shadow/ShadowExecutionLoop.js";
import { createTempDb, destroyTempDb, type TempDb } from "../helpers/db-temp.js";

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  child: () => noopLogger
} as any;

const seedScenario = (tempDb: TempDb, baseTs: number) => {
  tempDb.sqlite
    .prepare(
      `INSERT INTO shadow_orders
       (ts, wallet_id, token_id, side, kind, execution_mode, price, size, expected_cancel_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(baseTs, 7, "token-det", "BUY", "MAKER_BID", "SHADOW", 0.5, 10, baseTs + 10_000);

  tempDb.sqlite
    .prepare(
      `INSERT INTO clob_events
       (recv_ts_ms, conn_id, token_id, msg_type, payload_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      baseTs + 500,
      "conn-a",
      "token-det",
      "trade",
      JSON.stringify({
        price: 0.5,
        size: 10,
        side: "SELL",
        timestamp: Math.floor((baseTs + 500) / 1000)
      })
    );
};

describe("ShadowExecutionLoop deterministic trade_match gating", () => {
  const opened: TempDb[] = [];

  afterAll(async () => {
    await Promise.all(opened.map((db) => destroyTempDb(db)));
  });

  it("produces identical fill outcomes for identical order/trade tuples", async () => {
    const outcomes: number[] = [];
    const baseTs = 1_700_000_000_000;

    for (let i = 0; i < 8; i++) {
      const tempDb = await createTempDb();
      opened.push(tempDb);
      seedScenario(tempDb, baseTs);

      const loop = new ShadowExecutionLoop(
        {
          intervalMs: 1_000,
          makerStalenessSec: 120,
          markoutHorizonsMs: [300_000],
          makerQueueFillProb: 0.5,
          makerPriceToleranceBps: 0,
          forceSyntheticFills: false,
          rebalanceEnabled: false
        },
        { sqlite: tempDb.sqlite, logger: noopLogger }
      );

      (loop as any).processTrades();

      const fills = tempDb.sqlite
        .prepare(`SELECT COUNT(*) as c FROM shadow_fills WHERE method = 'trade_match'`)
        .get() as { c: number };
      outcomes.push(fills.c);
    }

    expect(new Set(outcomes).size).toBe(1);
  });
});
