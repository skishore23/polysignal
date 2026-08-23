import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDb, destroyTempDb, type TempDb } from "../helpers/db-temp.js";
import {
  computeMarkovRegimeReport,
  computeStrategyRegimeReport,
  type RegimeConfig
} from "../../packages/data/src/regimeAnalysis.js";

describe("Regime report filtering", () => {
  let tempDb: TempDb;

  beforeAll(async () => {
    tempDb = await createTempDb();
  });

  afterAll(async () => {
    await destroyTempDb(tempDb);
  });

  it("excludes non-actionable rows from strategy and markov evidence outputs", () => {
    const baseTs = Date.now() - 900_000;
    const sinceTs = baseTs - 60_000;

    tempDb.sqlite
      .prepare(
        `INSERT INTO features
         (ts, token_id, spread, bid_depth_top, ask_depth_top, obi, vol30m, microprice_minus_mid)
         VALUES
         (?, ?, ?, ?, ?, ?, ?, ?),
         (?, ?, ?, ?, ?, ?, ?, ?),
         (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        baseTs - 2_000,
        "token-regime",
        0.01,
        120,
        120,
        0.1,
        0.02,
        0.0005,
        baseTs + 2_000,
        "token-regime",
        0.015,
        160,
        160,
        0.15,
        0.03,
        0.0008,
        baseTs + 5_000,
        "token-regime",
        0.02,
        180,
        180,
        0.2,
        0.04,
        0.001
      );

    const takerOrder = tempDb.sqlite
      .prepare(
        `INSERT INTO shadow_orders
         (ts, wallet_id, token_id, side, kind, execution_mode, price, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(baseTs, 3, "token-regime", "BUY", "TAKER_BUY", "SHADOW", 0.5, 10);
    const takerOrderId = Number(takerOrder.lastInsertRowid);

    const maintenanceOrder = tempDb.sqlite
      .prepare(
        `INSERT INTO shadow_orders
         (ts, wallet_id, token_id, side, kind, execution_mode, price, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(baseTs + 1_000, 3, "token-regime", "SELL", "INVENTORY_REBALANCE", "SHADOW", 0.5, 10);
    const maintenanceOrderId = Number(maintenanceOrder.lastInsertRowid);

    const takerFill = tempDb.sqlite
      .prepare(
        `INSERT INTO shadow_fills (ts, order_id, price, size, method, note)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(baseTs, takerOrderId, 0.5, 10, "taker_immediate", "taker fill");
    const takerFillId = Number(takerFill.lastInsertRowid);

    const maintenanceFill = tempDb.sqlite
      .prepare(
        `INSERT INTO shadow_fills (ts, order_id, price, size, method, note)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(baseTs + 1_000, maintenanceOrderId, 0.5, 10, "inventory_rebalance", "maintenance fill");
    const maintenanceFillId = Number(maintenanceFill.lastInsertRowid);

    tempDb.sqlite
      .prepare(
        `INSERT INTO shadow_markouts
         (fill_id, ts, horizon_ms, mid_at_fill, mid_at_horizon, markout_bps)
         VALUES
         (?, ?, 300000, 0.5, 0.5010, 20),
         (?, ?, 300000, 0.5, 0.5020, 40)`
      )
      .run(takerFillId, baseTs, maintenanceFillId, baseTs + 1_000);

    const config: RegimeConfig = {
      sinceTs,
      horizonMs: 300_000,
      bins: 3,
      stepMs: 1_000,
      sampleLimit: 10_000,
      features: ["spread", "depth", "obi", "vol", "micro"]
    };

    const strategy = computeStrategyRegimeReport(tempDb.sqlite, config);
    expect(strategy.rows.some((row) => row.kind === "INVENTORY_REBALANCE")).toBe(false);
    expect(strategy.rows.some((row) => row.kind === "TAKER_BUY")).toBe(true);

    const markov = computeMarkovRegimeReport(tempDb.sqlite, config);
    const totalStateMarkoutCount = Object.values(markov.states).reduce(
      (sum, row) => sum + (row.markout?.count ?? 0),
      0
    );

    // Only the actionable TAKER_BUY markout should remain in regime evidence.
    expect(totalStateMarkoutCount).toBe(1);
  });
});
