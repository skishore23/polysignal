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

describe("ShadowExecutionLoop partial fill lifecycle", () => {
  const opened: TempDb[] = [];

  afterAll(async () => {
    await Promise.all(opened.map((db) => destroyTempDb(db)));
  });

  it("accumulates partial fills until order reaches FILLED", async () => {
    const tempDb = await createTempDb();
    opened.push(tempDb);

    const baseTs = 1_770_000_000_000;
    const orderId = Number(
      tempDb.sqlite
        .prepare(
          `INSERT INTO shadow_orders
           (ts, wallet_id, token_id, side, kind, execution_mode, price, size, expected_cancel_ts, status, filled_size)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(baseTs, 7, "token-partial", "BUY", "MAKER_BID", "SHADOW", 0.5, 10, baseTs + 60_000, "OPEN", 0)
        .lastInsertRowid
    );

    tempDb.sqlite
      .prepare(
        `INSERT INTO clob_events
         (recv_ts_ms, conn_id, token_id, msg_type, payload_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        baseTs + 1_000,
        "conn-1",
        "token-partial",
        "trade",
        JSON.stringify({
          price: 0.5,
          size: 4,
          side: "SELL",
          timestamp: baseTs + 1_000
        })
      );
    tempDb.sqlite
      .prepare(
        `INSERT INTO clob_events
         (recv_ts_ms, conn_id, token_id, msg_type, payload_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        baseTs + 2_000,
        "conn-2",
        "token-partial",
        "trade",
        JSON.stringify({
          price: 0.5,
          size: 6,
          side: "SELL",
          timestamp: baseTs + 2_000
        })
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
      { sqlite: tempDb.sqlite, logger: noopLogger }
    );

    (loop as any).processTrades();
    (loop as any).processTrades();

    const fills = tempDb.sqlite
      .prepare(`SELECT size FROM shadow_fills WHERE order_id = ? ORDER BY id ASC`)
      .all(orderId) as Array<{ size: number }>;
    expect(fills).toHaveLength(2);
    expect(fills[0]?.size).toBeCloseTo(4);
    expect(fills[1]?.size).toBeCloseTo(6);

    const order = tempDb.sqlite
      .prepare(`SELECT status, filled_size as filledSize, filled_price as filledPrice FROM shadow_orders WHERE id = ?`)
      .get(orderId) as { status: string; filledSize: number; filledPrice: number | null };
    expect(order.status).toBe("FILLED");
    expect(order.filledSize).toBeCloseTo(10);
    expect(order.filledPrice).toBeCloseTo(0.5);
  });

  it("does not fill orders already in terminal status", async () => {
    const tempDb = await createTempDb();
    opened.push(tempDb);

    const baseTs = 1_770_100_000_000;
    const orderId = Number(
      tempDb.sqlite
        .prepare(
          `INSERT INTO shadow_orders
           (ts, wallet_id, token_id, side, kind, execution_mode, price, size, expected_cancel_ts, status, filled_size)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(baseTs, 9, "token-cancelled", "BUY", "MAKER_BID", "SHADOW", 0.55, 5, baseTs + 60_000, "CANCELLED", 0)
        .lastInsertRowid
    );

    tempDb.sqlite
      .prepare(
        `INSERT INTO clob_events
         (recv_ts_ms, conn_id, token_id, msg_type, payload_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        baseTs + 1_000,
        "conn-3",
        "token-cancelled",
        "trade",
        JSON.stringify({
          price: 0.55,
          size: 5,
          side: "SELL",
          timestamp: baseTs + 1_000
        })
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
      { sqlite: tempDb.sqlite, logger: noopLogger }
    );

    (loop as any).processTrades();

    const fills = tempDb.sqlite
      .prepare(`SELECT COUNT(*) as c FROM shadow_fills WHERE order_id = ?`)
      .get(orderId) as { c: number };
    expect(fills.c).toBe(0);
  });
});
