#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  boolArg,
  numberArg,
  openReadOnlyDatabase,
  parseCliArgs,
  resolveRepoRoot,
  safeClose,
  stringArg
} from "./lib/db.js";
import {
  classifyMarketProfile,
  isProfileTradableInScope,
  type MarketScope
} from "../apps/worker/src/trading/MarketProfile.js";

type ActionableKind = "MAKER_BID" | "MAKER_ASK" | "TAKER_BUY" | "TAKER_SELL";

type BaseRow = {
  walletId: number | null;
  kind: string;
  marketQuestion: string | null;
  marketSlug: string | null;
  eventTitle: string | null;
  feeRateBps: number | null;
  takerBaseFee: number | null;
};

type FillRow = BaseRow & {
  orderId: number;
};

type MarkoutRow = BaseRow & {
  markoutBps: number | null;
  midAtFill: number | null;
  fillPrice: number | null;
  size: number | null;
};

type StrategySummary = {
  walletId: number;
  kind: ActionableKind;
  orderCount: number;
  fillCount: number;
  markoutCount: number;
  fillRate: number;
  meanBps: number | null;
  wavgBps: number | null;
  stdBps: number | null;
  seBps: number | null;
  lcb95Bps: number | null;
  ucb95Bps: number | null;
};

type WorkerRuntimeConfig = {
  marketScope?: MarketScope;
  arb?: { enabled?: boolean };
  taker?: { enabled?: boolean };
};

const ACTIONABLE_KINDS: readonly ActionableKind[] = [
  "MAKER_BID",
  "MAKER_ASK",
  "TAKER_BUY",
  "TAKER_SELL"
];

const ACTIONABLE_SET = new Set<string>(ACTIONABLE_KINDS);
const kindIsMaker = (kind: string): boolean => kind === "MAKER_BID" || kind === "MAKER_ASK";

const winsorize = (value: number, clipBps: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (clipBps <= 0) return value;
  if (value > clipBps) return clipBps;
  if (value < -clipBps) return -clipBps;
  return value;
};

const round = (value: number | null, digits = 4): number | null =>
  value == null || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(digits));

const z95 = 1.96;

const toMarketScope = (value: string): MarketScope => {
  if (value === "ALL" || value === "PROFILE_KNOWN_ONLY") {
    return value;
  }
  return "PROFILE_KNOWN_ONLY";
};

const profileInScope = (row: BaseRow, scope: MarketScope): boolean => {
  const profile = classifyMarketProfile({
    question: row.marketQuestion,
    slug: row.marketSlug,
    eventTitle: row.eventTitle,
    feeRateBps: row.feeRateBps,
    takerBaseFee: row.takerBaseFee
  });
  return isProfileTradableInScope(profile, scope);
};

const formatPercent = (value: number | null): string =>
  value == null || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(2)}%`;

const formatBps = (value: number | null): string =>
  value == null || !Number.isFinite(value) ? "n/a" : `${value.toFixed(3)} bps`;

const printRanked = (title: string, rows: StrategySummary[], limit: number): void => {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log("  (none)");
    return;
  }
  for (const row of rows.slice(0, limit)) {
    console.log(
      `  wallet=${row.walletId} kind=${row.kind}` +
      ` markouts=${row.markoutCount}` +
      ` fillRate=${formatPercent(row.fillRate)}` +
      ` mean=${formatBps(row.meanBps)}` +
      ` wavg=${formatBps(row.wavgBps)}` +
      ` lcb95=${formatBps(row.lcb95Bps)}`
    );
  }
};

const workerConfigPath = (repoRoot: string): string => path.join(repoRoot, "configs", "worker.json");

const readWorkerConfig = (repoRoot: string): WorkerRuntimeConfig => {
  try {
    return JSON.parse(readFileSync(workerConfigPath(repoRoot), "utf-8")) as WorkerRuntimeConfig;
  } catch {
    return {};
  }
};

const writeWorkerConfig = (repoRoot: string, config: WorkerRuntimeConfig): void => {
  const filePath = workerConfigPath(repoRoot);
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
};

function main(): void {
  const repoRoot = resolveRepoRoot();
  const args = parseCliArgs();
  const workerConfig = readWorkerConfig(repoRoot);

  const dbPath = stringArg(args, "db", path.join(repoRoot, "data", "dev.db"));
  const horizonMs = numberArg(args, "horizon-ms", 1_000);
  const windowHours = numberArg(args, "hours", 24);
  const minMarkouts = numberArg(args, "min-markouts", 20);
  const minFillRateMaker = numberArg(args, "min-fill-rate-maker", 0.04);
  const minFillRateTaker = numberArg(args, "min-fill-rate-taker", 0.9);
  const minLcbBps = numberArg(args, "min-lcb-bps", 0);
  const winsorClipBps = numberArg(args, "winsor-clip-bps", 250);
  const applyConfig = boolArg(args, "apply-config", false);
  const scope = toMarketScope(stringArg(
    args,
    "scope",
    workerConfig.marketScope ?? "PROFILE_KNOWN_ONLY"
  ));
  const sinceTs = Date.now() - (windowHours * 3600 * 1000);

  const sqlite = openReadOnlyDatabase(dbPath);

  const orders = sqlite.prepare(
    `SELECT
       o.wallet_id as walletId,
       o.kind as kind,
       m.question as marketQuestion,
       m.slug as marketSlug,
       e.title as eventTitle,
       t.fee_rate_bps as feeRateBps,
       m.taker_base_fee as takerBaseFee
     FROM shadow_orders o
     LEFT JOIN markets m ON m.id = o.market_id
     LEFT JOIN market_events e ON e.id = m.event_id
     LEFT JOIN tokens t ON t.id = o.token_id
     WHERE o.ts >= ?
       AND o.kind IN ('MAKER_BID', 'MAKER_ASK', 'TAKER_BUY', 'TAKER_SELL')`
  ).all(sinceTs) as BaseRow[];

  const fills = sqlite.prepare(
    `SELECT
       o.id as orderId,
       o.wallet_id as walletId,
       o.kind as kind,
       m.question as marketQuestion,
       m.slug as marketSlug,
       e.title as eventTitle,
       t.fee_rate_bps as feeRateBps,
       m.taker_base_fee as takerBaseFee
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     LEFT JOIN markets m ON m.id = o.market_id
     LEFT JOIN market_events e ON e.id = m.event_id
     LEFT JOIN tokens t ON t.id = o.token_id
     WHERE f.ts >= ?
       AND o.kind IN ('MAKER_BID', 'MAKER_ASK', 'TAKER_BUY', 'TAKER_SELL')`
  ).all(sinceTs) as FillRow[];

  const markouts = sqlite.prepare(
    `SELECT
       o.wallet_id as walletId,
       o.kind as kind,
       m.question as marketQuestion,
       m.slug as marketSlug,
       e.title as eventTitle,
       t.fee_rate_bps as feeRateBps,
       m.taker_base_fee as takerBaseFee,
       mk.markout_bps as markoutBps,
       mk.mid_at_fill as midAtFill,
       f.price as fillPrice,
       f.size as size
     FROM shadow_markouts mk
     JOIN shadow_fills f ON f.id = mk.fill_id
     JOIN shadow_orders o ON o.id = f.order_id
     LEFT JOIN markets m ON m.id = o.market_id
     LEFT JOIN market_events e ON e.id = m.event_id
     LEFT JOIN tokens t ON t.id = o.token_id
     WHERE mk.ts >= ?
       AND mk.horizon_ms = ?
       AND o.kind IN ('MAKER_BID', 'MAKER_ASK', 'TAKER_BUY', 'TAKER_SELL')`
  ).all(sinceTs, horizonMs) as MarkoutRow[];

  safeClose(sqlite);

  type MutableAgg = {
    walletId: number;
    kind: ActionableKind;
    orderCount: number;
    fillCount: number;
    markoutCount: number;
    sumBps: number;
    sumWeightedBps: number;
    sumNotional: number;
    sumWinsorBps: number;
    sumSqWinsorBps: number;
  };

  const agg = new Map<string, MutableAgg>();
  const ensure = (walletId: number, kind: ActionableKind): MutableAgg => {
    const key = `${walletId}|${kind}`;
    const existing = agg.get(key);
    if (existing) return existing;
    const created: MutableAgg = {
      walletId,
      kind,
      orderCount: 0,
      fillCount: 0,
      markoutCount: 0,
      sumBps: 0,
      sumWeightedBps: 0,
      sumNotional: 0,
      sumWinsorBps: 0,
      sumSqWinsorBps: 0
    };
    agg.set(key, created);
    return created;
  };

  for (const row of orders) {
    if (row.walletId == null) continue;
    if (!ACTIONABLE_SET.has(row.kind)) continue;
    if (!profileInScope(row, scope)) continue;
    const bucket = ensure(row.walletId, row.kind as ActionableKind);
    bucket.orderCount += 1;
  }

  const seenFilledOrders = new Set<string>();
  for (const row of fills) {
    if (row.walletId == null) continue;
    if (!ACTIONABLE_SET.has(row.kind)) continue;
    if (!profileInScope(row, scope)) continue;
    const fillKey = `${row.walletId}|${row.kind}|${row.orderId}`;
    if (seenFilledOrders.has(fillKey)) continue;
    seenFilledOrders.add(fillKey);
    const bucket = ensure(row.walletId, row.kind as ActionableKind);
    bucket.fillCount += 1;
  }

  for (const row of markouts) {
    if (row.walletId == null) continue;
    if (!ACTIONABLE_SET.has(row.kind)) continue;
    if (!profileInScope(row, scope)) continue;
    const markoutBps = row.markoutBps;
    const size = row.size;
    const mid = row.midAtFill ?? row.fillPrice;
    if (!Number.isFinite(markoutBps) || !Number.isFinite(size) || !Number.isFinite(mid)) continue;
    if ((size as number) <= 0 || (mid as number) <= 0) continue;

    const bucket = ensure(row.walletId, row.kind as ActionableKind);
    const notional = (mid as number) * (size as number);
    const clipped = winsorize(markoutBps as number, winsorClipBps);
    bucket.markoutCount += 1;
    bucket.sumBps += markoutBps as number;
    bucket.sumWeightedBps += (markoutBps as number) * notional;
    bucket.sumNotional += notional;
    bucket.sumWinsorBps += clipped;
    bucket.sumSqWinsorBps += clipped * clipped;
  }

  const summaries: StrategySummary[] = Array.from(agg.values()).map((row) => {
    const n = row.markoutCount;
    const fillRate = row.orderCount > 0 ? row.fillCount / row.orderCount : 0;
    const meanBps = n > 0 ? row.sumBps / n : null;
    const wavgBps = row.sumNotional > 0 ? row.sumWeightedBps / row.sumNotional : null;
    let stdBps: number | null = null;
    let seBps: number | null = null;
    if (n > 1) {
      const variance =
        (row.sumSqWinsorBps - ((row.sumWinsorBps * row.sumWinsorBps) / n)) / (n - 1);
      stdBps = Math.sqrt(Math.max(0, variance));
      seBps = stdBps / Math.sqrt(n);
    } else if (n === 1) {
      stdBps = 0;
      seBps = 0;
    }

    const lcb95Bps = meanBps != null && seBps != null ? meanBps - (z95 * seBps) : null;
    const ucb95Bps = meanBps != null && seBps != null ? meanBps + (z95 * seBps) : null;

    return {
      walletId: row.walletId,
      kind: row.kind,
      orderCount: row.orderCount,
      fillCount: row.fillCount,
      markoutCount: n,
      fillRate,
      meanBps: round(meanBps, 4),
      wavgBps: round(wavgBps, 4),
      stdBps: round(stdBps, 4),
      seBps: round(seBps, 4),
      lcb95Bps: round(lcb95Bps, 4),
      ucb95Bps: round(ucb95Bps, 4)
    };
  });

  const filtered = summaries.filter((row) => {
    if (row.markoutCount < minMarkouts) return false;
    const minFill = kindIsMaker(row.kind) ? minFillRateMaker : minFillRateTaker;
    if (row.fillRate < minFill) return false;
    return true;
  });

  const ranked = filtered.sort((a, b) => (b.lcb95Bps ?? -Infinity) - (a.lcb95Bps ?? -Infinity));
  const profitable = ranked.filter(
    (row) => (row.lcb95Bps ?? -Infinity) > minLcbBps && (row.wavgBps ?? -Infinity) > 0
  );
  const makerProfitable = profitable.filter((row) => kindIsMaker(row.kind));
  const topMaker = makerProfitable[0] ?? null;
  const topAny = profitable[0] ?? null;
  const selected = topMaker ?? topAny;

  console.log("\n" + "=".repeat(90));
  console.log("PROFITABLE STRATEGY SEARCH (SHADOW MARKOUT EVIDENCE)");
  console.log("=".repeat(90));
  console.log(`DB: ${dbPath}`);
  console.log(`Window: last ${windowHours}h | Horizon: ${horizonMs}ms`);
  console.log(`Scope: ${scope}`);
  console.log(`Rows: orders=${orders.length} fills=${fills.length} markouts=${markouts.length}`);
  console.log(`Thresholds: minMarkouts=${minMarkouts} minLCB=${minLcbBps}bps makerMinFillRate=${minFillRateMaker}`);

  printRanked("Top strategies by 95% LCB", ranked, 12);
  printRanked("Profitable maker-only candidates", makerProfitable, 8);

  if (!selected) {
    console.log("\nNo strategy crossed the configured profitability thresholds.");
    process.exitCode = 2;
    return;
  }

  console.log("\nSelected strategy:");
  console.log(
    `  wallet=${selected.walletId} kind=${selected.kind}` +
    ` markouts=${selected.markoutCount}` +
    ` fillRate=${formatPercent(selected.fillRate)}` +
    ` mean=${formatBps(selected.meanBps)}` +
    ` lcb95=${formatBps(selected.lcb95Bps)}`
  );

  if (!applyConfig) {
    console.log("\nDry run complete. Pass --apply-config=true to write recommended runtime settings.");
    return;
  }

  const nextConfig: WorkerRuntimeConfig = {
    ...workerConfig,
    marketScope: scope,
    arb: {
      ...(workerConfig.arb ?? {}),
      enabled: true
    },
    taker: {
      ...(workerConfig.taker ?? {}),
      enabled: true
    }
  };

  writeWorkerConfig(repoRoot, nextConfig);
  console.log(`\nUpdated runtime config: ${workerConfigPath(repoRoot)}`);
  console.log(
    `Applied profile -> scope=${nextConfig.marketScope}, taker.enabled=true, arb.enabled=true`
  );
}

main();
