import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, runMigrations } from "@polysignal/storage";

let dbRef: any = null;
let sqliteRef: any = null;

vi.mock("../../apps/web/lib/db", () => ({
  getDb: () => {
    if (!dbRef || !sqliteRef) throw new Error("DB test harness not initialized");
    return { db: dbRef, sqlite: sqliteRef };
  }
}));

vi.mock("../../apps/web/lib/config", () => ({
  appConfig: {
    wallet: {
      startingBalance: 10000,
      sizeMultiplier: 1,
      maxOpenPositions: 5,
      minConfidence: 0.65,
      minEdge: 0.01,
      autoOpenLimit: 5
    }
  }
}));

describe("/api/wallets market filter", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "wallet-route-test-"));
    dbPath = path.join(tmpDir, "test.db");
    const { sqlite, db } = openDatabase(dbPath);
    runMigrations(sqlite, path.join(process.cwd(), "packages", "storage", "migrations"));
    sqliteRef = sqlite;
    dbRef = db;
  });

  afterEach(() => {
    if (sqliteRef) sqliteRef.close();
    sqliteRef = null;
    dbRef = null;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts valid marketFilter payloads and persists normalized JSON", async () => {
    const route = await import("../../apps/web/app/api/wallets/route");
    const req = new Request("http://localhost/api/wallets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Wallet Filter Valid",
        marketFilter: {
          version: 1,
          includeMarketIds: [" 553868 ", "553838"],
          minVolumeUsd: 1000000,
          requireActive: true,
          allowedKinds: ["TAKER_BUY", "TAKER_SELL"]
        }
      })
    });

    const res = await route.POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const row = sqliteRef
      .prepare("SELECT market_filter_json as marketFilterJson FROM wallets WHERE id = ?")
      .get(body.id) as { marketFilterJson: string | null } | undefined;

    expect(row?.marketFilterJson).toBeTruthy();
    const parsed = row?.marketFilterJson ? JSON.parse(row.marketFilterJson) : null;
    expect(parsed).toEqual({
      version: 1,
      includeMarketIds: ["553868", "553838"],
      minVolumeUsd: 1000000,
      requireActive: true,
      allowedKinds: ["TAKER_BUY", "TAKER_SELL"]
    });
  });

  it("rejects invalid marketFilter payloads", async () => {
    const route = await import("../../apps/web/app/api/wallets/route");
    const req = new Request("http://localhost/api/wallets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Wallet Filter Invalid",
        marketFilter: {
          version: 1,
          minVolumeUsd: "not-a-number"
        }
      })
    });

    const res = await route.POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("returns parsed marketFilter object in GET responses", async () => {
    sqliteRef
      .prepare(
        `INSERT INTO wallets (
           name, starting_balance, size_multiplier, max_open_positions, min_confidence, min_edge,
           auto_open_limit, auto_trade_enabled, taker_side, maker_enabled, maker_quote_size, maker_quote_width_bps,
           maker_min_spread, maker_max_spread, maker_min_depth, maker_inventory_target, maker_inventory_max_abs,
           maker_inventory_band, maker_inventory_skew_bps, maker_inventory_skew_size, maker_execution_mode, created_at,
           market_filter_json
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SHADOW', ?, ?
         )`
      )
      .run(
        "Wallet Filter GET",
        10000,
        1,
        5,
        0.65,
        0.01,
        5,
        1,
        "BOTH",
        0,
        50,
        20,
        0.002,
        0.02,
        20,
        0,
        500,
        200,
        15,
        0.5,
        Date.now(),
        JSON.stringify({ version: 1, minLiquidityUsd: 250000, requireActive: true })
      );

    const route = await import("../../apps/web/app/api/wallets/route");
    const res = await route.GET();
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ name: string; marketFilter?: unknown; marketFilterJson?: string | null }>;
    const wallet = rows.find((row) => row.name === "Wallet Filter GET");
    expect(wallet).toBeTruthy();
    expect(wallet?.marketFilter).toEqual({ version: 1, minLiquidityUsd: 250000, requireActive: true });
    expect(typeof wallet?.marketFilterJson).toBe("string");
  });
});
