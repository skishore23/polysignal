#!/usr/bin/env tsx
/**
 * Unified wallet seeding + audit script.
 *
 * Why this exists:
 * - Replaces fragmented wallet creation scripts with one source of truth.
 * - Assigns explicit, non-overlapping roles (maker OR taker).
 * - Prints a maker/taker activity audit so we can quickly verify maker health.
 *
 * Usage:
 *   npx tsx scripts/seed-wallets.ts
 *   npx tsx scripts/seed-wallets.ts --reset
 *   npx tsx scripts/seed-wallets.ts --audit-only
 *   npx tsx scripts/seed-wallets.ts --with-btc-5m
 *   npx tsx scripts/seed-wallets.ts --reset --drop-main
 */

import { getDb } from "../apps/web/lib/db.js";
import type { WalletMarketFilterV1 } from "../packages/types/src/walletFilters.ts";
import { serializeWalletMarketFilter } from "../packages/utils/src/walletFilters.ts";

type WalletRole = "TAKER" | "MAKER" | "ARB";

type WalletSeed = {
  name: string;
  role: WalletRole;
  startingBalance: number;
  sizeMultiplier: number;
  maxOpenPositions: number;
  minConfidence: number;
  minEdge: number;
  autoOpenLimit: number;
  takerSide: "BUY" | "SELL" | "BOTH" | "NONE";
  makerQuoteSize: number;
  makerQuoteWidthBps: number;
  makerMinSpread: number;
  makerMaxSpread: number;
  makerMinDepth: number;
  makerMaxEntropy: number | null;
  makerMaxVol: number | null;
  makerInventoryTarget: number;
  makerInventoryMaxAbs: number;
  makerInventoryBand: number;
  makerInventorySkewBps: number;
  makerInventorySkewSize: number;
  makerInventorySkewBpsCap: number | null;
  makerQuoteImproveFraction: number;
  maxDailyLossUsd: number | null;
  maxDrawdownPct: number | null;
  cooldownMinutes: number | null;
  marketAllowlist: string | null;
  marketFilter: WalletMarketFilterV1 | null;
};

type WalletRow = {
  id: number;
  name: string;
  auto_trade_enabled: number;
  maker_enabled: number;
  taker_side: string | null;
  starting_balance: number;
  min_confidence: number;
  min_edge: number;
  maker_quote_size: number;
  maker_quote_width_bps: number;
};

type SeedArgs = {
  reset: boolean;
  auditOnly: boolean;
  dropMain: boolean;
  btcOnly: boolean;
  arbWalletCount: number;
  withBtc5m: boolean;
  requireBtc5m: boolean;
  btcMarketCount: number;
  btcPastMinutes: number;
  btcFutureMinutes: number;
};

type GammaMarketRow = {
  id: string;
  slug: string | null;
  question: string | null;
  active: boolean;
  closed: boolean;
  acceptingOrders?: boolean | null;
  endDate?: string | null;
};

const DEFAULT_MAKER = {
  makerQuoteSize: 50,
  makerQuoteWidthBps: 20,
  makerMinSpread: 0.002,
  makerMaxSpread: 0.02,
  makerMinDepth: 20,
  makerMaxEntropy: 1.0,
  makerMaxVol: 0.18,
  makerInventoryTarget: 0,
  makerInventoryMaxAbs: 500,
  makerInventoryBand: 200,
  makerInventorySkewBps: 15,
  makerInventorySkewSize: 0.5,
  makerInventorySkewBpsCap: 30,
  makerQuoteImproveFraction: 0.2
} as const;

const SEEDS: WalletSeed[] = [
  // Taker lanes: quality -> balanced -> flow
  {
    name: "Core · Taker Quality",
    role: "TAKER",
    startingBalance: 60_000,
    sizeMultiplier: 0.85,
    maxOpenPositions: 6,
    minConfidence: 0.74,
    minEdge: 0.018,
    autoOpenLimit: 3,
    takerSide: "BOTH",
    ...DEFAULT_MAKER,
    maxDailyLossUsd: 700,
    maxDrawdownPct: 0.08,
    cooldownMinutes: 20,
    marketAllowlist: null,
    marketFilter: {
      version: 1,
      minVolumeUsd: 5_000_000,
      minLiquidityUsd: 500_000,
      maxVolumeUsd: 25_000_000,
      requireActive: true,
      allowedKinds: ["TAKER_BUY", "TAKER_SELL"]
    }
  },
  {
    name: "Core · Taker Balanced",
    role: "TAKER",
    startingBalance: 90_000,
    sizeMultiplier: 1.0,
    maxOpenPositions: 10,
    minConfidence: 0.66,
    minEdge: 0.012,
    autoOpenLimit: 5,
    takerSide: "BOTH",
    ...DEFAULT_MAKER,
    maxDailyLossUsd: 1_100,
    maxDrawdownPct: 0.1,
    cooldownMinutes: 15,
    marketAllowlist: null,
    marketFilter: {
      version: 1,
      minVolumeUsd: 2_000_000,
      minLiquidityUsd: 250_000,
      maxVolumeUsd: 10_000_000,
      requireActive: true,
      allowedKinds: ["TAKER_BUY", "TAKER_SELL"]
    }
  },
  {
    name: "Core · Taker Flow",
    role: "TAKER",
    startingBalance: 120_000,
    sizeMultiplier: 1.2,
    maxOpenPositions: 14,
    minConfidence: 0.58,
    minEdge: 0.008,
    autoOpenLimit: 7,
    takerSide: "BOTH",
    ...DEFAULT_MAKER,
    maxDailyLossUsd: 1_700,
    maxDrawdownPct: 0.12,
    cooldownMinutes: 10,
    marketAllowlist: null,
    marketFilter: {
      version: 1,
      minVolumeUsd: 750_000,
      minLiquidityUsd: 100_000,
      maxVolumeUsd: 4_000_000,
      requireActive: true,
      allowedKinds: ["TAKER_BUY", "TAKER_SELL"]
    }
  },
  {
    name: "Core · Taker Buy Bias",
    role: "TAKER",
    startingBalance: 85_000,
    sizeMultiplier: 1.0,
    maxOpenPositions: 8,
    minConfidence: 0.64,
    minEdge: 0.011,
    autoOpenLimit: 4,
    takerSide: "BUY",
    ...DEFAULT_MAKER,
    maxDailyLossUsd: 1_000,
    maxDrawdownPct: 0.1,
    cooldownMinutes: 12,
    marketAllowlist: null,
    marketFilter: {
      version: 1,
      minVolumeUsd: 1_500_000,
      minLiquidityUsd: 150_000,
      maxVolumeUsd: 8_000_000,
      requireActive: true,
      allowedKinds: ["TAKER_BUY"]
    }
  },
  {
    name: "Core · Taker Sell Bias",
    role: "TAKER",
    startingBalance: 85_000,
    sizeMultiplier: 1.0,
    maxOpenPositions: 8,
    minConfidence: 0.64,
    minEdge: 0.011,
    autoOpenLimit: 4,
    takerSide: "SELL",
    ...DEFAULT_MAKER,
    maxDailyLossUsd: 1_000,
    maxDrawdownPct: 0.1,
    cooldownMinutes: 12,
    marketAllowlist: null,
    marketFilter: {
      version: 1,
      minVolumeUsd: 1_500_000,
      minLiquidityUsd: 150_000,
      maxVolumeUsd: 8_000_000,
      requireActive: true,
      allowedKinds: ["TAKER_SELL"]
    }
  },
  {
    name: "Core · Taker High Volume Cohort",
    role: "TAKER",
    startingBalance: 95_000,
    sizeMultiplier: 1.05,
    maxOpenPositions: 8,
    minConfidence: 0.62,
    minEdge: 0.01,
    autoOpenLimit: 4,
    takerSide: "BOTH",
    ...DEFAULT_MAKER,
    maxDailyLossUsd: 1_200,
    maxDrawdownPct: 0.1,
    cooldownMinutes: 12,
    marketAllowlist: null,
    marketFilter: {
      version: 1,
      minVolumeUsd: 8_000_000,
      minLiquidityUsd: 600_000,
      requireActive: true,
      allowedKinds: ["TAKER_BUY", "TAKER_SELL"]
    }
  },

  // Maker lanes: tight -> balanced -> depth/wide
  {
    name: "Core · Maker Tight",
    role: "MAKER",
    startingBalance: 80_000,
    sizeMultiplier: 0.9,
    maxOpenPositions: 0,
    minConfidence: 0,
    minEdge: 0,
    autoOpenLimit: 0,
    takerSide: "NONE",
    makerQuoteSize: 35,
    makerQuoteWidthBps: 12,
    makerMinSpread: 0.0015,
    makerMaxSpread: 0.012,
    makerMinDepth: 35,
    makerMaxEntropy: 0.85,
    makerMaxVol: 0.12,
    makerInventoryTarget: 0,
    makerInventoryMaxAbs: 220,
    makerInventoryBand: 120,
    makerInventorySkewBps: 10,
    makerInventorySkewSize: 0.4,
    makerInventorySkewBpsCap: 20,
    makerQuoteImproveFraction: 0.3,
    maxDailyLossUsd: 900,
    maxDrawdownPct: 0.08,
    cooldownMinutes: 15,
    marketAllowlist: null,
    marketFilter: {
      version: 1,
      minVolumeUsd: 1_500_000,
      minLiquidityUsd: 200_000,
      maxVolumeUsd: 12_000_000,
      requireActive: true,
      allowedKinds: ["MAKER_BID", "MAKER_ASK"]
    }
  },
  {
    name: "Core · Maker Balanced",
    role: "MAKER",
    startingBalance: 100_000,
    sizeMultiplier: 1.0,
    maxOpenPositions: 0,
    minConfidence: 0,
    minEdge: 0,
    autoOpenLimit: 0,
    takerSide: "NONE",
    makerQuoteSize: 55,
    makerQuoteWidthBps: 18,
    makerMinSpread: 0.002,
    makerMaxSpread: 0.02,
    makerMinDepth: 24,
    makerMaxEntropy: 1.0,
    makerMaxVol: 0.18,
    makerInventoryTarget: 0,
    makerInventoryMaxAbs: 420,
    makerInventoryBand: 200,
    makerInventorySkewBps: 15,
    makerInventorySkewSize: 0.5,
    makerInventorySkewBpsCap: 30,
    makerQuoteImproveFraction: 0.2,
    maxDailyLossUsd: 1_200,
    maxDrawdownPct: 0.1,
    cooldownMinutes: 12,
    marketAllowlist: null,
    marketFilter: {
      version: 1,
      minVolumeUsd: 1_000_000,
      minLiquidityUsd: 150_000,
      maxVolumeUsd: 8_000_000,
      requireActive: true,
      allowedKinds: ["MAKER_BID", "MAKER_ASK"]
    }
  },
  {
    name: "Core · Maker Depth",
    role: "MAKER",
    startingBalance: 130_000,
    sizeMultiplier: 1.15,
    maxOpenPositions: 0,
    minConfidence: 0,
    minEdge: 0,
    autoOpenLimit: 0,
    takerSide: "NONE",
    makerQuoteSize: 75,
    makerQuoteWidthBps: 26,
    makerMinSpread: 0.0025,
    makerMaxSpread: 0.03,
    makerMinDepth: 45,
    makerMaxEntropy: 1.2,
    makerMaxVol: 0.24,
    makerInventoryTarget: 0,
    makerInventoryMaxAbs: 700,
    makerInventoryBand: 280,
    makerInventorySkewBps: 19,
    makerInventorySkewSize: 0.6,
    makerInventorySkewBpsCap: 45,
    makerQuoteImproveFraction: 0.1,
    maxDailyLossUsd: 1_700,
    maxDrawdownPct: 0.12,
    cooldownMinutes: 10,
    marketAllowlist: null,
    marketFilter: {
      version: 1,
      minVolumeUsd: 500_000,
      minLiquidityUsd: 100_000,
      maxVolumeUsd: 4_000_000,
      requireActive: true,
      allowedKinds: ["MAKER_BID", "MAKER_ASK"]
    }
  },
  {
    name: "Core · Maker Wide",
    role: "MAKER",
    startingBalance: 110_000,
    sizeMultiplier: 1.05,
    maxOpenPositions: 0,
    minConfidence: 0,
    minEdge: 0,
    autoOpenLimit: 0,
    takerSide: "NONE",
    makerQuoteSize: 65,
    makerQuoteWidthBps: 34,
    makerMinSpread: 0.003,
    makerMaxSpread: 0.04,
    makerMinDepth: 18,
    makerMaxEntropy: 1.3,
    makerMaxVol: 0.28,
    makerInventoryTarget: 0,
    makerInventoryMaxAbs: 520,
    makerInventoryBand: 240,
    makerInventorySkewBps: 22,
    makerInventorySkewSize: 0.65,
    makerInventorySkewBpsCap: 50,
    makerQuoteImproveFraction: 0.05,
    maxDailyLossUsd: 1_500,
    maxDrawdownPct: 0.12,
    cooldownMinutes: 10,
    marketAllowlist: null,
    marketFilter: {
      version: 1,
      minVolumeUsd: 1_000_000,
      minLiquidityUsd: 100_000,
      maxVolumeUsd: 6_000_000,
      requireActive: true,
      allowedKinds: ["MAKER_BID", "MAKER_ASK"]
    }
  },
  {
    name: "Core · Maker Inventory Lean",
    role: "MAKER",
    startingBalance: 95_000,
    sizeMultiplier: 0.95,
    maxOpenPositions: 0,
    minConfidence: 0,
    minEdge: 0,
    autoOpenLimit: 0,
    takerSide: "NONE",
    makerQuoteSize: 45,
    makerQuoteWidthBps: 20,
    makerMinSpread: 0.002,
    makerMaxSpread: 0.022,
    makerMinDepth: 26,
    makerMaxEntropy: 1.0,
    makerMaxVol: 0.2,
    makerInventoryTarget: 0,
    makerInventoryMaxAbs: 180,
    makerInventoryBand: 90,
    makerInventorySkewBps: 28,
    makerInventorySkewSize: 0.75,
    makerInventorySkewBpsCap: 60,
    makerQuoteImproveFraction: 0.25,
    maxDailyLossUsd: 1_000,
    maxDrawdownPct: 0.09,
    cooldownMinutes: 14,
    marketAllowlist: null,
    marketFilter: {
      version: 1,
      minVolumeUsd: 1_500_000,
      minLiquidityUsd: 180_000,
      maxVolumeUsd: 9_000_000,
      requireActive: true,
      allowedKinds: ["MAKER_BID", "MAKER_ASK"]
    }
  },
  {
    name: "Core · Maker High Volume Cohort",
    role: "MAKER",
    startingBalance: 120_000,
    sizeMultiplier: 1.1,
    maxOpenPositions: 0,
    minConfidence: 0,
    minEdge: 0,
    autoOpenLimit: 0,
    takerSide: "NONE",
    makerQuoteSize: 68,
    makerQuoteWidthBps: 22,
    makerMinSpread: 0.0022,
    makerMaxSpread: 0.024,
    makerMinDepth: 30,
    makerMaxEntropy: 1.0,
    makerMaxVol: 0.2,
    makerInventoryTarget: 0,
    makerInventoryMaxAbs: 480,
    makerInventoryBand: 220,
    makerInventorySkewBps: 16,
    makerInventorySkewSize: 0.55,
    makerInventorySkewBpsCap: 34,
    makerQuoteImproveFraction: 0.15,
    maxDailyLossUsd: 1_400,
    maxDrawdownPct: 0.1,
    cooldownMinutes: 12,
    marketAllowlist: null,
    marketFilter: {
      version: 1,
      minVolumeUsd: 8_000_000,
      minLiquidityUsd: 600_000,
      requireActive: true,
      allowedKinds: ["MAKER_BID", "MAKER_ASK"]
    }
  }
];

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const DEFAULT_BTC_MARKET_COUNT = 10;
const DEFAULT_BTC_PAST_MINUTES = 30;
const DEFAULT_BTC_FUTURE_MINUTES = 120;

const toFiveMinuteBucket = (epochSeconds: number): number => epochSeconds - (epochSeconds % 300);

const parseFiniteInt = (raw: string, fallback: number, min: number, max: number): number => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return Math.min(max, Math.max(min, rounded));
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const resp = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Gamma request failed (${resp.status}): ${text}`);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
};

const buildBtc5mSlugCandidates = (
  nowEpochSeconds: number,
  pastMinutes: number,
  futureMinutes: number
): string[] => {
  const start = toFiveMinuteBucket(nowEpochSeconds - pastMinutes * 60);
  const end = toFiveMinuteBucket(nowEpochSeconds + futureMinutes * 60);
  const slugs: string[] = [];
  for (let ts = start; ts <= end; ts += 300) {
    slugs.push(`btc-updown-5m-${ts}`);
  }
  return slugs;
};

const isLiveBtc5mMarket = (market: GammaMarketRow, nowMs: number): boolean => {
  if (!market.id || !market.slug) return false;
  if (!market.slug.startsWith("btc-updown-5m-")) return false;
  if (!market.active || market.closed) return false;
  if (market.acceptingOrders === false) return false;
  if (typeof market.endDate === "string" && market.endDate.trim().length > 0) {
    const endMs = Date.parse(market.endDate);
    if (Number.isFinite(endMs) && endMs < nowMs - 60_000) {
      return false;
    }
  }
  return true;
};

const fetchActiveBtc5mMarketIds = async (args: SeedArgs): Promise<string[]> => {
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const slugs = buildBtc5mSlugCandidates(nowSec, args.btcPastMinutes, args.btcFutureMinutes);

  const responses = await Promise.all(
    slugs.map(async (slug) => {
      const url = `${GAMMA_BASE_URL}/markets?slug=${encodeURIComponent(slug)}`;
      try {
        const rows = await fetchJson<GammaMarketRow[]>(url);
        return rows[0] ?? null;
      } catch {
        return null;
      }
    })
  );

  const uniqueById = new Map<string, GammaMarketRow>();
  for (const market of responses) {
    if (!market) continue;
    if (!isLiveBtc5mMarket(market, nowMs)) continue;
    uniqueById.set(market.id, market);
  }

  const ranked = Array.from(uniqueById.values()).sort((a, b) => {
    const aEnd = a.endDate ? Date.parse(a.endDate) : Number.POSITIVE_INFINITY;
    const bEnd = b.endDate ? Date.parse(b.endDate) : Number.POSITIVE_INFINITY;
    const safeA = Number.isFinite(aEnd) ? aEnd : Number.POSITIVE_INFINITY;
    const safeB = Number.isFinite(bEnd) ? bEnd : Number.POSITIVE_INFINITY;
    return safeA - safeB;
  });

  return ranked.slice(0, args.btcMarketCount).map((market) => market.id);
};

const buildBtc5mWalletSeeds = (marketIds: string[]): WalletSeed[] => {
  const allowlist = marketIds.join(",");
  const includeMarketIds = [...marketIds];
  const takerFilter: WalletMarketFilterV1 = {
    version: 1,
    includeMarketIds,
    requireActive: true,
    allowedKinds: ["TAKER_BUY", "TAKER_SELL"]
  };
  const makerFilter: WalletMarketFilterV1 = {
    version: 1,
    includeMarketIds,
    requireActive: true,
    allowedKinds: ["MAKER_BID", "MAKER_ASK"]
  };

  return [
    {
      name: "BTC 5m · Taker Shadow",
      role: "TAKER",
      startingBalance: 50_000,
      sizeMultiplier: 0.9,
      maxOpenPositions: 4,
      minConfidence: 0.58,
      minEdge: 0.008,
      autoOpenLimit: 2,
      takerSide: "BOTH",
      ...DEFAULT_MAKER,
      maxDailyLossUsd: 600,
      maxDrawdownPct: 0.08,
      cooldownMinutes: 10,
      marketAllowlist: allowlist,
      marketFilter: takerFilter
    },
    {
      name: "BTC 5m · Maker Shadow",
      role: "MAKER",
      startingBalance: 50_000,
      sizeMultiplier: 0.9,
      maxOpenPositions: 0,
      minConfidence: 0,
      minEdge: 0,
      autoOpenLimit: 0,
      takerSide: "NONE",
      makerQuoteSize: 25,
      makerQuoteWidthBps: 18,
      makerMinSpread: 0.002,
      makerMaxSpread: 0.02,
      makerMinDepth: 12,
      makerMaxEntropy: 1.1,
      makerMaxVol: 0.3,
      makerInventoryTarget: 0,
      makerInventoryMaxAbs: 240,
      makerInventoryBand: 120,
      makerInventorySkewBps: 16,
      makerInventorySkewSize: 0.55,
      makerInventorySkewBpsCap: 35,
      makerQuoteImproveFraction: 0.2,
      maxDailyLossUsd: 600,
      maxDrawdownPct: 0.08,
      cooldownMinutes: 10,
      marketAllowlist: allowlist,
      marketFilter: makerFilter
    }
  ];
};

const buildBtc5mArbWalletSeeds = (marketIds: string[], walletCount: number): WalletSeed[] => {
  if (walletCount <= 0) return [];
  const allowlist = marketIds.join(",");
  const includeMarketIds = [...marketIds];
  const marketFilter: WalletMarketFilterV1 = {
    version: 1,
    includeMarketIds,
    requireActive: true,
    allowedKinds: ["TAKER_BUY", "TAKER_SELL"]
  };
  const out: WalletSeed[] = [];
  for (let i = 1; i <= walletCount; i += 1) {
    out.push({
      name: `BTC 5m · Arb ${i}`,
      role: "ARB",
      startingBalance: 50_000,
      sizeMultiplier: 0.9,
      maxOpenPositions: 0,
      minConfidence: 0,
      minEdge: 0,
      autoOpenLimit: 0,
      takerSide: "NONE",
      ...DEFAULT_MAKER,
      maxDailyLossUsd: 600,
      maxDrawdownPct: 0.08,
      cooldownMinutes: 10,
      marketAllowlist: allowlist,
      marketFilter
    });
  }
  return out;
};

const allowedKindsForSeed = (seed: WalletSeed): WalletMarketFilterV1["allowedKinds"] => {
  if (seed.role === "MAKER") {
    return ["MAKER_BID", "MAKER_ASK"];
  }
  if (seed.role === "ARB") {
    return ["TAKER_BUY", "TAKER_SELL"];
  }
  if (seed.takerSide === "BUY") {
    return ["TAKER_BUY"];
  }
  if (seed.takerSide === "SELL") {
    return ["TAKER_SELL"];
  }
  return ["TAKER_BUY", "TAKER_SELL"];
};

const pinSeedsToMarketIds = (seeds: WalletSeed[], marketIds: string[]): WalletSeed[] => {
  const includeMarketIds = [...marketIds];
  const marketAllowlist = includeMarketIds.join(",");
  return seeds.map((seed) => ({
    ...seed,
    marketAllowlist,
    marketFilter: {
      version: 1,
      includeMarketIds,
      requireActive: true,
      allowedKinds: allowedKindsForSeed(seed)
    }
  }));
};

const fmt = (n: number): string => new Intl.NumberFormat("en-US").format(n);

function parseArgs(argv: string[]): SeedArgs {
  const args = new Set(argv);
  const readValue = (flag: string): string | null => {
    const index = argv.findIndex((arg) => arg === flag);
    if (index < 0) return null;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) return null;
    return next;
  };

  if (args.has("--help") || args.has("-h")) {
    console.log(`
Usage: npx tsx scripts/seed-wallets.ts [options]

Options:
  --reset       Delete existing wallets before seeding (preserves wallet id=1 unless --drop-main)
  --drop-main   With --reset, also delete wallet id=1
  --audit-only  Do not seed. Print maker/taker wallet + activity audit only
  --btc-only    Seed only BTC 5m taker+maker wallets (2 wallets total)
  --arb-wallet-count <n>  Add N ARB attribution wallets (default: 0)
  --with-btc-5m Include dedicated BTC 5m maker+taker shadow wallets
  --no-btc-5m   Explicitly disable BTC 5m shadow wallets (default behavior)
  --require-btc-5m  Fail when BTC 5m markets cannot be resolved
  --btc-market-count <n>  Number of active BTC 5m markets to pin (default: 10)
  --btc-past-minutes <n>  Backward search window (default: 30)
  --btc-future-minutes <n>  Forward search window (default: 120)
  --help        Show this help
`);
    process.exit(0);
  }

  const btcMarketCount = parseFiniteInt(
    readValue("--btc-market-count") ?? String(DEFAULT_BTC_MARKET_COUNT),
    DEFAULT_BTC_MARKET_COUNT,
    1,
    100
  );
  const btcPastMinutes = parseFiniteInt(
    readValue("--btc-past-minutes") ?? String(DEFAULT_BTC_PAST_MINUTES),
    DEFAULT_BTC_PAST_MINUTES,
    5,
    720
  );
  const btcFutureMinutes = parseFiniteInt(
    readValue("--btc-future-minutes") ?? String(DEFAULT_BTC_FUTURE_MINUTES),
    DEFAULT_BTC_FUTURE_MINUTES,
    5,
    720
  );
  const arbWalletCount = parseFiniteInt(
    readValue("--arb-wallet-count") ?? "0",
    0,
    0,
    12
  );
  const btcOnly = args.has("--btc-only");

  return {
    reset: args.has("--reset"),
    auditOnly: args.has("--audit-only"),
    dropMain: args.has("--drop-main"),
    btcOnly,
    arbWalletCount,
    withBtc5m: btcOnly || (args.has("--with-btc-5m") && !args.has("--no-btc-5m")),
    requireBtc5m: btcOnly || args.has("--require-btc-5m"),
    btcMarketCount,
    btcPastMinutes,
    btcFutureMinutes
  };
}

function ensureMakerGate(sqlite: any): void {
  sqlite
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('maker_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'"
    )
    .run();
}

function roleFlags(role: WalletRole): { makerEnabled: number; autoTradeEnabled: number; takerSide: string } {
  if (role === "MAKER") {
    return { makerEnabled: 1, autoTradeEnabled: 0, takerSide: "NONE" };
  }
  if (role === "ARB") {
    return { makerEnabled: 0, autoTradeEnabled: 0, takerSide: "NONE" };
  }
  return { makerEnabled: 0, autoTradeEnabled: 1, takerSide: "BOTH" };
}

function upsertWallet(sqlite: any, seed: WalletSeed): { id: number; action: "created" | "updated" } {
  const existing = sqlite
    .prepare("SELECT id FROM wallets WHERE name = ? LIMIT 1")
    .get(seed.name) as { id: number } | undefined;

  const now = Date.now();
  const flags = roleFlags(seed.role);
  const marketFilter = serializeWalletMarketFilter(seed.marketFilter);
  if (!marketFilter.ok) {
    throw new Error(`Invalid market filter for ${seed.name}: ${marketFilter.error}`);
  }

  if (existing) {
    sqlite
      .prepare(
        `UPDATE wallets
         SET starting_balance = @startingBalance,
             size_multiplier = @sizeMultiplier,
             max_open_positions = @maxOpenPositions,
             min_confidence = @minConfidence,
             min_edge = @minEdge,
             auto_open_limit = @autoOpenLimit,
             auto_trade_enabled = @autoTradeEnabled,
             taker_side = @takerSide,
             maker_enabled = @makerEnabled,
             maker_quote_size = @makerQuoteSize,
             maker_quote_width_bps = @makerQuoteWidthBps,
             maker_min_spread = @makerMinSpread,
             maker_max_spread = @makerMaxSpread,
             maker_min_depth = @makerMinDepth,
             maker_max_entropy = @makerMaxEntropy,
             maker_max_vol = @makerMaxVol,
             maker_inventory_target = @makerInventoryTarget,
             maker_inventory_max_abs = @makerInventoryMaxAbs,
             maker_inventory_band = @makerInventoryBand,
             maker_inventory_skew_bps = @makerInventorySkewBps,
             maker_inventory_skew_size = @makerInventorySkewSize,
             maker_inventory_skew_bps_cap = @makerInventorySkewBpsCap,
             maker_quote_improve_fraction = @makerQuoteImproveFraction,
             maker_execution_mode = 'SHADOW',
             max_daily_loss_usd = @maxDailyLossUsd,
             max_drawdown_pct = @maxDrawdownPct,
             cooldown_minutes = @cooldownMinutes,
             market_allowlist = @marketAllowlist,
             market_filter_json = @marketFilterJson
         WHERE id = @id`
      )
      .run({
        id: existing.id,
        startingBalance: seed.startingBalance,
        sizeMultiplier: seed.sizeMultiplier,
        maxOpenPositions: seed.maxOpenPositions,
        minConfidence: seed.minConfidence,
        minEdge: seed.minEdge,
        autoOpenLimit: seed.autoOpenLimit,
        autoTradeEnabled: flags.autoTradeEnabled,
        takerSide: seed.role === "TAKER" ? seed.takerSide : "NONE",
        makerEnabled: flags.makerEnabled,
        makerQuoteSize: seed.makerQuoteSize,
        makerQuoteWidthBps: seed.makerQuoteWidthBps,
        makerMinSpread: seed.makerMinSpread,
        makerMaxSpread: seed.makerMaxSpread,
        makerMinDepth: seed.makerMinDepth,
        makerMaxEntropy: seed.makerMaxEntropy,
        makerMaxVol: seed.makerMaxVol,
        makerInventoryTarget: seed.makerInventoryTarget,
        makerInventoryMaxAbs: seed.makerInventoryMaxAbs,
        makerInventoryBand: seed.makerInventoryBand,
        makerInventorySkewBps: seed.makerInventorySkewBps,
        makerInventorySkewSize: seed.makerInventorySkewSize,
        makerInventorySkewBpsCap: seed.makerInventorySkewBpsCap,
        makerQuoteImproveFraction: seed.makerQuoteImproveFraction,
        maxDailyLossUsd: seed.maxDailyLossUsd,
        maxDrawdownPct: seed.maxDrawdownPct,
        cooldownMinutes: seed.cooldownMinutes,
        marketAllowlist: seed.marketAllowlist,
        marketFilterJson: marketFilter.json
      });
    return { id: existing.id, action: "updated" };
  }

  const result = sqlite
    .prepare(
      `INSERT INTO wallets (
         name, starting_balance, size_multiplier, max_open_positions, min_confidence, min_edge,
         auto_open_limit, auto_trade_enabled, taker_side, maker_enabled,
         maker_quote_size, maker_quote_width_bps, maker_min_spread, maker_max_spread, maker_min_depth, maker_max_entropy, maker_max_vol,
         maker_inventory_target, maker_inventory_max_abs, maker_inventory_band, maker_inventory_skew_bps, maker_inventory_skew_size,
         maker_inventory_skew_bps_cap, maker_quote_improve_fraction, maker_execution_mode,
         max_daily_loss_usd, max_drawdown_pct, cooldown_minutes, market_allowlist, market_filter_json, created_at
       ) VALUES (
         @name, @startingBalance, @sizeMultiplier, @maxOpenPositions, @minConfidence, @minEdge,
         @autoOpenLimit, @autoTradeEnabled, @takerSide, @makerEnabled,
         @makerQuoteSize, @makerQuoteWidthBps, @makerMinSpread, @makerMaxSpread, @makerMinDepth, @makerMaxEntropy, @makerMaxVol,
         @makerInventoryTarget, @makerInventoryMaxAbs, @makerInventoryBand, @makerInventorySkewBps, @makerInventorySkewSize,
         @makerInventorySkewBpsCap, @makerQuoteImproveFraction, 'SHADOW',
         @maxDailyLossUsd, @maxDrawdownPct, @cooldownMinutes, @marketAllowlist, @marketFilterJson, @createdAt
       )`
    )
    .run({
      name: seed.name,
      startingBalance: seed.startingBalance,
      sizeMultiplier: seed.sizeMultiplier,
      maxOpenPositions: seed.maxOpenPositions,
      minConfidence: seed.minConfidence,
      minEdge: seed.minEdge,
      autoOpenLimit: seed.autoOpenLimit,
      autoTradeEnabled: flags.autoTradeEnabled,
      takerSide: seed.role === "TAKER" ? seed.takerSide : "NONE",
      makerEnabled: flags.makerEnabled,
      makerQuoteSize: seed.makerQuoteSize,
      makerQuoteWidthBps: seed.makerQuoteWidthBps,
      makerMinSpread: seed.makerMinSpread,
      makerMaxSpread: seed.makerMaxSpread,
      makerMinDepth: seed.makerMinDepth,
      makerMaxEntropy: seed.makerMaxEntropy,
      makerMaxVol: seed.makerMaxVol,
      makerInventoryTarget: seed.makerInventoryTarget,
      makerInventoryMaxAbs: seed.makerInventoryMaxAbs,
      makerInventoryBand: seed.makerInventoryBand,
      makerInventorySkewBps: seed.makerInventorySkewBps,
      makerInventorySkewSize: seed.makerInventorySkewSize,
      makerInventorySkewBpsCap: seed.makerInventorySkewBpsCap,
      makerQuoteImproveFraction: seed.makerQuoteImproveFraction,
      maxDailyLossUsd: seed.maxDailyLossUsd,
      maxDrawdownPct: seed.maxDrawdownPct,
      cooldownMinutes: seed.cooldownMinutes,
      marketAllowlist: seed.marketAllowlist,
      marketFilterJson: marketFilter.json,
      createdAt: now
    });

  return { id: Number(result.lastInsertRowid), action: "created" };
}

function classifyRole(row: WalletRow): "MAKER" | "TAKER" | "HYBRID" | "ARB" | "DISABLED" {
  const maker = row.maker_enabled === 1;
  const taker = row.auto_trade_enabled === 1;
  if (maker && taker) return "HYBRID";
  if (maker) return "MAKER";
  if (taker) return "TAKER";
  if (/\barb\b/i.test(row.name ?? "")) return "ARB";
  return "DISABLED";
}

function printAudit(sqlite: any): void {
  const rows = sqlite
    .prepare(
      `SELECT id, name, auto_trade_enabled, maker_enabled, taker_side, starting_balance, min_confidence, min_edge,
              maker_quote_size, maker_quote_width_bps
       FROM wallets
       ORDER BY id`
    )
    .all() as WalletRow[];

  const makerGate = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'maker_enabled'")
    .get() as { value?: string } | undefined;
  const makerGateOn = makerGate?.value === "1";

  const now = Date.now();
  const since30m = now - 30 * 60 * 1000;

  const makerOrders30m = Number(
    (sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM shadow_orders
         WHERE kind IN ('MAKER_BID','MAKER_ASK') AND ts >= ?`
      )
      .get(since30m) as { c: number } | undefined)?.c ?? 0
  );

  const makerFills30m = Number(
    (sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE o.kind IN ('MAKER_BID','MAKER_ASK')
           AND f.method != 'synthetic_fill'
           AND f.ts >= ?`
      )
      .get(since30m) as { c: number } | undefined)?.c ?? 0
  );

  const takerOrders30m = Number(
    (sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM shadow_orders
         WHERE kind IN ('TAKER_BUY','TAKER_SELL') AND ts >= ?`
      )
      .get(since30m) as { c: number } | undefined)?.c ?? 0
  );

  const makerLastTs = Number(
    (sqlite
      .prepare("SELECT MAX(ts) as ts FROM shadow_orders WHERE kind IN ('MAKER_BID','MAKER_ASK')")
      .get() as { ts: number | null } | undefined)?.ts ?? 0
  );

  const byRole = {
    MAKER: 0,
    TAKER: 0,
    HYBRID: 0,
    ARB: 0,
    DISABLED: 0
  };

  for (const row of rows) {
    byRole[classifyRole(row)] += 1;
  }

  console.log("\n=== Wallet Audit ===\n");
  console.log("ID  Role      Maker  Taker  Balance    Name");
  console.log("--  --------  -----  -----  ---------  --------------------------------");
  for (const row of rows) {
    const role = classifyRole(row);
    const maker = row.maker_enabled === 1 ? "yes" : "no";
    const taker = row.auto_trade_enabled === 1 ? "yes" : "no";
    const bal = fmt(Math.round(row.starting_balance));
    console.log(
      `${String(row.id).padStart(2)}  ${role.padEnd(8)}  ${maker.padEnd(5)}  ${taker.padEnd(5)}  ${bal.padStart(9)}  ${row.name}`
    );
  }

  console.log("\nRole counts:");
  console.log(
    `  maker=${byRole.MAKER}  taker=${byRole.TAKER}  arb=${byRole.ARB}  hybrid=${byRole.HYBRID}  disabled=${byRole.DISABLED}`
  );
  if (byRole.HYBRID > 0) {
    console.log("  WARNING: hybrid wallets detected (maker+taker both on).");
  }

  console.log("\nMaker health:");
  console.log(`  settings.maker_enabled = ${makerGateOn ? "1 (ON)" : `${makerGate?.value ?? "unset"} (OFF)`}`);
  console.log(`  maker orders (last 30m) = ${makerOrders30m}`);
  console.log(`  maker fills  (last 30m) = ${makerFills30m}`);
  console.log(`  taker orders (last 30m) = ${takerOrders30m}`);
  console.log(
    `  last maker order ts     = ${makerLastTs > 0 ? new Date(makerLastTs).toISOString() : "none"}`
  );

  console.log("\nQuick checks:");
  console.log("  1) Maker loop can run only if settings.maker_enabled = 1.");
  console.log("  2) Maker wallets must have maker_enabled=1 and auto_trade_enabled=0.");
  console.log("  3) Taker wallets must have auto_trade_enabled=1 and maker_enabled=0.\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { reset, auditOnly, dropMain } = args;
  const { sqlite } = getDb();

  if (!auditOnly) {
    console.log("\n=== Wallet Seed ===\n");
    if (reset) {
      const whereClause = dropMain ? "" : "WHERE id != 1";
      const deleted = sqlite.prepare(`DELETE FROM wallets ${whereClause}`).run().changes;
      console.log(`reset: deleted ${deleted} wallet(s)${dropMain ? " (including id=1)" : " (excluding id=1)"}`);
    }

    ensureMakerGate(sqlite);

    const seeds: WalletSeed[] = args.btcOnly ? [] : [...SEEDS];
    if (args.withBtc5m) {
      const marketIds = await fetchActiveBtc5mMarketIds(args);
      if (marketIds.length === 0) {
        const message =
          "No active BTC 5m markets found from Gamma in the configured window; BTC wallets were not updated.";
        if (args.requireBtc5m) {
          throw new Error(message);
        }
        console.warn(`warning: ${message}`);
      } else {
        console.log(`btc5m: resolved ${marketIds.length} market(s): ${marketIds.join(",")}`);
        if (args.btcOnly) {
          seeds.push(...buildBtc5mWalletSeeds(marketIds));
          seeds.push(...buildBtc5mArbWalletSeeds(marketIds, args.arbWalletCount));
        } else {
          const pinnedSeeds = pinSeedsToMarketIds(seeds, marketIds);
          seeds.length = 0;
          seeds.push(...pinnedSeeds);
          seeds.push(...buildBtc5mWalletSeeds(marketIds));
          seeds.push(...buildBtc5mArbWalletSeeds(marketIds, args.arbWalletCount));
        }
      }
    } else {
      console.log("btc5m: skipped by --no-btc-5m");
    }

    for (const seed of seeds) {
      const result = upsertWallet(sqlite, seed);
      console.log(
        `${result.action.padEnd(7)} id=${String(result.id).padStart(3)}  role=${seed.role.padEnd(5)}  ${seed.name}`
      );
    }
  }

  printAudit(sqlite);
}

try {
  await main();
} catch (err) {
  console.error("seed-wallets failed:", err);
  process.exit(1);
}
