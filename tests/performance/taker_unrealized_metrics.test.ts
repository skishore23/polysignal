import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { getPerformanceMetrics } from "../../apps/web/lib/performance";

const createSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE market_events (
      id TEXT PRIMARY KEY,
      title TEXT
    );
    CREATE TABLE markets (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      question TEXT,
      slug TEXT,
      taker_base_fee REAL
    );
    CREATE TABLE tokens (
      id TEXT PRIMARY KEY,
      market_id TEXT,
      fee_rate_bps INTEGER
    );
    CREATE TABLE latest_features (
      token_id TEXT PRIMARY KEY,
      ts INTEGER,
      mid REAL,
      staleness_sec REAL
    );
    CREATE TABLE shadow_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      wallet_id INTEGER,
      token_id TEXT,
      market_id TEXT,
      kind TEXT,
      side TEXT,
      execution_mode TEXT,
      decision TEXT,
      decision_reason TEXT,
      last_update_ts INTEGER
    );
    CREATE TABLE shadow_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      order_id INTEGER,
      price REAL,
      size REAL,
      method TEXT
    );
    CREATE TABLE decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      token_id TEXT,
      wallet_id INTEGER,
      decision TEXT,
      kind TEXT
    );
  `);
};

describe("Performance taker unrealized metrics", () => {
  it("includes taker unrealized in consolidated totals", () => {
    const db = new Database(":memory:");
    createSchema(db);
    const now = Date.now();
    db.prepare("INSERT INTO market_events (id, title) VALUES ('e1', 'BTC Event')").run();
    db.prepare(
      "INSERT INTO markets (id, event_id, question, slug, taker_base_fee) VALUES ('m1', 'e1', 'Will BTC be up in 5 minutes?', 'btc-5m', 0.1)"
    ).run();
    db.prepare("INSERT INTO tokens (id, market_id, fee_rate_bps) VALUES ('t1', 'm1', 2500)").run();
    db.prepare("INSERT INTO latest_features (token_id, ts, mid, staleness_sec) VALUES ('t1', ?, 0.6, 0)").run(now);
    db.prepare(
      `INSERT INTO shadow_orders
       (id, ts, wallet_id, token_id, kind, side, execution_mode, decision, decision_reason, last_update_ts, market_id)
       VALUES (1, ?, 1, 't1', 'TAKER_BUY', 'BUY', 'SHADOW', 'SUBMIT', 'seed', ?, 'm1')`
    ).run(now - 10_000, now - 10_000);
    db.prepare(
      `INSERT INTO shadow_fills (ts, order_id, price, size, method)
       VALUES (?, 1, 0.5, 10, 'taker_immediate')`
    ).run(now - 10_000);

    const metrics = getPerformanceMetrics(db as any, null);
    expect(metrics.taker.unrealizedPnl).toBeCloseTo(1, 6);
    expect(metrics.totalUnrealized).toBeCloseTo(metrics.maker.totalUnrealized + metrics.taker.unrealizedPnl, 6);
    expect(metrics.netPnl).toBeCloseTo(metrics.totalRealized + metrics.totalUnrealized, 6);
    db.close();
  });
});
