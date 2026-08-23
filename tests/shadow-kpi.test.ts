import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDb, destroyTempDb, type TempDb } from "./helpers/db-temp.js";
import { getShadowKpi } from "../apps/web/lib/shadowKpi.js";

describe("getShadowKpi", () => {
  let tempDb: TempDb;

  beforeAll(async () => {
    tempDb = await createTempDb();
  });

  afterAll(async () => {
    await destroyTempDb(tempDb);
  });

  it("returns status=empty and emptyReason when 0 lane rows (no shadow fills for filter)", () => {
    const kpi = getShadowKpi(tempDb.sqlite, {
      windowHours: 24,
      horizonMs: 600_000,
      lane: "policy_v0",
      bucket: "spread_200p"
    });
    expect(kpi.status).toBe("empty");
    expect(kpi.emptyReason).toContain("Lane filter returned 0 rows");
    expect(kpi.diagnostics).toBeDefined();
    expect(kpi.diagnostics!.laneRows).toBe(0);
    expect(kpi.diagnostics!.markoutRows).toBe(0);
    expect(kpi.updatedAt).toBeDefined();
    expect(kpi.filters).toEqual({
      lane: "policy_v0",
      bucket: "spread_200p",
      horizonMs: 600_000,
      windowHours: 24
    });
  });

  it("returns status=error and error.code when DB throws", () => {
    const throwingSqlite = {
      prepare: () => ({
        all: () => {
          throw new Error("DB connection lost");
        }
      })
    };
    const kpi = getShadowKpi(throwingSqlite as Parameters<typeof getShadowKpi>[0], {
      windowHours: 24,
      horizonMs: 300_000
    });
    expect(kpi.status).toBe("error");
    expect(kpi.error).toBeDefined();
    expect(kpi.error!.code).toBe("SHADOW_KPI_ERROR");
    expect(kpi.error!.message).toContain("DB connection lost");
    expect(kpi.updatedAt).toBeDefined();
    expect(kpi.filters).toEqual({ horizonMs: 300_000, windowHours: 24 });
  });

  it("policy_v0 + spread_200p includes only policy v0 rows with spread evidence", async () => {
    const localDb = await createTempDb();
    try {
      const baseTs = Date.now() - 900_000;

      const makerOrder = localDb.sqlite
        .prepare(
          `INSERT INTO shadow_orders
           (ts, wallet_id, token_id, side, kind, execution_mode, price, size, spread_bps)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(baseTs, 1, "token-maker", "BUY", "MAKER_BID", "SHADOW", 0.5, 10, 120);
      const makerOrderId = Number(makerOrder.lastInsertRowid);

      const takerOrder = localDb.sqlite
        .prepare(
          `INSERT INTO shadow_orders
           (ts, wallet_id, token_id, side, kind, execution_mode, price, size, spread_bps)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(baseTs + 1_000, 1, "token-taker", "SELL", "TAKER_SELL", "SHADOW", 0.5, 10, 120);
      const takerOrderId = Number(takerOrder.lastInsertRowid);

      const makerFill = localDb.sqlite
        .prepare(
          `INSERT INTO shadow_fills (ts, order_id, price, size, method, note)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(baseTs, makerOrderId, 0.5, 10, "trade_match", "maker fill");
      const makerFillId = Number(makerFill.lastInsertRowid);

      const takerFill = localDb.sqlite
        .prepare(
          `INSERT INTO shadow_fills (ts, order_id, price, size, method, note)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(baseTs + 1_000, takerOrderId, 0.5, 10, "taker_immediate", "taker fill");
      const takerFillId = Number(takerFill.lastInsertRowid);

      localDb.sqlite
        .prepare(
          `INSERT INTO shadow_markouts
           (fill_id, ts, horizon_ms, mid_at_fill, mid_at_horizon, markout_bps)
           VALUES
           (?, ?, 300000, 0.5, 0.5005, 10),
           (?, ?, 300000, 0.5, 0.5010, 20)`
        )
        .run(makerFillId, baseTs, takerFillId, baseTs + 1_000);

      const kpi = getShadowKpi(localDb.sqlite, {
        windowHours: 24,
        horizonMs: 300_000,
        lane: "policy_v0",
        bucket: "spread_200p"
      });

      expect(kpi.status).toBe("ok");
      expect(kpi.diagnostics?.laneRows).toBe(1);
      expect(kpi.nFills).toBe(1);
      expect(kpi.nMarkouts).toBe(1);
    } finally {
      await destroyTempDb(localDb);
    }
  });
});
