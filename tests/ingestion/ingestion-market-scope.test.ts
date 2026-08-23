import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BookStore } from "@polysignal/book";
import { IngestionEngine } from "../../apps/worker/src/ingestion/IngestionEngine.js";
import { createTempDb, destroyTempDb, type TempDb } from "../helpers/db-temp.js";

describe("IngestionEngine market scope filtering", () => {
  let tempDb: TempDb;

  beforeAll(async () => {
    tempDb = await createTempDb();
  });

  afterAll(async () => {
    await destroyTempDb(tempDb);
  });

  it("keeps only known-profile fee-enabled markets in PROFILE_KNOWN_ONLY scope", async () => {
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
        clobEventsSampleRate: 0,
        marketScope: "PROFILE_KNOWN_ONLY"
      },
      {
        db: {},
        sqlite: tempDb.sqlite,
        logger,
        store: new BookStore()
      }
    );

    (engine as any).gamma = {
      getTopMarkets: vi.fn(async () => [
        {
          market: {
            id: "m_crypto",
            slug: "btc-15m",
            question: "Will BTC be up in 15 minutes?",
            active: true,
            closed: false,
            liquidity: 1_000,
            volume: 10_000,
            conditionId: "c1",
            clobTokenIds: ["t1", "t2"],
            events: [{ id: "e1", title: "Bitcoin 15 minute market" }]
          },
          conditionId: "c1",
          tokenIds: ["t1", "t2"]
        },
        {
          market: {
            id: "m_unknown",
            slug: "macro",
            question: "Will CPI surprise this month?",
            active: true,
            closed: false,
            liquidity: 1_000,
            volume: 10_000,
            conditionId: "c2",
            clobTokenIds: ["t3", "t4"],
            events: [{ id: "e2", title: "Macro event" }]
          },
          conditionId: "c2",
          tokenIds: ["t3", "t4"]
        }
      ])
    };
    (engine as any).rest = {
      getMarket: vi.fn(async () => ({
        minimum_order_size: 1,
        minimum_tick_size: 0.001,
        maker_base_fee: 0,
        taker_base_fee: 0,
        rewards: { min_size: 1, max_spread: 3.5, rates: null }
      })),
      getFeeRateBps: vi.fn(async () => 2500)
    };

    const ok = await (engine as any).refreshUniverse();
    expect(ok).toBe(true);
    expect(engine.getTrackedTokenIds().sort()).toEqual(["t1", "t2"]);
    expect(engine.getTrackedConditionIds()).toEqual(["c1"]);
  });

  it("keeps all modeled fee-enabled profiles in PROFILE_KNOWN_ONLY scope", async () => {
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
        clobEventsSampleRate: 0,
        marketScope: "PROFILE_KNOWN_ONLY"
      },
      {
        db: {},
        sqlite: tempDb.sqlite,
        logger,
        store: new BookStore()
      }
    );

    (engine as any).gamma = {
      getTopMarkets: vi.fn(async () => [
        {
          market: {
            id: "m_15m",
            slug: "btc-15m",
            question: "Will BTC be up in 15 minutes?",
            active: true,
            closed: false,
            liquidity: 1_000,
            volume: 10_000,
            conditionId: "c15",
            clobTokenIds: ["t15_1", "t15_2"],
            events: [{ id: "e15", title: "Bitcoin 15 minute market" }]
          },
          conditionId: "c15",
          tokenIds: ["t15_1", "t15_2"]
        },
        {
          market: {
            id: "m_5m",
            slug: "btc-updown-5m-1771063500",
            question: "Bitcoin Up or Down - February 14, 5:05AM-5:10AM ET",
            category: "crypto",
            active: true,
            closed: false,
            liquidity: 1_000,
            volume: 10_000,
            conditionId: "c5",
            clobTokenIds: ["t5_1", "t5_2"],
            events: [{ id: "e5", title: "Bitcoin 5 minute market" }]
          },
          conditionId: "c5",
          tokenIds: ["t5_1", "t5_2"]
        },
        {
          market: {
            id: "m_sports",
            slug: "serie-a",
            question: "Will Team A win?",
            active: true,
            closed: false,
            liquidity: 1_000,
            volume: 10_000,
            conditionId: "cS",
            clobTokenIds: ["ts_1", "ts_2"],
            events: [{ id: "eS", title: "Serie A Match" }]
          },
          conditionId: "cS",
          tokenIds: ["ts_1", "ts_2"]
        }
      ])
    };
    (engine as any).rest = {
      getMarket: vi.fn(async () => ({
        minimum_order_size: 1,
        minimum_tick_size: 0.001,
        maker_base_fee: 0,
        taker_base_fee: 0,
        rewards: { min_size: 1, max_spread: 3.5, rates: null }
      })),
      getFeeRateBps: vi.fn(async () => 2500)
    };

    const ok = await (engine as any).refreshUniverse();
    expect(ok).toBe(true);
    expect(engine.getTrackedTokenIds().sort()).toEqual(["t15_1", "t15_2", "t5_1", "t5_2", "ts_1", "ts_2"]);
    expect(engine.getTrackedConditionIds().sort()).toEqual(["c15", "c5", "cS"]);
  });

  it("includes wallet-pinned markets even when missing from top-N", async () => {
    const now = Date.now();
    tempDb.sqlite
      .prepare(
        `INSERT INTO wallets (name, starting_balance, size_multiplier, max_open_positions, min_confidence, min_edge, auto_open_limit, auto_trade_enabled, maker_enabled, maker_execution_mode, market_filter_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "Pinned Wallet",
        10000,
        1,
        5,
        0.5,
        0.01,
        5,
        1,
        0,
        "SHADOW",
        JSON.stringify({ includeMarketIds: ["1371892"] }),
        now
      );

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
        topN: 1,
        activeTokenLimit: 0,
        activeTokenWindowMinutes: 30,
        clobEventsSampleRate: 0,
        marketScope: "ALL"
      },
      {
        db: {},
        sqlite: tempDb.sqlite,
        logger,
        store: new BookStore()
      }
    );

    (engine as any).gamma = {
      getTopMarkets: vi.fn(async () => []),
      getMarketsByIds: vi.fn(async () => [
        {
          market: {
            id: "1371892",
            slug: "btc-updown-5m-1771063500",
            question: "Bitcoin Up or Down - February 14, 5:05AM-5:10AM ET",
            category: "crypto",
            active: true,
            closed: false,
            liquidity: 1000,
            volume: 1000,
            conditionId: "c5",
            clobTokenIds: ["t5_yes", "t5_no"],
            events: [{ id: "e5", title: "Bitcoin Up or Down 5 minute" }]
          },
          conditionId: "c5",
          tokenIds: ["t5_yes", "t5_no"]
        }
      ])
    };

    (engine as any).rest = {
      getMarket: vi.fn(async () => ({
        minimum_order_size: 1,
        minimum_tick_size: 0.001,
        maker_base_fee: 0,
        taker_base_fee: 0.25,
        rewards: { min_size: 1, max_spread: 3.5, rates: null }
      })),
      getFeeRateBps: vi.fn(async () => 2500)
    };

    const ok = await (engine as any).refreshUniverse();
    expect(ok).toBe(true);
    expect((engine as any).gamma.getMarketsByIds).toHaveBeenCalledWith(["1371892"], logger);
    expect(engine.getTrackedTokenIds().sort()).toEqual(["t5_no", "t5_yes"]);
    expect(engine.getTrackedConditionIds()).toEqual(["c5"]);
  });

  it("retains wallet-pinned tokens when active token filtering is enabled", async () => {
    tempDb.sqlite.prepare("DELETE FROM wallets").run();
    const now = Date.now();
    tempDb.sqlite
      .prepare(
        `INSERT INTO wallets (name, starting_balance, size_multiplier, max_open_positions, min_confidence, min_edge, auto_open_limit, auto_trade_enabled, maker_enabled, maker_execution_mode, market_filter_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "Pinned Wallet (active-filter)",
        10000,
        1,
        5,
        0.5,
        0.01,
        5,
        1,
        0,
        "SHADOW",
        JSON.stringify({ includeMarketIds: ["m_pinned"] }),
        now
      );

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
        topN: 2,
        activeTokenLimit: 1,
        activeTokenWindowMinutes: 30,
        clobEventsSampleRate: 0,
        marketScope: "ALL"
      },
      {
        db: {},
        sqlite: tempDb.sqlite,
        logger,
        store: new BookStore()
      }
    );

    (engine as any).tokenLastSeenTs.set("t_active_yes", Date.now());
    (engine as any).gamma = {
      getTopMarkets: vi.fn(async () => [
        {
          market: {
            id: "m_active",
            slug: "btc-15m",
            question: "Will BTC be up in 15 minutes?",
            active: true,
            closed: false,
            liquidity: 1000,
            volume: 1000,
            conditionId: "c_active",
            clobTokenIds: ["t_active_yes", "t_active_no"],
            events: [{ id: "e_active", title: "Bitcoin 15 minute market" }]
          },
          conditionId: "c_active",
          tokenIds: ["t_active_yes", "t_active_no"]
        },
        {
          market: {
            id: "m_pinned",
            slug: "btc-updown-5m-1771063500",
            question: "Bitcoin Up or Down - February 14, 5:05AM-5:10AM ET",
            category: "crypto",
            active: true,
            closed: false,
            liquidity: 1000,
            volume: 1000,
            conditionId: "c_pinned",
            clobTokenIds: ["t_pin_yes", "t_pin_no"],
            events: [{ id: "e_pinned", title: "Bitcoin Up or Down 5 minute" }]
          },
          conditionId: "c_pinned",
          tokenIds: ["t_pin_yes", "t_pin_no"]
        }
      ]),
      getMarketsByIds: vi.fn(async () => [])
    };

    (engine as any).rest = {
      getMarket: vi.fn(async () => ({
        minimum_order_size: 1,
        minimum_tick_size: 0.001,
        maker_base_fee: 0,
        taker_base_fee: 0.25,
        rewards: { min_size: 1, max_spread: 3.5, rates: null }
      })),
      getFeeRateBps: vi.fn(async () => 2500)
    };

    const ok = await (engine as any).refreshUniverse();
    expect(ok).toBe(true);
    expect(engine.getTrackedTokenIds().sort()).toEqual(["t_active_yes", "t_pin_no", "t_pin_yes"]);
    expect(engine.getTrackedConditionIds().sort()).toEqual(["c_active", "c_pinned"]);
  });

  it("refreshes stale BTC 5m wallet market pins before universe augmentation", async () => {
    tempDb.sqlite.prepare("DELETE FROM wallets").run();
    const now = Date.now();
    tempDb.sqlite
      .prepare(
        `INSERT INTO wallets (name, starting_balance, size_multiplier, max_open_positions, min_confidence, min_edge, auto_open_limit, auto_trade_enabled, maker_enabled, maker_execution_mode, market_filter_json, market_allowlist, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "BTC 5m · Taker Shadow",
        50_000,
        0.9,
        4,
        0.58,
        0.008,
        2,
        1,
        0,
        "SHADOW",
        JSON.stringify({
          version: 1,
          includeMarketIds: ["m_stale"],
          requireActive: true,
          allowedKinds: ["TAKER_BUY", "TAKER_SELL"]
        }),
        "m_stale",
        now
      );

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
        topN: 1,
        activeTokenLimit: 0,
        activeTokenWindowMinutes: 30,
        clobEventsSampleRate: 0,
        marketScope: "ALL"
      },
      {
        db: {},
        sqlite: tempDb.sqlite,
        logger,
        store: new BookStore()
      }
    );

    (engine as any).gamma = {
      getTopMarkets: vi.fn(async () => []),
      getMarketsBySlug: vi.fn(async (slug: string) => [
        {
          id: "m_live",
          slug,
          question: "Bitcoin Up or Down - live bucket",
          category: "crypto",
          active: true,
          closed: false,
          liquidity: 1000,
          volume: 1000,
          conditionId: "c_live",
          clobTokenIds: ["t_live_yes", "t_live_no"],
          endDate: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        }
      ]),
      getMarketsByIds: vi.fn(async (ids: string[]) => {
        if (!ids.includes("m_live")) return [];
        return [
          {
            market: {
              id: "m_live",
              slug: "btc-updown-5m-live",
              question: "Bitcoin Up or Down - live bucket",
              category: "crypto",
              active: true,
              closed: false,
              liquidity: 1000,
              volume: 1000,
              conditionId: "c_live",
              clobTokenIds: ["t_live_yes", "t_live_no"],
              events: [{ id: "e_live", title: "Bitcoin 5 minute market" }]
            },
            conditionId: "c_live",
            tokenIds: ["t_live_yes", "t_live_no"]
          }
        ];
      })
    };
    (engine as any).rest = {
      getMarket: vi.fn(async () => ({
        minimum_order_size: 1,
        minimum_tick_size: 0.001,
        maker_base_fee: 0,
        taker_base_fee: 0.25,
        rewards: { min_size: 1, max_spread: 3.5, rates: null }
      })),
      getFeeRateBps: vi.fn(async () => 2500)
    };

    const ok = await (engine as any).refreshUniverse();
    expect(ok).toBe(true);
    expect((engine as any).gamma.getMarketsByIds).toHaveBeenCalledWith(["m_live"], logger);
    expect(engine.getTrackedTokenIds().sort()).toEqual(["t_live_no", "t_live_yes"]);

    const updated = tempDb.sqlite
      .prepare("SELECT market_filter_json as marketFilterJson, market_allowlist as marketAllowlist FROM wallets WHERE name = ?")
      .get("BTC 5m · Taker Shadow") as { marketFilterJson: string | null; marketAllowlist: string | null };
    expect(updated.marketAllowlist).toBe("m_live");
    const filter = JSON.parse(updated.marketFilterJson ?? "{}") as { includeMarketIds?: unknown };
    expect(filter.includeMarketIds).toEqual(["m_live"]);
  });
});
