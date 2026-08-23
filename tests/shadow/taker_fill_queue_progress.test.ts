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

describe("ShadowExecutionLoop taker fill queue progress", () => {
  const opened: TempDb[] = [];

  afterAll(async () => {
    await Promise.all(opened.map((db) => destroyTempDb(db)));
  });

  it("fills a new open taker order even when many historical taker orders are already FILLED", async () => {
    const tempDb = await createTempDb();
    opened.push(tempDb);

    const sqlite = tempDb.sqlite;
    const baseTs = 1_780_000_000_000;
    const insertFilled = sqlite.prepare(
      `INSERT INTO shadow_orders
       (ts, wallet_id, token_id, side, kind, execution_mode, price, size, status, filled_size, filled_price, last_update_ts)
       VALUES (?, ?, ?, ?, ?, 'SHADOW', ?, ?, 'FILLED', ?, ?, ?)`
    );

    sqlite.exec("BEGIN");
    for (let i = 0; i < 5100; i += 1) {
      const ts = baseTs + i;
      const price = 0.5;
      const size = 10;
      insertFilled.run(ts, 1, `token-hist-${i}`, "BUY", "TAKER_BUY", price, size, size, price, ts);
    }
    sqlite.exec("COMMIT");

    const openOrderId = Number(
      sqlite
        .prepare(
          `INSERT INTO shadow_orders
           (ts, wallet_id, token_id, side, kind, execution_mode, price, size, status, filled_size, last_update_ts)
           VALUES (?, ?, ?, ?, ?, 'SHADOW', ?, ?, 'OPEN', 0, ?)`
        )
        .run(baseTs + 10_000, 1, "token-open", "BUY", "TAKER_BUY", 0.42, 7, baseTs + 10_000).lastInsertRowid
    );

    const loop = new ShadowExecutionLoop(
      {
        intervalMs: 1_000,
        makerStalenessSec: 120,
        markoutHorizonsMs: [300_000],
        makerQueueFillProb: 1,
        makerPriceToleranceBps: 0,
        forceSyntheticFills: false,
        rebalanceEnabled: false
      },
      { sqlite, logger: noopLogger }
    );

    (loop as any).processTakerOrders();

    const order = sqlite
      .prepare(`SELECT status, filled_size as filledSize, filled_price as filledPrice FROM shadow_orders WHERE id = ?`)
      .get(openOrderId) as { status: string; filledSize: number; filledPrice: number | null };
    expect(order.status).toBe("FILLED");
    expect(order.filledSize).toBeCloseTo(7);
    expect(order.filledPrice).toBeCloseTo(0.42);

    const fills = sqlite
      .prepare(`SELECT COUNT(*) as c FROM shadow_fills WHERE order_id = ? AND method = 'taker_immediate'`)
      .get(openOrderId) as { c: number };
    expect(fills.c).toBe(1);
  });
});
