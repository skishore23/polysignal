import { PerformanceClient } from "../performance/performance-client";
import { getPerformanceMetrics } from "../../lib/performance";
import { getEdgeCalibration } from "../../lib/edge-calibration";
import { getShadowKpi, getShadowKpiMultiHorizon } from "../../lib/shadowKpi";
import { getDb } from "../../lib/db";
import { wallets as walletsTable } from "@polysignal/storage";
import { parseWalletMarketFilterJson } from "@polysignal/utils";
import type { WalletMarketFilterV1 } from "@polysignal/types";

export const dynamic = "force-dynamic";

const HORIZON_MS: Record<string, number> = {
  "5m": 300_000,
  "10m": 600_000,
  "20m": 1_200_000
};

type Wallet = {
  id: number;
  name: string;
  makerEnabled: number | null;
  autoTradeEnabled: number | null;
  takerSide: string | null;
  minConfidence: number | null;
  minEdge: number | null;
  sizeMultiplier: number | null;
  marketAllowlist: string | null;
  marketFilterJson: string | null;
  marketFilter?: WalletMarketFilterV1 | null;
  maxDailyLossUsd: number | null;
  maxDrawdownPct: number | null;
  cooldownMinutes: number | null;
  makerQuoteSize: number | null;
  makerQuoteWidthBps: number | null;
};

type PerformancePageProps = {
  searchParams?: Promise<{ horizon?: string }>;
};

export default async function PerformancePage(props: PerformancePageProps) {
  const searchParams = (await (props.searchParams ?? Promise.resolve({}))) as { horizon?: string };
  const horizonParam = typeof searchParams.horizon === "string" ? searchParams.horizon : "10m";
  const horizon: "5m" | "10m" | "20m" =
    horizonParam === "5m" || horizonParam === "10m" || horizonParam === "20m" ? horizonParam : "10m";
  const horizonMs = HORIZON_MS[horizon] ?? HORIZON_MS["10m"];

  const { db, sqlite } = getDb();

  const walletsRaw: Wallet[] = db
    .select({
      id: walletsTable.id,
      name: walletsTable.name,
      makerEnabled: walletsTable.makerEnabled,
      autoTradeEnabled: walletsTable.autoTradeEnabled,
      takerSide: walletsTable.takerSide,
      minConfidence: walletsTable.minConfidence,
      minEdge: walletsTable.minEdge,
      sizeMultiplier: walletsTable.sizeMultiplier,
      marketAllowlist: walletsTable.marketAllowlist,
      marketFilterJson: walletsTable.marketFilterJson,
      maxDailyLossUsd: walletsTable.maxDailyLossUsd,
      maxDrawdownPct: walletsTable.maxDrawdownPct,
      cooldownMinutes: walletsTable.cooldownMinutes,
      makerQuoteSize: walletsTable.makerQuoteSize,
      makerQuoteWidthBps: walletsTable.makerQuoteWidthBps
    })
    .from(walletsTable)
    .all();
  const wallets = walletsRaw.map((w) => ({
    ...w,
    makerEnabled: w.makerEnabled ?? 0,
    autoTradeEnabled: w.autoTradeEnabled ?? 0,
    takerSide: w.takerSide ?? "NONE",
    minConfidence: w.minConfidence ?? 0,
    minEdge: w.minEdge ?? 0,
    sizeMultiplier: w.sizeMultiplier ?? 1,
    marketAllowlist: w.marketAllowlist ?? null,
    marketFilterJson: w.marketFilterJson ?? null,
    marketFilter: (() => {
      const parsed = parseWalletMarketFilterJson(w.marketFilterJson ?? null);
      return parsed.ok ? parsed.value : null;
    })(),
    maxDailyLossUsd: w.maxDailyLossUsd ?? null,
    maxDrawdownPct: w.maxDrawdownPct ?? null,
    cooldownMinutes: w.cooldownMinutes ?? null,
    makerQuoteSize: w.makerQuoteSize ?? null,
    makerQuoteWidthBps: w.makerQuoteWidthBps ?? null
  }));

  const initialData = getPerformanceMetrics(sqlite, null);
  const edgeCalibration = getEdgeCalibration(horizonMs);
  const initialLaneKpi = getShadowKpi(sqlite, {
    windowHours: 24,
    horizonMs,
    lane: "policy_v0"
  });
  const initialMultiHorizon = getShadowKpiMultiHorizon(sqlite, {
    windowHours: 24,
    lane: "policy_v0"
  });

  return (
    <div className="p-4 md:p-6 lg:p-10 max-w-8xl space-y-8">
      <PerformanceClient
        initialData={initialData}
        wallets={wallets}
        edgeCalibration={edgeCalibration}
        defaultHorizon={horizon}
        horizonMs={horizonMs}
        initialLaneKpi={initialLaneKpi}
        initialMultiHorizon={initialMultiHorizon}
      />
    </div>
  );
}
