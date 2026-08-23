import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDb, destroyTempDb, type TempDb } from "../helpers/db-temp.js";

// Migration 0026 dropped maker tables; re-create for this test which exercises maker query patterns
const createMakerTablesForTest = (db: { exec: (sql: string) => void }) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maker_pnl (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      realized REAL NOT NULL,
      unrealized REAL NOT NULL,
      position REAL NOT NULL,
      avg_entry REAL NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'SHADOW'
    );
    CREATE TABLE IF NOT EXISTS maker_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      bid_price REAL NOT NULL,
      ask_price REAL NOT NULL,
      bid_size REAL NOT NULL,
      ask_size REAL NOT NULL,
      reason TEXT NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'SHADOW'
    );
    CREATE TABLE IF NOT EXISTS maker_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'SHADOW'
    );
    CREATE TABLE IF NOT EXISTS maker_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      spread_capture REAL NOT NULL,
      inventory_skew REAL NOT NULL,
      q_min REAL NOT NULL,
      fill_rate REAL NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'SHADOW'
    );
  `);
};

const insertTestData = (db: any) => {
  const now = Date.now();
  const oneHourAgo = now - 3600000;

  // Insert wallets (using full schema from migrations)
  db.prepare(
    `INSERT INTO wallets (id, name, starting_balance, size_multiplier, max_open_positions, min_confidence, min_edge,
     auto_open_limit, auto_trade_enabled, maker_enabled, maker_quote_size, maker_quote_width_bps, maker_min_spread,
     maker_max_spread, maker_min_depth, maker_inventory_target, maker_inventory_max_abs, maker_inventory_skew_bps,
     maker_execution_mode, created_at)
     VALUES (?, ?, ?, 1, 5, 0, 0, 5, 1, ?, 50, 20, 0.002, 0.02, 20, 0, 500, 15, 'SHADOW', ?)`
  ).run(10, "Test-Wallet-1", 10000, 1, now);

  db.prepare(
    `INSERT INTO wallets (id, name, starting_balance, size_multiplier, max_open_positions, min_confidence, min_edge,
     auto_open_limit, auto_trade_enabled, maker_enabled, maker_quote_size, maker_quote_width_bps, maker_min_spread,
     maker_max_spread, maker_min_depth, maker_inventory_target, maker_inventory_max_abs, maker_inventory_skew_bps,
     maker_execution_mode, created_at)
     VALUES (?, ?, ?, 1, 5, 0, 0, 5, 1, ?, 50, 20, 0.002, 0.02, 20, 0, 500, 15, 'SHADOW', ?)`
  ).run(11, "Test-Wallet-2", 20000, 1, now);

  db.prepare(
    `INSERT INTO wallets (id, name, starting_balance, size_multiplier, max_open_positions, min_confidence, min_edge,
     auto_open_limit, auto_trade_enabled, maker_enabled, maker_quote_size, maker_quote_width_bps, maker_min_spread,
     maker_max_spread, maker_min_depth, maker_inventory_target, maker_inventory_max_abs, maker_inventory_skew_bps,
     maker_execution_mode, created_at)
     VALUES (?, ?, ?, 1, 5, 0, 0, 5, 1, ?, 50, 20, 0.002, 0.02, 20, 0, 500, 15, 'SHADOW', ?)`
  ).run(12, "Disabled-Wallet", 5000, 0, now);

  // Insert tokens and markets
  db.prepare("INSERT INTO markets (id, slug, question, updated_at, created_at) VALUES (?, ?, ?, ?, ?)").run("m1", "test-market-1", "Test Market 1", now, now);
  db.prepare("INSERT INTO markets (id, slug, question, updated_at, created_at) VALUES (?, ?, ?, ?, ?)").run("m2", "test-market-2", "Test Market 2", now, now);
  db.prepare("INSERT INTO tokens (id, market_id, outcome, updated_at) VALUES (?, ?, ?, ?)").run("t1", "m1", "Yes", now);
  db.prepare("INSERT INTO tokens (id, market_id, outcome, updated_at) VALUES (?, ?, ?, ?)").run("t2", "m2", "No", now);

  // Insert maker_pnl
  db.prepare(
    "INSERT INTO maker_pnl (wallet_id, token_id, ts, realized, unrealized, position, avg_entry, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(10, "t1", now, 100.50, 50.25, 10.0, 0.5, "SHADOW");
  db.prepare(
    "INSERT INTO maker_pnl (wallet_id, token_id, ts, realized, unrealized, position, avg_entry, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(10, "t2", now, 200.75, -25.50, -5.0, 0.6, "SHADOW");
  db.prepare(
    "INSERT INTO maker_pnl (wallet_id, token_id, ts, realized, unrealized, position, avg_entry, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(11, "t1", now, 150.00, 75.00, 15.0, 0.55, "SHADOW");

  // Insert maker_quotes
  db.prepare(
    "INSERT INTO maker_quotes (wallet_id, token_id, ts, bid_price, ask_price, bid_size, ask_size, reason, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(10, "t1", oneHourAgo, 0.49, 0.51, 10, 10, "spread", "SHADOW");
  db.prepare(
    "INSERT INTO maker_quotes (wallet_id, token_id, ts, bid_price, ask_price, bid_size, ask_size, reason, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(10, "t1", now, 0.495, 0.505, 10, 10, "spread", "SHADOW");
  db.prepare(
    "INSERT INTO maker_quotes (wallet_id, token_id, ts, bid_price, ask_price, bid_size, ask_size, reason, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(11, "t1", now, 0.50, 0.52, 15, 15, "spread", "SHADOW");

  // Insert maker_fills
  db.prepare("INSERT INTO maker_fills (wallet_id, token_id, ts, side, price, size, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    10, "t1", oneHourAgo, "BUY", 0.50, 5.0, "SHADOW"
  );
  db.prepare("INSERT INTO maker_fills (wallet_id, token_id, ts, side, price, size, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    10, "t1", now, "SELL", 0.51, 3.0, "SHADOW"
  );
  db.prepare("INSERT INTO maker_fills (wallet_id, token_id, ts, side, price, size, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    11, "t1", now, "BUY", 0.52, 10.0, "SHADOW"
  );

  // Insert maker_metrics
  db.prepare(
    "INSERT INTO maker_metrics (wallet_id, token_id, ts, spread_capture, inventory_skew, q_min, fill_rate, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(10, "t1", now, 0.004, -0.001, 25.5, 0.45, "SHADOW");
  db.prepare(
    "INSERT INTO maker_metrics (wallet_id, token_id, ts, spread_capture, inventory_skew, q_min, fill_rate, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(10, "t2", now, 0.003, 0.002, 20.0, 0.50, "SHADOW");
  db.prepare(
    "INSERT INTO maker_metrics (wallet_id, token_id, ts, spread_capture, inventory_skew, q_min, fill_rate, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(11, "t1", now, 0.005, -0.001, 30.0, 0.55, "SHADOW");
};

describe("verify-maker-wallet-performance script", () => {
  let tempDb: TempDb;

  beforeAll(async () => {
    tempDb = await createTempDb();
    createMakerTablesForTest(tempDb.sqlite);
    insertTestData(tempDb.sqlite);
  });

  afterAll(async () => {
    await destroyTempDb(tempDb);
  });

  describe("getWalletPnL query", () => {
    it("should return PnL for all maker-enabled wallets", () => {
      const rows = tempDb.sqlite
        .prepare(
          `SELECT
            w.id as walletId,
            w.name as walletName,
            w.starting_balance as startingBalance,
            COALESCE(SUM(p.realized), 0) as realized,
            COALESCE(SUM(p.unrealized), 0) as unrealized,
            COALESCE(SUM(p.realized + p.unrealized), 0) as total,
            CASE WHEN w.starting_balance > 0
              THEN COALESCE(SUM(p.realized + p.unrealized), 0) / w.starting_balance
              ELSE 0
            END as roi,
            COUNT(DISTINCT p.token_id) as tokenCount
          FROM wallets w
          LEFT JOIN (
            SELECT wallet_id, token_id, MAX(ts) as ts
            FROM maker_pnl
            GROUP BY wallet_id, token_id
          ) latest ON latest.wallet_id = w.id
          LEFT JOIN maker_pnl p ON p.wallet_id = latest.wallet_id AND p.token_id = latest.token_id AND p.ts = latest.ts
          WHERE w.maker_enabled = 1
          GROUP BY w.id
          ORDER BY roi DESC`
        )
        .all();

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        walletId: expect.any(Number),
        walletName: expect.any(String),
        startingBalance: expect.any(Number),
        realized: expect.any(Number),
        unrealized: expect.any(Number),
        total: expect.any(Number),
        roi: expect.any(Number),
        tokenCount: expect.any(Number)
      });
    });

    it("should return PnL for specific wallet when filtered", () => {
      const walletId = 10;
      const rows = tempDb.sqlite
        .prepare(
          `SELECT
            w.id as walletId,
            w.name as walletName,
            w.starting_balance as startingBalance,
            COALESCE(SUM(p.realized), 0) as realized,
            COALESCE(SUM(p.unrealized), 0) as unrealized,
            COALESCE(SUM(p.realized + p.unrealized), 0) as total,
            CASE WHEN w.starting_balance > 0
              THEN COALESCE(SUM(p.realized + p.unrealized), 0) / w.starting_balance
              ELSE 0
            END as roi,
            COUNT(DISTINCT p.token_id) as tokenCount
          FROM wallets w
          LEFT JOIN (
            SELECT wallet_id, token_id, MAX(ts) as ts
            FROM maker_pnl
            WHERE wallet_id = ?
            GROUP BY wallet_id, token_id
          ) latest ON latest.wallet_id = w.id
          LEFT JOIN maker_pnl p ON p.wallet_id = latest.wallet_id AND p.token_id = latest.token_id AND p.ts = latest.ts
          WHERE w.maker_enabled = 1 AND w.id = ?
          GROUP BY w.id
          ORDER BY roi DESC`
        )
        .all(walletId, walletId);

      expect(rows).toHaveLength(1);
      expect((rows[0] as any).walletId).toBe(10);
      expect((rows[0] as any).tokenCount).toBe(2);
    });

    it("should exclude non-maker-enabled wallets", () => {
      const rows = tempDb.sqlite
        .prepare(
          `SELECT w.id FROM wallets w WHERE w.maker_enabled = 1`
        )
        .all();

      const walletIds = rows.map((r: any) => r.id);
      expect(walletIds).not.toContain(12);
      expect(walletIds).toContain(10);
      expect(walletIds).toContain(11);
    });

    it("should handle wallets with no PnL data", () => {
      // Insert wallet with no PnL
      const now = Date.now();
      tempDb.sqlite.prepare(
        `INSERT INTO wallets (id, name, starting_balance, size_multiplier, max_open_positions, min_confidence, min_edge,
         auto_open_limit, auto_trade_enabled, maker_enabled, maker_quote_size, maker_quote_width_bps, maker_min_spread,
         maker_max_spread, maker_min_depth, maker_inventory_target, maker_inventory_max_abs, maker_inventory_skew_bps,
         maker_execution_mode, created_at)
         VALUES (?, ?, ?, 1, 5, 0, 0, 5, 1, ?, 50, 20, 0.002, 0.02, 20, 0, 500, 15, 'SHADOW', ?)`
      ).run(13, "Empty-Wallet", 5000, 1, now);

      const rows = tempDb.sqlite
        .prepare(
          `SELECT
            w.id as walletId,
            COALESCE(SUM(p.realized), 0) as realized,
            COALESCE(SUM(p.unrealized), 0) as unrealized
          FROM wallets w
          LEFT JOIN (
            SELECT wallet_id, token_id, MAX(ts) as ts
            FROM maker_pnl
            GROUP BY wallet_id, token_id
          ) latest ON latest.wallet_id = w.id
          LEFT JOIN maker_pnl p ON p.wallet_id = latest.wallet_id AND p.token_id = latest.token_id AND p.ts = latest.ts
          WHERE w.maker_enabled = 1 AND w.id = 13
          GROUP BY w.id`
        )
        .all();

      expect(rows).toHaveLength(1);
      expect((rows[0] as any).realized).toBe(0);
      expect((rows[0] as any).unrealized).toBe(0);
    });
  });

  describe("getWalletActivity query", () => {
    it("should return activity counts for all wallets", () => {
      const rows = tempDb.sqlite
        .prepare(
          `SELECT
            w.id as walletId,
            COALESCE(q.quotes, 0) as quotes,
            COALESCE(f.fills, 0) as fills,
            COALESCE(m.metrics, 0) as metrics
          FROM wallets w
          LEFT JOIN (
            SELECT
              wallet_id,
              COUNT(*) as quotes
            FROM maker_quotes
            GROUP BY wallet_id
          ) q ON q.wallet_id = w.id
          LEFT JOIN (
            SELECT
              wallet_id,
              COUNT(*) as fills
            FROM maker_fills
            GROUP BY wallet_id
          ) f ON f.wallet_id = w.id
          LEFT JOIN (
            SELECT
              wallet_id,
              COUNT(*) as metrics
            FROM maker_metrics
            GROUP BY wallet_id
          ) m ON m.wallet_id = w.id
          WHERE w.maker_enabled = 1
          GROUP BY w.id
          ORDER BY w.id`
        )
        .all();

      expect(rows.length).toBeGreaterThan(0);
      const wallet10 = rows.find((r: any) => r.walletId === 10) as any;
      expect(wallet10).toBeDefined();
      expect(wallet10.quotes).toBe(2);
      expect(wallet10.fills).toBe(2);
      expect(wallet10.metrics).toBe(2);
    });

    it("should return activity for specific wallet", () => {
      const walletId = 10;
      const rows = tempDb.sqlite
        .prepare(
          `SELECT
            w.id as walletId,
            COALESCE(q.quotes, 0) as quotes,
            COALESCE(f.fills, 0) as fills
          FROM wallets w
          LEFT JOIN (
            SELECT
              wallet_id,
              COUNT(*) as quotes
            FROM maker_quotes
            WHERE wallet_id = ?
            GROUP BY wallet_id
          ) q ON q.wallet_id = w.id
          LEFT JOIN (
            SELECT
              wallet_id,
              COUNT(*) as fills
            FROM maker_fills
            WHERE wallet_id = ?
            GROUP BY wallet_id
          ) f ON f.wallet_id = w.id
          WHERE w.maker_enabled = 1 AND w.id = ?
          GROUP BY w.id`
        )
        .all(walletId, walletId, walletId);

      expect(rows).toHaveLength(1);
      expect((rows[0] as any).quotes).toBe(2);
      expect((rows[0] as any).fills).toBe(2);
    });
  });

  describe("getWalletMetrics query", () => {
    it("should return average metrics for wallets", () => {
      const rows = tempDb.sqlite
        .prepare(
          `SELECT
            mm.wallet_id as walletId,
            AVG(mm.spread_capture) as avgSpreadCapture,
            AVG(mm.inventory_skew) as avgInventorySkew,
            AVG(mm.q_min) as avgQMin,
            AVG(mm.fill_rate) as avgFillRate,
            COUNT(DISTINCT mm.token_id) as tokenCount
          FROM maker_metrics mm
          INNER JOIN wallets w ON w.id = mm.wallet_id AND w.maker_enabled = 1
          GROUP BY mm.wallet_id
          ORDER BY mm.wallet_id`
        )
        .all();

      expect(rows.length).toBeGreaterThan(0);
      const wallet10 = rows.find((r: any) => r.walletId === 10) as any;
      expect(wallet10).toBeDefined();
      expect(wallet10.avgSpreadCapture).toBeCloseTo(0.0035, 4);
      expect(wallet10.tokenCount).toBe(2);
    });
  });

  describe("getTopPnLByToken query", () => {
    it("should return top PnL tokens ordered by total PnL", () => {
      const rows = tempDb.sqlite
        .prepare(
          `SELECT
            mp.wallet_id as walletId,
            mp.token_id as tokenId,
            mp.realized + mp.unrealized as totalPnL
          FROM (
            SELECT token_id, wallet_id, MAX(id) as maxId
            FROM maker_pnl
            GROUP BY token_id, wallet_id
          ) latest
          INNER JOIN maker_pnl mp ON mp.id = latest.maxId
          INNER JOIN wallets w ON w.id = mp.wallet_id AND w.maker_enabled = 1
          ORDER BY mp.realized + mp.unrealized DESC
          LIMIT ?`
        )
        .all(10);

      expect(rows.length).toBeGreaterThan(0);
      // Should be sorted descending
      for (let i = 1; i < rows.length; i++) {
        expect((rows[i - 1] as any).totalPnL).toBeGreaterThanOrEqual((rows[i] as any).totalPnL);
      }
    });

    it("should respect limit parameter", () => {
      const rows = tempDb.sqlite
        .prepare(
          `SELECT
            mp.wallet_id as walletId,
            mp.token_id as tokenId
          FROM (
            SELECT token_id, wallet_id, MAX(id) as maxId
            FROM maker_pnl
            GROUP BY token_id, wallet_id
          ) latest
          INNER JOIN maker_pnl mp ON mp.id = latest.maxId
          INNER JOIN wallets w ON w.id = mp.wallet_id AND w.maker_enabled = 1
          ORDER BY mp.realized + mp.unrealized DESC
          LIMIT ?`
        )
        .all(1);

      expect(rows.length).toBeLessThanOrEqual(1);
    });
  });

  describe("getRecentFills query", () => {
    it("should return fills ordered by timestamp descending", () => {
      const rows = tempDb.sqlite
        .prepare(
          `SELECT
            mf.wallet_id as walletId,
            mf.ts,
            mf.side,
            mf.price,
            mf.size
          FROM maker_fills mf
          JOIN wallets w ON w.id = mf.wallet_id
          WHERE w.maker_enabled = 1
          ORDER BY mf.ts DESC
          LIMIT ?`
        )
        .all(10);

      expect(rows.length).toBeGreaterThan(0);
      // Should be sorted descending by timestamp
      for (let i = 1; i < rows.length; i++) {
        expect((rows[i - 1] as any).ts).toBeGreaterThanOrEqual((rows[i] as any).ts);
      }
    });

    it("should filter by wallet when specified", () => {
      const walletId = 10;
      const rows = tempDb.sqlite
        .prepare(
          `SELECT
            mf.wallet_id as walletId
          FROM maker_fills mf
          JOIN wallets w ON w.id = mf.wallet_id
          WHERE w.maker_enabled = 1 AND mf.wallet_id = ?
          ORDER BY mf.ts DESC
          LIMIT ?`
        )
        .all(walletId, 10);

      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row: any) => {
        expect(row.walletId).toBe(walletId);
      });
    });
  });

  describe("edge cases", () => {
    it("should handle non-existent wallet ID gracefully", () => {
      const walletId = 999;
      const rows = tempDb.sqlite
        .prepare(
          `SELECT w.id FROM wallets w WHERE w.maker_enabled = 1 AND w.id = ?`
        )
        .all(walletId);

      expect(rows).toHaveLength(0);
    });

    it("should handle empty result sets", () => {
      const rows = tempDb.sqlite
        .prepare(
          `SELECT * FROM maker_pnl WHERE wallet_id = 999`
        )
        .all();

      expect(rows).toHaveLength(0);
    });

    it("should calculate ROI correctly for zero starting balance", () => {
      const now = Date.now();
      tempDb.sqlite.prepare(
        `INSERT INTO wallets (id, name, starting_balance, size_multiplier, max_open_positions, min_confidence, min_edge,
         auto_open_limit, auto_trade_enabled, maker_enabled, maker_quote_size, maker_quote_width_bps, maker_min_spread,
         maker_max_spread, maker_min_depth, maker_inventory_target, maker_inventory_max_abs, maker_inventory_skew_bps,
         maker_execution_mode, created_at)
         VALUES (?, ?, ?, 1, 5, 0, 0, 5, 1, ?, 50, 20, 0.002, 0.02, 20, 0, 500, 15, 'SHADOW', ?)`
      ).run(14, "Zero-Balance", 0, 1, now);

      tempDb.sqlite.prepare(
        "INSERT INTO maker_pnl (wallet_id, token_id, ts, realized, unrealized, position, avg_entry, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(14, "t1", now, 100, 50, 10, 0.5, "SHADOW");

      const rows = tempDb.sqlite
        .prepare(
          `SELECT
            CASE WHEN w.starting_balance > 0
              THEN COALESCE(SUM(p.realized + p.unrealized), 0) / w.starting_balance
              ELSE 0
            END as roi
          FROM wallets w
          LEFT JOIN (
            SELECT wallet_id, token_id, MAX(ts) as ts
            FROM maker_pnl
            GROUP BY wallet_id, token_id
          ) latest ON latest.wallet_id = w.id
          LEFT JOIN maker_pnl p ON p.wallet_id = latest.wallet_id AND p.token_id = latest.token_id AND p.ts = latest.ts
          WHERE w.maker_enabled = 1 AND w.id = 14
          GROUP BY w.id`
        )
        .all();

      expect((rows[0] as any).roi).toBe(0);
    });
  });
});
