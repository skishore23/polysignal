"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { DecisionFunnel } from "../../components/DecisionFunnel";
import { formatPct, formatNum, cn } from "../../lib/utils";
import type { WalletMarketFilterV1 } from "@polysignal/types";
import type {
  ShadowKpiResponse,
  ShadowKpiMultiHorizonResponse,
  ShadowKpiTimeTrendResponse,
  EdgeMapCell
} from "../../lib/shadowKpi";
import {
  TrendingUp,
  Target,
  Activity,
  Clock,
  BarChart3,
  Percent,
  ArrowUpRight,
  ArrowDownRight,
  Layers,
  Wallet,
  ChevronDown,
  RefreshCw,
  Gauge,
  Scale,
  Zap,
  Trophy,
  XCircle,
  Timer,
  BookOpen,
  CheckCircle2,
  HelpCircle,
  Ban
} from "lucide-react";

type TakerSystemMetrics = {
  fillCount: number;
  totalPositions: number;
  openPositions: number;
  closedPositions: number;
  realizedPnl: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgHoldSec: number;
};

type MakerSystemMetrics = {
  openPositions: number;
  totalRealized: number;
  totalUnrealized: number;
  netPnl: number;
  avgSpreadCapture: number;
  avgFillRate: number;
  avgQMin: number;
  rewardEligibleRate24h: number;
  rewardEligibleCount24h: number;
  rewardTotalCount24h: number;
  rewardAvgQMin24h: number;
  makerVolume24h: number;
  feeEquivalent24h: number;
  rebateUpperBound24h: number;
  rebatePoolPct: number;
  fillCount: number;
  longExposure: number;
  shortExposure: number;
};

type TimeOutsideBandMetric = {
  outsideBandCount: number;
  totalCount: number;
  pct: number;
};

type SkipBreakdown = {
  inventory_build: number;
  net_edge_le_0: number;
  [reason: string]: number;
};

type LaneRuntimeStatus = "running" | "idle" | "stalled" | "no_data";

type LaneRuntimeHealth = {
  status: LaneRuntimeStatus;
  reason: string;
  heartbeatTs: number | null;
  lastOrderTs: number | null;
  lastOrderTouchTs: number | null;
  lastRealFillTs: number | null;
  lastSkipTs: number | null;
  sinceHeartbeatSec: number | null;
  sinceOrderSec: number | null;
  sinceRealFillSec: number | null;
  orders5m: number;
  realFills5m: number;
  skips5m: number;
  orders30m: number;
  realFills30m: number;
  skips30m: number;
};

type RuntimeHealth = {
  nowTs: number;
  status: "running" | "degraded" | "stalled" | "no_data";
  reason: string;
  latestFeatureTs: number | null;
  feedFreshnessSec: number | null;
  signals5m: number;
  shadowSummaryUpdatedTs: number | null;
  shadowSummaryAgeSec: number | null;
  maker: LaneRuntimeHealth;
  taker: LaneRuntimeHealth;
};

type ConsolidatedMetrics = {
  totalRealized: number;
  totalUnrealized: number;
  netPnl: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  longExposure: number;
  shortExposure: number;
  inventorySkew: number;
  avgHoldSec: number;
  avgFillRate: number;
  avgSpreadCapture: number;
  taker: TakerSystemMetrics;
  maker: MakerSystemMetrics;
  timeOutsideBand: TimeOutsideBandMetric;
  skipBreakdown: SkipBreakdown;
  runtimeHealth: RuntimeHealth;
  ts: number;
};

type WalletInfo = {
  id: number;
  name: string;
  makerEnabled?: number | boolean;
  autoTradeEnabled?: number | boolean;
  takerSide?: string | null;
  minConfidence?: number | null;
  minEdge?: number | null;
  sizeMultiplier?: number | null;
  marketAllowlist?: string | null;
  marketFilterJson?: string | null;
  marketFilter?: WalletMarketFilterV1 | null;
  maxDailyLossUsd?: number | null;
  maxDrawdownPct?: number | null;
  cooldownMinutes?: number | null;
  makerQuoteSize?: number | null;
  makerQuoteWidthBps?: number | null;
};

type WalletType = "all" | "maker" | "taker";

type LedgerEntry = {
  id: number;
  runId: string;
  ts: number;
  gitHash: string | null;
  hypothesis: string;
  scope: string | null;
  confidence: string | null;
  paramsJson: string | null;
  resultsJson: string | null;
  verdict: string;
  nextAction: string | null;
  notes: string | null;
  runContextJson: string | null;
};

type ShadowKpiBucket = {
  spreadBucket: string;
  fills: number;
  notionalTotal: number;
  notionalPerDay: number;
  evBps5m: number | null;
  evBps10m: number | null;
  expectedDollarsPerDay: number | null;
};

type ShadowKpi = ShadowKpiResponse;

type ShadowSummary = {
  windowHours: number;
  maker: {
    orders: number;
    fills: number;
    fillRate: number | null;
    markout5s: number | null;
    markout30s: number | null;
    lastTs: number | null;
    realFills: number;
    syntheticFills: number;
    syntheticRatio: number | null;
  };
  taker: {
    orders: number;
    fills: number;
    fillRate: number | null;
    markout5s: number | null;
    markout30s: number | null;
    lastTs: number | null;
    realFills: number;
    syntheticFills: number;
    syntheticRatio: number | null;
  };
};

const formatCurrency = (value: number): string => {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
};

const formatUsd = (value: number | null, digits = 2): string => {
  if (value == null || Number.isNaN(value)) return "-";
  return `$${value.toFixed(digits)}`;
};

const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
};

type MetricCardProps = {
  icon: React.ReactNode;
  label: string;
  value: string;
  isPrimary?: boolean;
  isPositive?: boolean;
  isNegative?: boolean;
  isWarning?: boolean;
  helperText?: string;
};

const MetricCard = ({
  icon,
  label,
  value,
  isPrimary,
  isPositive,
  isNegative,
  isWarning,
  helperText
}: MetricCardProps) => (
  <Card
    className={cn("backdrop-blur-sm", isPrimary ? "bg-primary/5 border-primary/20" : "bg-card/30 border-border/40")}
  >
    <CardContent className="p-4">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <div
          className={cn(
            "text-[10px] font-mono uppercase tracking-widest",
            isPrimary ? "text-primary" : "text-muted-foreground"
          )}
        >
          {label}
        </div>
      </div>
      {helperText && <p className="text-xs text-muted-foreground font-mono mt-1 leading-snug">{helperText}</p>}
      <div
        className={cn(
          "text-2xl font-mono font-bold",
          isPositive && "text-neon-green",
          isNegative && "text-rose-500",
          isWarning && "text-muted-foreground",
          !isPositive && !isNegative && !isWarning && "text-foreground"
        )}
      >
        {value}
      </div>
    </CardContent>
  </Card>
);

type ExposureBarProps = {
  longExposure: number;
  shortExposure: number;
};

const ExposureBar = ({ longExposure, shortExposure }: ExposureBarProps) => {
  const total = longExposure + shortExposure;
  const longPct = total > 0 ? (longExposure / total) * 100 : 50;
  const shortPct = total > 0 ? (shortExposure / total) * 100 : 50;

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-[10px] font-mono uppercase tracking-tighter text-muted-foreground">
        <span className="flex items-center gap-1">
          <ArrowUpRight className="h-3 w-3 text-neon-green" />
          Long: {formatNum(longExposure, 2)}
        </span>
        <span className="flex items-center gap-1">
          Short: {formatNum(shortExposure, 2)}
          <ArrowDownRight className="h-3 w-3 text-rose-500" />
        </span>
      </div>
      <div className="h-2 bg-white/5 rounded-full overflow-hidden flex">
        <div className="h-full bg-neon-green/60 transition-all duration-500" style={{ width: `${longPct}%` }} />
        <div className="h-full bg-rose-500/60 transition-all duration-500" style={{ width: `${shortPct}%` }} />
      </div>
    </div>
  );
};

const formatAgeSeconds = (seconds: number | null): string => {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
};

const formatOptionalTs = (ts: number | null): string => {
  if (ts == null || !Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleTimeString();
};

const statusChipClass = (status: "running" | "degraded" | "stalled" | "no_data" | "idle"): string => {
  if (status === "running") return "bg-neon-green/10 text-neon-green border-neon-green/30";
  if (status === "degraded") return "bg-amber-400/10 text-amber-400 border-amber-400/30";
  if (status === "stalled") return "bg-rose-500/10 text-rose-500 border-rose-500/30";
  if (status === "idle") return "bg-sky-400/10 text-sky-300 border-sky-400/30";
  return "bg-muted/40 text-muted-foreground border-border/40";
};

const RuntimeLaneCard = ({ laneLabel, lane }: { laneLabel: "Maker" | "Taker"; lane: LaneRuntimeHealth }) => (
  <div className="rounded border border-border/40 bg-card/20 p-3 space-y-2">
    <div className="flex items-center justify-between">
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{laneLabel}</div>
      <span
        className={cn(
          "text-[10px] font-mono uppercase tracking-widest border px-2 py-0.5 rounded-sm",
          statusChipClass(lane.status)
        )}
      >
        {lane.status}
      </span>
    </div>
    <p className="text-[11px] font-mono text-foreground">{lane.reason}</p>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] font-mono">
      <div className="rounded border border-border/30 p-2">
        <div className="uppercase tracking-wider text-muted-foreground">Heartbeat age</div>
        <div className="font-bold text-foreground">{formatAgeSeconds(lane.sinceHeartbeatSec)}</div>
      </div>
      <div className="rounded border border-border/30 p-2">
        <div className="uppercase tracking-wider text-muted-foreground">Last order</div>
        <div className="font-bold text-foreground">{formatAgeSeconds(lane.sinceOrderSec)}</div>
      </div>
      <div className="rounded border border-border/30 p-2">
        <div className="uppercase tracking-wider text-muted-foreground">Last real fill</div>
        <div className="font-bold text-foreground">{formatAgeSeconds(lane.sinceRealFillSec)}</div>
      </div>
      <div className="rounded border border-border/30 p-2">
        <div className="uppercase tracking-wider text-muted-foreground">Last heartbeat</div>
        <div className="font-bold text-foreground">{formatOptionalTs(lane.heartbeatTs)}</div>
      </div>
      <div className="rounded border border-border/30 p-2">
        <div className="uppercase tracking-wider text-muted-foreground">Orders (5m)</div>
        <div className="font-bold text-foreground">{lane.orders5m}</div>
      </div>
      <div className="rounded border border-border/30 p-2">
        <div className="uppercase tracking-wider text-muted-foreground">Real fills (5m)</div>
        <div className="font-bold text-foreground">{lane.realFills5m}</div>
      </div>
      <div className="rounded border border-border/30 p-2">
        <div className="uppercase tracking-wider text-muted-foreground">Skips (5m)</div>
        <div className="font-bold text-foreground">{lane.skips5m}</div>
      </div>
      <div className="rounded border border-border/30 p-2">
        <div className="uppercase tracking-wider text-muted-foreground">Orders (30m)</div>
        <div className="font-bold text-foreground">{lane.orders30m}</div>
      </div>
    </div>
  </div>
);

const RuntimeHealthPanel = ({ runtime }: { runtime: RuntimeHealth }) => (
  <Card className="bg-card/30 border-neon-green/20 backdrop-blur-sm">
    <CardHeader className="border-b border-border/40 pb-3">
      <div className="flex items-center gap-2">
        <Gauge className="h-4 w-4 text-neon-green" />
        <CardTitle className="text-lg font-bold tracking-tight">Trading Runtime</CardTitle>
        <span
          className={cn(
            "ml-auto text-[10px] font-mono uppercase tracking-widest border px-2 py-0.5 rounded-sm",
            statusChipClass(runtime.status)
          )}
        >
          {runtime.status}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
        Clear liveness signal: is trading active, idle, or stalled right now?
      </p>
      <p className="text-[11px] font-mono text-foreground mt-2">{runtime.reason}</p>
    </CardHeader>
    <CardContent className="p-6 space-y-4">
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4 text-[10px] font-mono">
        <div className="rounded border border-border/40 bg-card/20 p-3">
          <div className="uppercase tracking-widest text-muted-foreground mb-1">Feed freshness</div>
          <div className="font-bold text-foreground">{formatAgeSeconds(runtime.feedFreshnessSec)}</div>
        </div>
        <div className="rounded border border-border/40 bg-card/20 p-3">
          <div className="uppercase tracking-widest text-muted-foreground mb-1">Signals (5m)</div>
          <div className="font-bold text-foreground">{runtime.signals5m}</div>
        </div>
        <div className="rounded border border-border/40 bg-card/20 p-3">
          <div className="uppercase tracking-widest text-muted-foreground mb-1">Shadow summary age</div>
          <div className="font-bold text-foreground">{formatAgeSeconds(runtime.shadowSummaryAgeSec)}</div>
        </div>
        <div className="rounded border border-border/40 bg-card/20 p-3">
          <div className="uppercase tracking-widest text-muted-foreground mb-1">Telemetry ts</div>
          <div className="font-bold text-foreground">{formatOptionalTs(runtime.nowTs)}</div>
        </div>
      </div>
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <RuntimeLaneCard laneLabel="Maker" lane={runtime.maker} />
        <RuntimeLaneCard laneLabel="Taker" lane={runtime.taker} />
      </div>
    </CardContent>
  </Card>
);

type ResearchPanelProps = {
  wallets: WalletInfo[];
  defaultHorizon?: "5m" | "10m" | "20m";
  onHorizonChange?: (horizon: "5m" | "10m" | "20m") => void;
};

const ResearchPanel = ({ wallets, defaultHorizon = "10m", onHorizonChange }: ResearchPanelProps) => {
  const active = wallets.filter((w) => Boolean(w.autoTradeEnabled));

  const fmtSide = (side?: string | null): string => {
    if (!side || side === "NONE") return "—";
    return side;
  };

  const allowlistCount = (allowlist?: string | null): number =>
    allowlist
      ? allowlist
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean).length
      : 0;

  const modeFor = (w: WalletInfo): string => {
    const makerOn = Boolean(w.makerEnabled);
    const takerOn = !!w.takerSide && w.takerSide !== "NONE";
    if (makerOn && takerOn) return "MIXED";
    if (makerOn) return "MAKER";
    if (takerOn) return "TAKER";
    return "OFF";
  };

  const filterSummary = (filter?: WalletMarketFilterV1 | null): string => {
    if (!filter) return "—";
    const parts: string[] = [];
    if (filter.includeMarketIds?.length) parts.push(`in:${filter.includeMarketIds.length}`);
    if (filter.excludeMarketIds?.length) parts.push(`out:${filter.excludeMarketIds.length}`);
    if (filter.minVolumeUsd != null || filter.maxVolumeUsd != null) {
      parts.push(`vol:${filter.minVolumeUsd ?? 0}-${filter.maxVolumeUsd ?? "inf"}`);
    }
    if (filter.minLiquidityUsd != null || filter.maxLiquidityUsd != null) {
      parts.push(`liq:${filter.minLiquidityUsd ?? 0}-${filter.maxLiquidityUsd ?? "inf"}`);
    }
    if (filter.requireActive) parts.push("active");
    if (filter.allowedKinds?.length) parts.push(`kinds:${filter.allowedKinds.length}`);
    return parts.length ? parts.join(" | ") : "v1";
  };

  return (
    <Card className="bg-card/40 border-border/50">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
          Research Mode
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono">
          <div className="rounded-md border border-border/40 p-3">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Objective</div>
            <div className="mt-2 text-sm text-foreground">System understanding (edge discovery)</div>
          </div>
          <div className="rounded-md border border-border/40 p-3">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Primary Horizon</div>
            <div className="mt-2 flex flex-wrap gap-1">
              {(["5m", "10m", "20m"] as const).map((h) => (
                <button
                  key={h}
                  onClick={() => onHorizonChange?.(h)}
                  className={cn(
                    "px-2 py-1 text-xs font-mono rounded border transition-colors",
                    defaultHorizon === h
                      ? "bg-neon-green/10 text-neon-green border-neon-green/30"
                      : "border-border/40 text-muted-foreground hover:text-foreground hover:border-border/60"
                  )}
                >
                  {h}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-md border border-border/40 p-3">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Active Wallets</div>
            <div className="mt-2 text-sm text-foreground">{active.length}</div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="text-left py-2 pr-4">Wallet</th>
                <th className="text-left py-2 pr-4">Mode</th>
                <th className="text-left py-2 pr-4">Side</th>
                <th className="text-right py-2 pr-4">MinConf</th>
                <th className="text-right py-2 pr-4">MinEdge</th>
                <th className="text-right py-2 pr-4">SizeMult</th>
                <th className="text-right py-2 pr-4">Allowlist</th>
                <th className="text-left py-2 pr-4">Filter</th>
                <th className="text-right py-2">MaxLoss</th>
              </tr>
            </thead>
            <tbody>
              {active.map((w) => (
                <tr key={w.id} className="border-t border-border/30 text-foreground/90">
                  <td className="py-2 pr-4">
                    {w.name} <span className="text-muted-foreground">#{w.id}</span>
                  </td>
                  <td className="py-2 pr-4">{modeFor(w)}</td>
                  <td className="py-2 pr-4">{fmtSide(w.takerSide)}</td>
                  <td className="py-2 pr-4 text-right">{w.minConfidence != null ? w.minConfidence.toFixed(2) : "—"}</td>
                  <td className="py-2 pr-4 text-right">{w.minEdge != null ? w.minEdge.toFixed(3) : "—"}</td>
                  <td className="py-2 pr-4 text-right">
                    {w.sizeMultiplier != null ? w.sizeMultiplier.toFixed(2) : "—"}
                  </td>
                  <td className="py-2 pr-4 text-right">{allowlistCount(w.marketAllowlist)}</td>
                  <td className="py-2 pr-4 text-[11px] text-muted-foreground">{filterSummary(w.marketFilter)}</td>
                  <td className="py-2 text-right">{w.maxDailyLossUsd != null ? formatUsd(w.maxDailyLossUsd) : "—"}</td>
                </tr>
              ))}
              {active.length === 0 && (
                <tr>
                  <td className="py-3 text-muted-foreground" colSpan={9}>
                    No active wallets detected.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
};

type WalletSelectorProps = {
  wallets: WalletInfo[];
  activeWalletId: number | null;
  onSelect: (id: number | null) => void;
  isLoading: boolean;
};

const WalletSelector = ({ wallets, activeWalletId, onSelect, isLoading }: WalletSelectorProps) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const activeWallet = wallets.find((w) => w.id === activeWalletId);

  const getWalletLabel = (wallet: WalletInfo) => wallet.name;
  const getWalletTypeLabel = (wallet: WalletInfo) => (wallet.makerEnabled ? "Maker" : "Taker");

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isLoading}
        className={cn(
          "flex items-center gap-2 hover:bg-secondary/50 px-3 py-2 rounded-sm transition-colors group border border-border/40",
          isLoading && "opacity-50 cursor-not-allowed"
        )}
      >
        <div className="h-6 w-6 rounded-sm bg-neon-green/10 flex items-center justify-center border border-neon-green/20 group-hover:border-neon-green/50 transition-colors">
          {isLoading ? (
            <RefreshCw className="h-3.5 w-3.5 text-neon-green animate-spin" />
          ) : (
            <Wallet className="h-3.5 w-3.5 text-neon-green" />
          )}
        </div>
        <span className="font-mono font-bold text-sm tracking-tight text-foreground">
          {activeWallet ? getWalletLabel(activeWallet) : "All Wallets"}
        </span>
        {activeWallet && (
          <span
            className={cn(
              "ml-1.5 text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border",
              activeWallet.makerEnabled
                ? "bg-neon-green/10 text-neon-green border-neon-green/30"
                : "bg-secondary/40 text-muted-foreground border-border/60"
            )}
          >
            {getWalletTypeLabel(activeWallet)}
          </span>
        )}
        <ChevronDown
          className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200", isOpen && "rotate-180")}
        />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-transparent" onClick={() => setIsOpen(false)} />
          <div className="absolute top-full right-0 mt-1 w-64 bg-card border border-border/60 rounded-sm shadow-xl z-50 animate-in fade-in slide-in-from-top-1">
            <div className="p-1 max-h-[300px] overflow-y-auto">
              <button
                onClick={() => {
                  onSelect(null);
                  setIsOpen(false);
                }}
                className={cn(
                  "w-full text-left px-3 py-2 text-xs font-mono rounded-sm flex items-center justify-between group",
                  activeWalletId === null
                    ? "bg-neon-green/10 text-neon-green"
                    : "hover:bg-secondary/50 text-muted-foreground hover:text-foreground"
                )}
              >
                <span>All Wallets</span>
                {activeWalletId === null && (
                  <div className="h-1.5 w-1.5 rounded-full bg-neon-green shadow-[0_0_5px_rgba(74,222,128,0.5)]" />
                )}
              </button>

              <div className="h-px bg-border/40 my-1" />

              {wallets.map((w) => (
                <button
                  key={w.id}
                  onClick={() => {
                    onSelect(w.id);
                    setIsOpen(false);
                  }}
                  className={cn(
                    "w-full text-left px-3 py-2 text-xs font-mono rounded-sm flex items-center justify-between group",
                    activeWalletId === w.id
                      ? "bg-neon-green/10 text-neon-green"
                      : "hover:bg-secondary/50 text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span className="flex items-center gap-2">
                    {w.name}
                    <span
                      className={cn(
                        "text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border",
                        w.makerEnabled
                          ? "bg-neon-green/10 text-neon-green border-neon-green/30"
                          : "bg-secondary/40 text-muted-foreground border-border/60"
                      )}
                    >
                      {getWalletTypeLabel(w)}
                    </span>
                  </span>
                  {activeWalletId === w.id && (
                    <div className="h-1.5 w-1.5 rounded-full bg-neon-green shadow-[0_0_5px_rgba(74,222,128,0.5)]" />
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// ============================================================================
// MAKER-SPECIFIC VIEW (Inventory-focused)
// ============================================================================

const MakerPerformanceView = ({ data }: { data: ConsolidatedMetrics }) => {
  const maker = data.maker;
  const totalExposure = maker.longExposure + maker.shortExposure;
  const rewardSampleHelper =
    maker.rewardTotalCount24h > 0
      ? `${maker.rewardEligibleCount24h}/${maker.rewardTotalCount24h} quotes`
      : "No reward samples (24h)";

  return (
    <div className="space-y-6">
      {/* Primary Metrics - Inventory Focus */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <MetricCard
          icon={<TrendingUp className="h-4 w-4 text-primary" />}
          label="Gross PnL"
          value={formatCurrency(maker.netPnl)}
          isPrimary
          isPositive={maker.netPnl > 0}
          isNegative={maker.netPnl < 0}
          helperText="Shadow; fees and missing marks excluded"
        />
        <MetricCard
          icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
          label="Spread Capture"
          value={formatPct(maker.avgSpreadCapture)}
          isPositive={maker.avgSpreadCapture > 0.01}
        />
        <MetricCard
          icon={<Percent className="h-4 w-4 text-muted-foreground" />}
          label="Shadow Fill Rate"
          value={formatPct(maker.avgFillRate)}
          isPositive={maker.avgFillRate > 0.5}
          helperText="Shadow (24h)"
        />
        <MetricCard
          icon={<Gauge className="h-4 w-4 text-muted-foreground" />}
          label="Q-Min"
          value={formatNum(maker.avgQMin, 4)}
        />
        <MetricCard
          icon={<Scale className="h-4 w-4 text-muted-foreground" />}
          label="Inventory Skew"
          value={`${(data.inventorySkew * 100).toFixed(1)}%`}
          isWarning={Math.abs(data.inventorySkew) > 0.3}
        />
        <MetricCard
          icon={<Zap className="h-4 w-4 text-muted-foreground" />}
          label="Total Fills"
          value={maker.fillCount.toLocaleString()}
        />
      </div>

      {/* Inventory & Exposure */}
      <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-3">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-blue-400" />
            <CardTitle className="text-lg font-bold tracking-tight">Inventory Management</CardTitle>
          </div>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Position exposure and balance across markets
          </p>
        </CardHeader>
        <CardContent className="p-6 space-y-6">
          <ExposureBar longExposure={maker.longExposure} shortExposure={maker.shortExposure} />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Long Exposure
              </div>
              <div className="text-2xl font-mono font-bold text-neon-green">{formatNum(maker.longExposure, 2)}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Short Exposure
              </div>
              <div className="text-2xl font-mono font-bold text-rose-500">{formatNum(maker.shortExposure, 2)}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Total Exposure
              </div>
              <div className="text-2xl font-mono font-bold">{formatNum(totalExposure, 2)}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Open Positions
              </div>
              <div className="text-2xl font-mono font-bold">{maker.openPositions}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* PnL Breakdown */}
      <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-3">
          <CardTitle className="text-lg font-bold tracking-tight">PnL Breakdown</CardTitle>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Realized from closed trades, unrealized from open inventory
          </p>
        </CardHeader>
        <CardContent className="p-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Realized
              </div>
              <div
                className={cn(
                  "text-3xl font-mono font-bold",
                  maker.totalRealized > 0 ? "text-neon-green" : "text-rose-500"
                )}
              >
                {formatCurrency(maker.totalRealized)}
              </div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Unrealized
              </div>
              <div
                className={cn(
                  "text-3xl font-mono font-bold",
                  maker.totalUnrealized > 0 ? "text-neon-green" : "text-rose-500"
                )}
              >
                {formatCurrency(maker.totalUnrealized)}
              </div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Gross Total
              </div>
              <div
                className={cn("text-3xl font-mono font-bold", maker.netPnl > 0 ? "text-neon-green" : "text-rose-500")}
              >
                {formatCurrency(maker.netPnl)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Market Making Efficiency */}
      <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-3">
          <CardTitle className="text-lg font-bold tracking-tight">Market Making Efficiency</CardTitle>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Quote quality and execution metrics
          </p>
        </CardHeader>
        <CardContent className="p-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Spread Capture
              </div>
              <div
                className={cn(
                  "text-2xl font-mono font-bold",
                  maker.avgSpreadCapture > 0.01 ? "text-neon-green" : "text-foreground"
                )}
              >
                {formatPct(maker.avgSpreadCapture)}
              </div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Shadow Fill Rate
              </div>
              <div
                className={cn(
                  "text-2xl font-mono font-bold",
                  maker.avgFillRate > 0.5 ? "text-neon-green" : "text-foreground"
                )}
              >
                {formatPct(maker.avgFillRate)}
              </div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Q-Min Score
              </div>
              <div className="text-2xl font-mono font-bold">{formatNum(maker.avgQMin, 4)}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Total Fills
              </div>
              <div className="text-2xl font-mono font-bold">{maker.fillCount.toLocaleString()}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Rewards & Rebates (Shadow) */}
      <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-3">
          <CardTitle className="text-lg font-bold tracking-tight">Rewards & Rebates (Shadow)</CardTitle>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            24h snapshot using shadow fills and reward estimates
          </p>
        </CardHeader>
        <CardContent className="p-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Eligible Quotes
              </div>
              <div className="text-2xl font-mono font-bold text-neon-green">
                {formatPct(maker.rewardEligibleRate24h)}
              </div>
              <div className="text-[10px] font-mono text-muted-foreground mt-1">{rewardSampleHelper}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Avg Q-Min (24h)
              </div>
              <div className="text-2xl font-mono font-bold">{formatNum(maker.rewardAvgQMin24h, 4)}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Fee Equivalent (24h)
              </div>
              <div className="text-2xl font-mono font-bold">{formatUsd(maker.feeEquivalent24h, 2)}</div>
              <div className="text-[10px] font-mono text-muted-foreground mt-1">Fee curve weighted</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Rebate Upper Bound
              </div>
              <div className="text-2xl font-mono font-bold text-neon-green">
                {formatUsd(maker.rebateUpperBound24h, 2)}
              </div>
              <div className="text-[10px] font-mono text-muted-foreground mt-1">
                Pool {(maker.rebatePoolPct * 100).toFixed(0)}% of fees
              </div>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-4">
            Upper bound assumes 100% share of market reward pool. Actual payouts depend on global Q-min.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

// ============================================================================
// TAKER-SPECIFIC VIEW (Position-focused)
// ============================================================================

const TakerPerformanceView = ({ data }: { data: ConsolidatedMetrics }) => {
  const taker = data.taker;

  return (
    <div className="space-y-6">
      {/* Primary Metrics - Position Focus */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <MetricCard
          icon={<TrendingUp className="h-4 w-4 text-primary" />}
          label="Realized PnL"
          value={formatCurrency(taker.realizedPnl)}
          isPrimary
          isPositive={taker.realizedPnl > 0}
          isNegative={taker.realizedPnl < 0}
        />
        <MetricCard
          icon={<Target className="h-4 w-4 text-muted-foreground" />}
          label="Win Rate"
          value={formatPct(taker.winRate)}
          isPositive={taker.winRate > 0.5}
          isNegative={taker.winRate < 0.4}
        />
        <MetricCard
          icon={<Trophy className="h-4 w-4 text-muted-foreground" />}
          label="Wins"
          value={taker.winCount.toString()}
          isPositive={taker.winCount > 0}
        />
        <MetricCard
          icon={<XCircle className="h-4 w-4 text-muted-foreground" />}
          label="Losses"
          value={taker.lossCount.toString()}
          isNegative={taker.lossCount > 0}
        />
        <MetricCard
          icon={<Timer className="h-4 w-4 text-muted-foreground" />}
          label="Avg Hold"
          value={formatDuration(taker.avgHoldSec)}
        />
        <MetricCard
          icon={<Activity className="h-4 w-4 text-muted-foreground" />}
          label="Total Trades"
          value={taker.totalPositions.toString()}
        />
      </div>

      {/* Position Summary */}
      <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-3">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-lg font-bold tracking-tight">Position Summary</CardTitle>
          </div>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Open and closed position counts
          </p>
        </CardHeader>
        <CardContent className="p-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Open Positions
              </div>
              <div className="text-3xl font-mono font-bold text-blue-400">{taker.openPositions}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Closed Positions
              </div>
              <div className="text-3xl font-mono font-bold">{taker.closedPositions}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Total Positions
              </div>
              <div className="text-3xl font-mono font-bold">{taker.totalPositions}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Win/Loss Analysis */}
      <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-3">
          <CardTitle className="text-lg font-bold tracking-tight">Win/Loss Analysis</CardTitle>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Trade outcome breakdown
          </p>
        </CardHeader>
        <CardContent className="p-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Closed Trades
              </div>
              <div className="text-2xl font-mono font-bold">{taker.closedPositions}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">Wins</div>
              <div className="text-2xl font-mono font-bold text-neon-green">{taker.winCount}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">Losses</div>
              <div className="text-2xl font-mono font-bold text-rose-500">{taker.lossCount}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
                Win Rate
              </div>
              <div
                className={cn(
                  "text-2xl font-mono font-bold",
                  taker.winRate > 0.5 ? "text-neon-green" : "text-rose-500"
                )}
              >
                {formatPct(taker.winRate)}
              </div>
            </div>
          </div>

          {/* Win/Loss Bar */}
          <div className="mt-6 space-y-2">
            <div className="flex justify-between text-[10px] font-mono uppercase tracking-tighter text-muted-foreground">
              <span className="text-neon-green">Wins: {taker.winCount}</span>
              <span className="text-rose-500">Losses: {taker.lossCount}</span>
            </div>
            <div className="h-2 bg-white/5 rounded-full overflow-hidden flex">
              {taker.closedPositions > 0 && (
                <>
                  <div
                    className="h-full bg-neon-green/60 transition-all duration-500"
                    style={{ width: `${(taker.winCount / taker.closedPositions) * 100}%` }}
                  />
                  <div
                    className="h-full bg-rose-500/60 transition-all duration-500"
                    style={{ width: `${(taker.lossCount / taker.closedPositions) * 100}%` }}
                  />
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Timing Metrics */}
      <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-3">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-lg font-bold tracking-tight">Timing Metrics</CardTitle>
          </div>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Position hold time analysis
          </p>
        </CardHeader>
        <CardContent className="p-6">
          <div className="text-center">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
              Average Hold Time
            </div>
            <div className="text-4xl font-mono font-bold">{formatDuration(taker.avgHoldSec)}</div>
          </div>
        </CardContent>
      </Card>

      {/* PnL Summary */}
      <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-3">
          <CardTitle className="text-lg font-bold tracking-tight">PnL Summary</CardTitle>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Realized profit and loss from closed positions
          </p>
        </CardHeader>
        <CardContent className="p-6">
          <div className="text-center">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
              Total Realized PnL
            </div>
            <div
              className={cn(
                "text-4xl font-mono font-bold",
                taker.realizedPnl > 0 ? "text-neon-green" : "text-rose-500"
              )}
            >
              {formatCurrency(taker.realizedPnl)}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

// ============================================================================
// CONSOLIDATED VIEW (All Wallets)
// ============================================================================

const ConsolidatedPerformanceView = ({ data }: { data: ConsolidatedMetrics }) => (
  <div className="space-y-6">
    {/* Summary Cards */}
    <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
      <MetricCard
        icon={<TrendingUp className="h-4 w-4 text-primary" />}
        label="Gross PnL"
        value={formatCurrency(data.netPnl)}
        isPrimary
        isPositive={data.netPnl > 0}
        isNegative={data.netPnl < 0}
        helperText="Shadow; fees and missing marks excluded"
      />
      <MetricCard
        icon={<Target className="h-4 w-4 text-muted-foreground" />}
        label="Win Rate (Taker)"
        value={formatPct(data.winRate)}
        isPositive={data.winRate > 0.5}
      />
      <MetricCard
        icon={<Activity className="h-4 w-4 text-muted-foreground" />}
        label="Taker Closed + Maker Fills"
        value={data.totalTrades.toLocaleString()}
      />
      <MetricCard
        icon={<Clock className="h-4 w-4 text-muted-foreground" />}
        label="Avg Hold (Taker)"
        value={formatDuration(data.avgHoldSec)}
      />
      <MetricCard
        icon={<Percent className="h-4 w-4 text-muted-foreground" />}
        label="Shadow Fill Rate (Maker)"
        value={formatPct(data.avgFillRate)}
      />
      <MetricCard
        icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
        label="Spread Capture (Maker)"
        value={formatPct(data.avgSpreadCapture)}
      />
    </div>

    {/* PnL Breakdown */}
    <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
      <CardHeader className="border-b border-border/40 pb-3">
        <CardTitle className="text-lg font-bold tracking-tight">PnL Breakdown</CardTitle>
        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
          Realized (Taker + Maker) and unrealized (Maker inventory)
        </p>
      </CardHeader>
      <CardContent className="p-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
          <div className="text-center">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">Realized</div>
            <div
              className={cn(
                "text-3xl font-mono font-bold",
                data.totalRealized > 0 ? "text-neon-green" : "text-rose-500"
              )}
            >
              {formatCurrency(data.totalRealized)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
              Unrealized
            </div>
            <div
              className={cn(
                "text-3xl font-mono font-bold",
                data.totalUnrealized > 0 ? "text-neon-green" : "text-rose-500"
              )}
            >
              {formatCurrency(data.totalUnrealized)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
              Gross Total
            </div>
            <div className={cn("text-3xl font-mono font-bold", data.netPnl > 0 ? "text-neon-green" : "text-rose-500")}>
              {formatCurrency(data.netPnl)}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    {/* Side-by-Side System Breakdown */}
    <div className="grid gap-4 md:grid-cols-2">
      {/* Taker System */}
      <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-3">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-muted-foreground" />
            <CardTitle className="text-lg font-bold tracking-tight">Taker (Shadow)</CardTitle>
          </div>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Directional positions: PnL, win rate, hold time
          </p>
        </CardHeader>
        <CardContent className="p-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">Realized PnL</div>
              <div
                className={cn(
                  "text-lg font-mono font-bold",
                  data.taker.realizedPnl > 0 ? "text-neon-green" : "text-rose-500"
                )}
              >
                {formatCurrency(data.taker.realizedPnl)}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">Win Rate</div>
              <div
                className={cn(
                  "text-lg font-mono font-bold",
                  data.taker.winRate > 0.5 ? "text-neon-green" : "text-foreground"
                )}
              >
                {formatPct(data.taker.winRate)}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">
                Wins / Losses
              </div>
              <div className="text-lg font-mono font-bold">
                <span className="text-neon-green">{data.taker.winCount}</span>
                <span className="text-muted-foreground"> / </span>
                <span className="text-rose-500">{data.taker.lossCount}</span>
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">Avg Hold</div>
              <div className="text-lg font-mono font-bold">{formatDuration(data.taker.avgHoldSec)}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Maker System */}
      <Card className="bg-card/30 border-blue-500/20 backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-3">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-blue-400" />
            <CardTitle className="text-lg font-bold tracking-tight">Maker (Market Making)</CardTitle>
          </div>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Quotes & inventory: spread capture, fill rate, exposure
          </p>
        </CardHeader>
        <CardContent className="p-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">
                Gross PnL (Shadow)
              </div>
              <div
                className={cn(
                  "text-lg font-mono font-bold",
                  data.maker.netPnl > 0 ? "text-neon-green" : "text-rose-500"
                )}
              >
                {formatCurrency(data.maker.netPnl)}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">
                Spread Capture
              </div>
              <div className="text-lg font-mono font-bold">{formatPct(data.maker.avgSpreadCapture)}</div>
            </div>
            <div className="space-y-1">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">
                Shadow Fill Rate
              </div>
              <div className="text-lg font-mono font-bold">{formatPct(data.maker.avgFillRate)}</div>
            </div>
            <div className="space-y-1">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">
                Inventory Skew
              </div>
              <div
                className={cn(
                  "text-lg font-mono font-bold",
                  Math.abs(data.inventorySkew) > 0.3 ? "text-muted-foreground" : "text-foreground"
                )}
              >
                {(data.inventorySkew * 100).toFixed(1)}%
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    {/* Exposure (from Maker) */}
    <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
      <CardHeader className="border-b border-border/40 pb-3">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-lg font-bold tracking-tight">Maker Exposure</CardTitle>
        </div>
        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
          Current inventory exposure from market making
        </p>
      </CardHeader>
      <CardContent className="p-6 space-y-6">
        <ExposureBar longExposure={data.longExposure} shortExposure={data.shortExposure} />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
          <div className="text-center">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
              Long Exposure
            </div>
            <div className="text-2xl font-mono font-bold text-neon-green">{formatNum(data.longExposure, 2)}</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
              Short Exposure
            </div>
            <div className="text-2xl font-mono font-bold text-rose-500">{formatNum(data.shortExposure, 2)}</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter mb-2">
              Inventory Skew
            </div>
            <div
              className={cn(
                "text-2xl font-mono font-bold",
                Math.abs(data.inventorySkew) > 0.3 ? "text-muted-foreground" : "text-foreground"
              )}
            >
              {(data.inventorySkew * 100).toFixed(1)}%
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    {/* Inventory skew metrics: time outside band + skip breakdown */}
    <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
      <CardHeader className="border-b border-border/40 pb-3">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-lg font-bold tracking-tight">Inventory Skew Metrics</CardTitle>
        </div>
        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
          Time outside band and skip breakdown (24h)
        </p>
      </CardHeader>
      <CardContent className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div className="space-y-2">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">
              Time Outside Band
            </div>
            <div className="text-lg font-mono font-bold">
              {data.timeOutsideBand != null && data.timeOutsideBand.totalCount > 0
                ? `${data.timeOutsideBand.pct.toFixed(1)}%`
                : "—"}
            </div>
            {data.timeOutsideBand != null && data.timeOutsideBand.totalCount > 0 && (
              <div className="text-xs text-muted-foreground font-mono">
                {data.timeOutsideBand.outsideBandCount} / {data.timeOutsideBand.totalCount} maker decisions
              </div>
            )}
          </div>
          <div className="space-y-2">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">Skip Breakdown</div>
            <ul className="text-sm font-mono space-y-1">
              {data.skipBreakdown &&
                Object.entries(data.skipBreakdown)
                  .filter(([, n]) => Number(n) > 0)
                  .map(([reason, n]) => (
                    <li key={reason}>
                      <span className="text-muted-foreground">{reason}:</span>{" "}
                      <span className="font-semibold">{Number(n)}</span>
                    </li>
                  ))}
              {(!data.skipBreakdown || Object.keys(data.skipBreakdown).length === 0) && (
                <li className="text-muted-foreground">No skips in window</li>
              )}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
);

// ============================================================================
// MAIN COMPONENT
// ============================================================================

type EdgeCalibrationData = {
  taker: {
    kind: string;
    buckets: Array<{ label: string; count: number; avgRealizedMarkoutBps: number | null }>;
    decomposition: {
      avgPredEdgeBps: number | null;
      avgSpreadBps: number | null;
      avgFeesBps: number | null;
      avgExpectedSlippageBps: number | null;
      avgCostBps: number | null;
      avgNetEdgeBps: number | null;
      avgRealizedMarkoutBps: number | null;
      fillCount: number;
    };
  };
  maker: {
    kind: string;
    buckets: Array<{ label: string; count: number; avgRealizedMarkoutBps: number | null }>;
    decomposition: {
      avgPredEdgeBps: number | null;
      avgSpreadBps: number | null;
      avgFeesBps: number | null;
      avgExpectedSlippageBps: number | null;
      avgCostBps: number | null;
      avgNetEdgeBps: number | null;
      avgRealizedMarkoutBps: number | null;
      fillCount: number;
    };
  };
  combined: {
    takerRealizedMarkoutBps: number | null;
    makerRealizedMarkoutBps: number | null;
    takerFills: number;
    makerFills: number;
    takerWinRate: number;
    makerFillRate: number;
  };
  diagnostics?: {
    taker: {
      fills_total: number;
      fills_with_markout: number;
      fills_with_pred_edge: number;
      fills_in_calibration: number;
    };
  };
};

type PerformanceClientProps = {
  initialData: ConsolidatedMetrics;
  wallets: WalletInfo[];
  edgeCalibration?: EdgeCalibrationData;
  defaultHorizon?: "5m" | "10m" | "20m";
  horizonMs?: number;
  initialLaneKpi?: ShadowKpiResponse | null;
  initialMultiHorizon?: ShadowKpiMultiHorizonResponse | null;
};

export function PerformanceClient({
  initialData,
  wallets,
  edgeCalibration,
  defaultHorizon = "10m",
  horizonMs = 600_000,
  initialLaneKpi = null,
  initialMultiHorizon = null
}: PerformanceClientProps) {
  const [data, setData] = React.useState<ConsolidatedMetrics>(initialData);
  const [activeWalletId, setActiveWalletId] = React.useState<number | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [selectedLane, setSelectedLane] = React.useState<"policy_v0" | "all">("policy_v0");
  const [laneKpi, setLaneKpi] = React.useState<ShadowKpiResponse | null>(initialLaneKpi ?? null);
  const [laneKpiLoading, setLaneKpiLoading] = React.useState(false);
  const [multiHorizonKpi, setMultiHorizonKpi] = React.useState<ShadowKpiMultiHorizonResponse | null>(
    initialMultiHorizon ?? null
  );
  const [multiHorizonLoading, setMultiHorizonLoading] = React.useState(false);
  const [timeTrendKpi, setTimeTrendKpi] = React.useState<ShadowKpiTimeTrendResponse | null>(null);
  const [timeTrendLoading, setTimeTrendLoading] = React.useState(false);
  const [shadow, setShadow] = React.useState<ShadowSummary | null>(null);
  const [shadowLoading, setShadowLoading] = React.useState(false);
  const [viewMode, setViewMode] = React.useState<WalletType>("all");
  const [lastUpdatedTs, setLastUpdatedTs] = React.useState<number>(Date.now());
  const [ledgerEntries, setLedgerEntries] = React.useState<LedgerEntry[] | null>(null);
  const [ledgerLoading, setLedgerLoading] = React.useState(false);
  const [edgeMapCells, setEdgeMapCells] = React.useState<EdgeMapCell[] | null>(null);
  const [edgeMapLoading, setEdgeMapLoading] = React.useState(false);
  const [showDiagnostics, setShowDiagnostics] = React.useState(false);

  const defaultTimeOutsideBand: TimeOutsideBandMetric = {
    outsideBandCount: 0,
    totalCount: 0,
    pct: 0
  };
  const defaultSkipBreakdown: SkipBreakdown = { inventory_build: 0, net_edge_le_0: 0 };
  const defaultLaneRuntimeHealth: LaneRuntimeHealth = {
    status: "no_data",
    reason: "no telemetry",
    heartbeatTs: null,
    lastOrderTs: null,
    lastOrderTouchTs: null,
    lastRealFillTs: null,
    lastSkipTs: null,
    sinceHeartbeatSec: null,
    sinceOrderSec: null,
    sinceRealFillSec: null,
    orders5m: 0,
    realFills5m: 0,
    skips5m: 0,
    orders30m: 0,
    realFills30m: 0,
    skips30m: 0
  };
  const defaultRuntimeHealth: RuntimeHealth = {
    nowTs: Date.now(),
    status: "no_data",
    reason: "no runtime telemetry yet",
    latestFeatureTs: null,
    feedFreshnessSec: null,
    signals5m: 0,
    shadowSummaryUpdatedTs: null,
    shadowSummaryAgeSec: null,
    maker: defaultLaneRuntimeHealth,
    taker: defaultLaneRuntimeHealth
  };

  const fetchPerformance = React.useCallback(async (walletId: number | null, options?: { silent?: boolean }) => {
    if (!options?.silent) setIsLoading(true);
    try {
      const url = walletId ? `/api/performance?walletId=${walletId}` : "/api/performance";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`performance fetch failed: ${res.status}`);
      const raw = await res.json();
      const newData: ConsolidatedMetrics = {
        ...raw,
        timeOutsideBand: raw.timeOutsideBand ?? defaultTimeOutsideBand,
        skipBreakdown: raw.skipBreakdown ?? defaultSkipBreakdown,
        runtimeHealth: raw.runtimeHealth ?? defaultRuntimeHealth
      };
      setData(newData);
      setLastUpdatedTs(Date.now());
    } catch (error) {
      console.error("Failed to fetch performance metrics", error);
    } finally {
      if (!options?.silent) setIsLoading(false);
    }
  }, []);

  const fetchShadow = React.useCallback(async (walletId: number | null, options?: { silent?: boolean }) => {
    if (!options?.silent) setShadowLoading(true);
    try {
      const url = walletId ? `/api/shadow?walletId=${walletId}` : "/api/shadow";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`shadow fetch failed: ${res.status}`);
      const newData = (await res.json()) as ShadowSummary;
      setShadow(newData);
    } catch (error) {
      console.error("Failed to fetch shadow summary", error);
    } finally {
      if (!options?.silent) setShadowLoading(false);
    }
  }, []);

  const fetchLaneKpi = React.useCallback(
    async (lane: "policy_v0" | "all", options?: { silent?: boolean }) => {
      if (!options?.silent) setLaneKpiLoading(true);
      try {
        const params = new URLSearchParams({
          windowHours: "24",
          horizonMs: String(horizonMs),
          t: String(Date.now())
        });
        if (lane === "policy_v0") {
          params.set("lane", "policy_v0");
        }
        const res = await fetch(`/api/shadow-kpi?${params.toString()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`shadow-kpi fetch failed: ${res.status}`);
        const kpi = (await res.json()) as ShadowKpiResponse;
        setLaneKpi(kpi);
      } catch (error) {
        console.error("Failed to fetch lane KPI", error);
      } finally {
        if (!options?.silent) setLaneKpiLoading(false);
      }
    },
    [horizonMs]
  );

  const fetchMultiHorizonKpi = React.useCallback(async (lane: "policy_v0" | "all", options?: { silent?: boolean }) => {
    if (!options?.silent) setMultiHorizonLoading(true);
    try {
      const params = new URLSearchParams({ windowHours: "24", t: String(Date.now()) });
      if (lane === "policy_v0") {
        params.set("lane", "policy_v0");
      }
      const res = await fetch(`/api/shadow-kpi/multi-horizon?${params.toString()}`, {
        cache: "no-store"
      });
      if (res.ok) {
        const kpi = (await res.json()) as ShadowKpiMultiHorizonResponse;
        setMultiHorizonKpi(kpi);
      } else {
        setMultiHorizonKpi(null);
      }
    } catch (error) {
      console.error("Failed to fetch multi-horizon KPI", error);
      setMultiHorizonKpi(null);
    } finally {
      if (!options?.silent) setMultiHorizonLoading(false);
    }
  }, []);

  const fetchTimeTrendKpi = React.useCallback(
    async (lane: "policy_v0" | "all", hMs: number, options?: { silent?: boolean }) => {
      if (!options?.silent) setTimeTrendLoading(true);
      try {
        const params = new URLSearchParams({
          horizonMs: String(hMs),
          t: String(Date.now())
        });
        if (lane === "policy_v0") {
          params.set("lane", "policy_v0");
        }
        const res = await fetch(`/api/shadow-kpi/time-trend?${params.toString()}`, {
          cache: "no-store"
        });
        if (res.ok) {
          const kpi = (await res.json()) as ShadowKpiTimeTrendResponse;
          setTimeTrendKpi(kpi);
        } else {
          setTimeTrendKpi(null);
        }
      } catch (error) {
        console.error("Failed to fetch time-trend KPI", error);
        setTimeTrendKpi(null);
      } finally {
        if (!options?.silent) setTimeTrendLoading(false);
      }
    },
    []
  );

  const fetchLedger = React.useCallback(async () => {
    setLedgerLoading(true);
    try {
      const res = await fetch("/api/experiment-ledger", { cache: "no-store" });
      if (res.ok) {
        const { entries } = (await res.json()) as { entries: LedgerEntry[] };
        setLedgerEntries(entries);
      } else {
        setLedgerEntries(null);
      }
    } catch (error) {
      console.error("Failed to fetch experiment ledger", error);
      setLedgerEntries(null);
    } finally {
      setLedgerLoading(false);
    }
  }, []);

  const fetchEdgeMap = React.useCallback(async () => {
    setEdgeMapLoading(true);
    try {
      const res = await fetch("/api/shadow-kpi/edge-map?windowHours=24", { cache: "no-store" });
      if (res.ok) {
        const { cells } = (await res.json()) as { cells: EdgeMapCell[] };
        setEdgeMapCells(cells);
      } else {
        setEdgeMapCells(null);
      }
    } catch (error) {
      console.error("Failed to fetch edge map", error);
      setEdgeMapCells(null);
    } finally {
      setEdgeMapLoading(false);
    }
  }, []);

  const handleWalletSelect = React.useCallback(
    (walletId: number | null) => {
      setActiveWalletId(walletId);
      fetchPerformance(walletId);
      fetchShadow(walletId);
    },
    [fetchPerformance, fetchShadow]
  );

  const router = useRouter();
  const handleHorizonChange = React.useCallback(
    (horizon: "5m" | "10m" | "20m") => {
      router.push(`/performance?horizon=${horizon}`);
    },
    [router]
  );

  const activeWallet = wallets.find((w) => w.id === activeWalletId);

  const walletTypeAuto: WalletType = !activeWallet ? "all" : activeWallet.makerEnabled ? "maker" : "taker";

  const getSubtitle = () => {
    if (viewMode === "maker") return "Inventory & market making metrics";
    if (viewMode === "taker") return "Position & trade performance metrics";
    return "Consolidated metrics across all trading systems";
  };

  React.useEffect(() => {
    void fetchShadow(activeWalletId);
    void fetchLaneKpi(selectedLane);
    void fetchMultiHorizonKpi(selectedLane);
    void fetchTimeTrendKpi(selectedLane, horizonMs);
    void fetchLedger();
    void fetchEdgeMap();
  }, [
    activeWalletId,
    fetchShadow,
    fetchLaneKpi,
    fetchMultiHorizonKpi,
    fetchTimeTrendKpi,
    fetchLedger,
    fetchEdgeMap,
    selectedLane,
    horizonMs
  ]);

  React.useEffect(() => {
    const intervalId = setInterval(() => {
      void fetchPerformance(activeWalletId, { silent: true });
      void fetchShadow(activeWalletId, { silent: true });
      void fetchLaneKpi(selectedLane, { silent: true });
      void fetchMultiHorizonKpi(selectedLane, { silent: true });
      void fetchTimeTrendKpi(selectedLane, horizonMs, { silent: true });
    }, 15_000);
    return () => clearInterval(intervalId);
  }, [
    activeWalletId,
    fetchPerformance,
    fetchShadow,
    fetchLaneKpi,
    fetchMultiHorizonKpi,
    fetchTimeTrendKpi,
    selectedLane,
    horizonMs
  ]);

  React.useEffect(() => {
    if (activeWalletId == null) {
      setViewMode("all");
      return;
    }
    setViewMode(walletTypeAuto);
  }, [activeWalletId, walletTypeAuto]);

  const refreshNow = React.useCallback(() => {
    void fetchPerformance(activeWalletId);
    void fetchShadow(activeWalletId);
    void fetchLaneKpi(selectedLane);
    void fetchMultiHorizonKpi(selectedLane);
    void fetchTimeTrendKpi(selectedLane, horizonMs);
  }, [
    activeWalletId,
    fetchPerformance,
    fetchShadow,
    fetchLaneKpi,
    fetchMultiHorizonKpi,
    fetchTimeTrendKpi,
    selectedLane,
    horizonMs
  ]);

  const formatBps = (value: number | null): string => (value == null ? "—" : `${value.toFixed(2)} bps`);

  const formatFillRate = (value: number | null): string => (value == null ? "—" : formatPct(value));

  const formatCount = (value: number): string => value.toLocaleString();

  const formatRatio = (value: number | null): string => (value == null ? "—" : formatPct(value));

  const formatUpdated = (ts: number): string => new Date(ts).toLocaleTimeString();

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight font-display text-foreground">TRADE PERFORMANCE</h1>
            {walletTypeAuto !== "all" && (
              <span
                className={cn(
                  "text-[10px] uppercase tracking-wider px-2 py-1 rounded-sm font-mono font-bold",
                  walletTypeAuto === "maker"
                    ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                    : "bg-neon-green/10 text-neon-green border border-neon-green/30"
                )}
              >
                {walletTypeAuto === "maker" ? "Maker" : "Taker"}
              </span>
            )}
            <button
              onClick={refreshNow}
              className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground border border-border/40 px-2 py-1 rounded-sm"
            >
              <RefreshCw className={cn("h-3 w-3", isLoading && "animate-spin")} />
              Refresh
            </button>
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Updated {formatUpdated(lastUpdatedTs)}
            </span>
            <button
              onClick={() => setShowDiagnostics((v) => !v)}
              className={cn(
                "text-[10px] font-mono uppercase tracking-widest border px-2 py-1 rounded-sm transition-colors",
                showDiagnostics
                  ? "border-neon-green/30 text-neon-green bg-neon-green/10"
                  : "border-border/40 text-muted-foreground hover:text-foreground"
              )}
            >
              {showDiagnostics ? "Diagnostics On" : "Diagnostics Off"}
            </button>
          </div>
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest mt-1">{getSubtitle()}</p>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Question: are we making risk-adjusted money, and which lane is driving it?
          </p>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="inline-flex rounded-sm border border-border/50 bg-card/40 p-1">
            {(["all", "maker", "taker"] as WalletType[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={cn(
                  "px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded-sm transition-colors",
                  viewMode === mode
                    ? "bg-neon-green/10 text-neon-green border border-neon-green/30"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {mode}
              </button>
            ))}
          </div>
          <WalletSelector
            wallets={wallets}
            activeWalletId={activeWalletId}
            onSelect={handleWalletSelect}
            isLoading={isLoading}
          />
        </div>
      </div>

      <RuntimeHealthPanel runtime={data.runtimeHealth} />

      <Card className="bg-card/30 border-neon-green/20 backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-neon-green" />
            <CardTitle className="text-lg font-bold tracking-tight">Money Overview</CardTitle>
          </div>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Quick answer first: realized, unrealized, net, and whether maker/taker are actually printing fills
          </p>
        </CardHeader>
        <CardContent className="p-6 space-y-4">
          <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
            <MetricCard
              icon={<TrendingUp className="h-4 w-4 text-primary" />}
              label="Gross Realized PnL"
              value={formatCurrency(data.totalRealized)}
              isPrimary
              isPositive={data.totalRealized > 0}
              isNegative={data.totalRealized < 0}
              helperText="Closed PnL; fees excluded"
            />
            <MetricCard
              icon={<Layers className="h-4 w-4 text-muted-foreground" />}
              label="Unrealized PnL"
              value={formatCurrency(data.totalUnrealized)}
              isPositive={data.totalUnrealized > 0}
              isNegative={data.totalUnrealized < 0}
              helperText="Open inventory with available marks"
            />
            <MetricCard
              icon={<Target className="h-4 w-4 text-muted-foreground" />}
              label="Gross Total"
              value={formatCurrency(data.netPnl)}
              isPositive={data.netPnl > 0}
              isNegative={data.netPnl < 0}
              helperText="Realized + marked unrealized; fees excluded"
            />
            <MetricCard
              icon={<Activity className="h-4 w-4 text-muted-foreground" />}
              label="Shadow Fills"
              value={String(data.taker.fillCount + data.maker.fillCount)}
              helperText="Taker fills + maker fills"
            />
          </div>
          <div className="grid gap-4 grid-cols-1 md:grid-cols-3 text-[11px] font-mono">
            <div className="rounded border border-border/40 bg-card/20 p-3">
              <div className="uppercase tracking-widest text-muted-foreground mb-1">Taker Activity</div>
              <div className="text-foreground">
                fills: {data.taker.fillCount}, closed: {data.taker.closedPositions}, open: {data.taker.openPositions},
                win rate: {formatPct(data.taker.winRate)}
              </div>
            </div>
            <div className="rounded border border-border/40 bg-card/20 p-3">
              <div className="uppercase tracking-widest text-muted-foreground mb-1">Maker Activity</div>
              <div className={cn(data.maker.fillCount > 0 ? "text-neon-green" : "text-amber-400")}>
                maker fills: {data.maker.fillCount}, shadow fill rate: {formatPct(data.maker.avgFillRate)}
              </div>
            </div>
            <div className="rounded border border-border/40 bg-card/20 p-3">
              <div className="uppercase tracking-widest text-muted-foreground mb-1">Execution Quality</div>
              <div className="text-foreground">
                markouts ready: {shadow?.maker.markout30s != null || shadow?.taker.markout30s != null ? "yes" : "no"}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {!showDiagnostics && (
        <div className="rounded border border-border/40 bg-card/20 p-3 text-[11px] font-mono text-muted-foreground">
          Advanced diagnostics are hidden by default. Toggle <span className="text-foreground">Diagnostics On</span> in
          the header to view edge map, horizon comparisons, calibration, and doctor-style debug panels.
        </div>
      )}

      {showDiagnostics && (
        <>
          <DecisionFunnel />

          {/* What we know so far — Works / Doesn't / Unclear / Killed ideas */}
          <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
            <CardHeader className="border-b border-border/40 pb-3">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-lg font-bold tracking-tight">What we know so far</CardTitle>
              </div>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                Evidence-linked conclusions. Confidence + scope per row.
              </p>
            </CardHeader>
            <CardContent className="p-6">
              {ledgerLoading && !ledgerEntries ? (
                <div className="text-[10px] font-mono text-muted-foreground">Loading…</div>
              ) : ledgerEntries?.length ? (
                <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
                  {(["works", "doesnt", "inconclusive", "killed"] as const).map((verdict) => {
                    const items = ledgerEntries.filter((e) => e.verdict === verdict);
                    if (items.length === 0) return null;
                    const title =
                      verdict === "works"
                        ? "Works"
                        : verdict === "doesnt"
                          ? "Doesn't"
                          : verdict === "killed"
                            ? "Killed ideas"
                            : "Unclear";
                    const Icon =
                      verdict === "works"
                        ? CheckCircle2
                        : verdict === "doesnt"
                          ? XCircle
                          : verdict === "killed"
                            ? Ban
                            : HelpCircle;
                    const iconColor =
                      verdict === "works"
                        ? "text-neon-green"
                        : verdict === "doesnt"
                          ? "text-rose-500"
                          : verdict === "killed"
                            ? "text-muted-foreground"
                            : "text-muted-foreground";
                    return (
                      <div key={verdict} className="space-y-2">
                        <div
                          className={cn(
                            "flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest",
                            iconColor
                          )}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {title}
                        </div>
                        <ul className="space-y-2">
                          {items.map((e) => (
                            <li
                              key={e.id}
                              className="rounded border border-border/40 bg-card/20 p-2 text-[10px] font-mono"
                            >
                              <div className="text-foreground">{e.hypothesis}</div>
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                {e.confidence && (
                                  <span className="rounded bg-muted/60 px-1 py-0.5 text-[9px] uppercase">
                                    {e.confidence}
                                  </span>
                                )}
                                {e.scope && (
                                  <span className="rounded border border-border/40 px-1 py-0.5 text-[9px] text-muted-foreground">
                                    {e.scope}
                                  </span>
                                )}
                                <span className="font-mono text-muted-foreground" title="Experiment ID (copy)">
                                  {e.runId}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-[10px] font-mono text-muted-foreground">No ledger entries</div>
              )}
            </CardContent>
          </Card>

          {/* Shadow KPI (lane) — unified card with lane selector, default Policy v0 */}
          <Card className="bg-card/30 border-neon-green/20 backdrop-blur-sm">
            <CardHeader className="border-b border-border/40 pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-lg font-bold tracking-tight">Shadow KPI (lane)</CardTitle>
                <div className="inline-flex rounded-sm border border-border/50 bg-card/40 p-0.5 ml-auto">
                  {(["policy_v0", "all"] as const).map((lane) => (
                    <button
                      key={lane}
                      onClick={() => setSelectedLane(lane)}
                      className={cn(
                        "px-2 py-1 text-[10px] font-mono uppercase tracking-widest rounded-sm transition-colors",
                        selectedLane === lane
                          ? "bg-neon-green/10 text-neon-green border border-neon-green/30"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {lane === "policy_v0" ? "Policy v0" : "All"}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                {selectedLane === "policy_v0"
                  ? "maker-in · maker-out · horizon=" + defaultHorizon
                  : `EV_bps @ ${defaultHorizon}, expected $/day, inventory time, open positions, p95 drawdown proxy`}
              </p>
              {laneKpi?.updatedAt != null && (
                <p className="text-[10px] font-mono text-muted-foreground mt-1">
                  Updated at {formatUpdated(laneKpi.updatedAt)}
                </p>
              )}
            </CardHeader>
            <CardContent className="p-6">
              {laneKpiLoading && !laneKpi ? (
                <div className="text-[10px] font-mono text-muted-foreground">Loading…</div>
              ) : laneKpi ? (
                <div className="space-y-4">
                  {laneKpi.status === "error" && laneKpi.error && (
                    <div className="rounded border border-rose-500/50 bg-rose-500/10 p-3 text-[10px] font-mono">
                      <span className="font-bold text-rose-500">{laneKpi.error.code}</span>: {laneKpi.error.message}
                    </div>
                  )}
                  {laneKpi.status === "empty" && laneKpi.emptyReason && (
                    <p className="text-muted-foreground font-medium text-sm">{laneKpi.emptyReason}</p>
                  )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4 text-[10px] font-mono">
                    <div>
                      <div className="uppercase tracking-wider text-muted-foreground mb-1">N_cycles</div>
                      <div
                        className={cn(
                          "font-bold",
                          (laneKpi.nCycles ?? laneKpi.completedCycles ?? 0) < 50
                            ? "text-muted-foreground"
                            : "text-foreground"
                        )}
                      >
                        {laneKpi.nCycles ?? laneKpi.completedCycles ?? 0}
                      </div>
                    </div>
                    <div>
                      <div className="uppercase tracking-wider text-muted-foreground mb-1">N_fills</div>
                      <div className="font-bold text-foreground">
                        {laneKpi.nFills ?? laneKpi.diagnostics?.laneRows ?? "—"}
                      </div>
                    </div>
                    <div>
                      <div className="uppercase tracking-wider text-muted-foreground mb-1">N_markouts</div>
                      <div className="font-bold text-foreground">
                        {laneKpi.nMarkouts ?? laneKpi.diagnostics?.markoutRows ?? "—"}
                      </div>
                    </div>
                    <div>
                      <div className="uppercase tracking-wider text-muted-foreground mb-1">EV_bps</div>
                      <div
                        className={cn(
                          "font-bold",
                          (laneKpi.evBps ?? laneKpi.evBps10m ?? 0) >= 0 ? "text-neon-green" : "text-rose-500",
                          (laneKpi.nCycles ?? laneKpi.completedCycles ?? 0) < 50 && "ring-1 ring-border rounded px-1"
                        )}
                      >
                        {(laneKpi.evBps ?? laneKpi.evBps10m) != null
                          ? laneKpi.evBpsCiLo != null && laneKpi.evBpsCiHi != null
                            ? `${(laneKpi.evBps ?? laneKpi.evBps10m)!.toFixed(2)} bps [${laneKpi.evBpsCiLo.toFixed(2)}, ${laneKpi.evBpsCiHi.toFixed(2)}]`
                            : `${(laneKpi.evBps ?? laneKpi.evBps10m)!.toFixed(2)} bps`
                          : "—"}
                      </div>
                      {(laneKpi.ciBasis ?? "markouts") && (
                        <div className="text-[9px] text-muted-foreground mt-0.5">
                          CI basis: {laneKpi.ciBasis ?? "markouts"}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="uppercase tracking-wider text-muted-foreground mb-1">Expected $/day</div>
                      <div
                        className={cn(
                          "font-bold",
                          (laneKpi.expectedDollarsPerDay ?? 0) >= 0 ? "text-neon-green" : "text-rose-500"
                        )}
                      >
                        {laneKpi.expectedDollarsPerDay != null ? `$${laneKpi.expectedDollarsPerDay.toFixed(2)}` : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="uppercase tracking-wider text-muted-foreground mb-1">Med time (min)</div>
                      <div className="font-bold text-foreground">
                        {laneKpi.medianTimeInInventoryMs != null
                          ? (laneKpi.medianTimeInInventoryMs / 60_000).toFixed(1)
                          : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="uppercase tracking-wider text-muted-foreground mb-1">p90 time (min)</div>
                      <div className="font-bold text-foreground">
                        {laneKpi.p90TimeInInventoryMs != null
                          ? (laneKpi.p90TimeInInventoryMs / 60_000).toFixed(1)
                          : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="uppercase tracking-wider text-muted-foreground mb-1">Open positions</div>
                      <div className="font-bold text-foreground">{laneKpi.openPositionsCount}</div>
                    </div>
                    <div>
                      <div className="uppercase tracking-wider text-muted-foreground mb-1">p95 drawdown (bps)</div>
                      <div
                        className={cn(
                          "font-bold",
                          (laneKpi.p95DrawdownProxyBps ?? 0) <= 0 ? "text-rose-500" : "text-foreground"
                        )}
                      >
                        {laneKpi.p95DrawdownProxyBps != null ? laneKpi.p95DrawdownProxyBps.toFixed(1) : "—"}
                      </div>
                    </div>
                  </div>
                  {((laneKpi.nCycles ?? laneKpi.completedCycles ?? 0) < 5 ||
                    (laneKpi.nCycles ?? laneKpi.completedCycles ?? 0) < 50) && (
                    <p className="text-muted-foreground font-medium text-sm">
                      {(laneKpi.nCycles ?? laneKpi.completedCycles ?? 0) < 50
                        ? "N_cycles &lt; 50: CI may be optimistic; cycle-level CI used when available."
                        : "Evidence weak (N_cycles &lt; 5); keep running."}
                    </p>
                  )}
                </div>
              ) : (
                <div className="text-[10px] font-mono text-muted-foreground">No lane KPI data</div>
              )}
            </CardContent>
          </Card>

          {/* Horizon comparison */}
          <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
            <CardHeader className="border-b border-border/40 pb-3">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-lg font-bold tracking-tight">Horizon comparison</CardTitle>
              </div>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                Longer horizon ≠ more profits. Compare N and CI to distinguish noise from edge decay.
              </p>
            </CardHeader>
            <CardContent className="p-6">
              {multiHorizonLoading && !multiHorizonKpi ? (
                <div className="text-[10px] font-mono text-muted-foreground">Loading…</div>
              ) : multiHorizonKpi?.horizons?.length ? (
                <div className="space-y-3">
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px] font-mono border-collapse">
                      <thead>
                        <tr className="text-ink/60 uppercase tracking-tighter border-b border-border/40">
                          <th className="text-left py-2 pr-4">Horizon</th>
                          <th className="text-right py-2 pr-4">N_cycles</th>
                          <th className="text-right py-2 pr-4">N_fills</th>
                          <th className="text-right py-2 pr-4">N_markouts</th>
                          <th className="text-right py-2 pr-4">EV_bps [CI]</th>
                          <th className="text-right py-2 pr-4">$/day</th>
                        </tr>
                      </thead>
                      <tbody>
                        {multiHorizonKpi.horizons.map((h) => {
                          const nCycles = h.nCycles ?? h.completedCycles ?? 0;
                          const lowN = nCycles < 50;
                          return (
                            <tr key={h.horizonMs} className={cn("border-b border-border/20", lowN && "bg-muted/20")}>
                              <td className="py-2 pr-4 font-medium">{h.horizonLabel}</td>
                              <td className={cn("text-right py-2 pr-4", lowN && "text-muted-foreground font-medium")}>
                                {nCycles}
                              </td>
                              <td className="text-right py-2 pr-4">{h.nFills ?? "—"}</td>
                              <td className="text-right py-2 pr-4">{h.nMarkouts ?? h.markoutRows ?? "—"}</td>
                              <td className="text-right py-2 pr-4">
                                <span
                                  className={cn(
                                    (h.evBps ?? 0) >= 0 ? "text-neon-green" : "text-rose-500",
                                    lowN && "ring-1 ring-border rounded px-1"
                                  )}
                                >
                                  {h.evBps != null
                                    ? h.evBpsCiLo != null && h.evBpsCiHi != null
                                      ? `${h.evBps.toFixed(2)} [${h.evBpsCiLo.toFixed(2)}, ${h.evBpsCiHi.toFixed(2)}]`
                                      : `${h.evBps.toFixed(2)} bps`
                                    : "—"}
                                </span>
                                {h.ciBasis && (
                                  <span className="block text-[9px] text-muted-foreground">CI: {h.ciBasis}</span>
                                )}
                              </td>
                              <td
                                className={cn(
                                  "text-right py-2 pr-4",
                                  (h.expectedDollarsPerDay ?? 0) >= 0 ? "text-neon-green" : "text-rose-500"
                                )}
                              >
                                {h.expectedDollarsPerDay != null ? `$${h.expectedDollarsPerDay.toFixed(2)}` : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="text-[10px] font-mono text-muted-foreground">No horizon comparison data</div>
              )}
            </CardContent>
          </Card>

          {/* Edge Map — lane × bucket × horizon, one query */}
          <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
            <CardHeader className="border-b border-border/40 pb-3">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-lg font-bold tracking-tight">Edge Map</CardTitle>
              </div>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                Lane × spread bucket × horizon. N_cycles, N_fills, N_markouts; CI basis; warning when N_cycles &lt; 50.
              </p>
            </CardHeader>
            <CardContent className="p-6">
              {edgeMapLoading && !edgeMapCells ? (
                <div className="text-[10px] font-mono text-muted-foreground">Loading…</div>
              ) : edgeMapCells?.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px] font-mono border-collapse">
                    <thead>
                      <tr className="text-ink/60 uppercase tracking-tighter border-b border-border/40">
                        <th className="text-left py-2 pr-4">Lane</th>
                        <th className="text-left py-2 pr-4">Bucket</th>
                        <th className="text-left py-2 pr-4">Horizon</th>
                        <th className="text-right py-2 pr-4">N_cycles</th>
                        <th className="text-right py-2 pr-4">N_fills</th>
                        <th className="text-right py-2 pr-4">N_markouts</th>
                        <th className="text-right py-2 pr-4">EV_bps [CI]</th>
                        <th className="text-right py-2 pr-4">$/day</th>
                        <th className="text-right py-2 pr-4">Med (min)</th>
                        <th className="text-right py-2">p95 (bps)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {edgeMapCells.map((c) => {
                        const lowN = c.nCycles < 50;
                        return (
                          <tr
                            key={`${c.lane}-${c.bucket}-${c.horizonMs}`}
                            className={cn("border-b border-border/20", lowN && "bg-muted/20")}
                          >
                            <td className="py-2 pr-4 font-medium">{c.lane}</td>
                            <td className="py-2 pr-4">{c.bucket}</td>
                            <td className="py-2 pr-4">{c.horizonLabel}</td>
                            <td className={cn("text-right py-2 pr-4", lowN && "text-muted-foreground font-medium")}>
                              {c.nCycles}
                            </td>
                            <td className="text-right py-2 pr-4">{c.nFills}</td>
                            <td className="text-right py-2 pr-4">{c.nMarkouts}</td>
                            <td className="text-right py-2 pr-4">
                              <span
                                className={cn(
                                  (c.evBps ?? 0) >= 0 ? "text-neon-green" : "text-rose-500",
                                  lowN && "ring-1 ring-border rounded px-1"
                                )}
                              >
                                {c.evBps != null
                                  ? c.evBpsCiLo != null && c.evBpsCiHi != null
                                    ? `${c.evBps.toFixed(2)} [${c.evBpsCiLo.toFixed(2)}, ${c.evBpsCiHi.toFixed(2)}]`
                                    : `${c.evBps.toFixed(2)} bps`
                                  : "—"}
                              </span>
                              {c.ciBasis && (
                                <span className="block text-[9px] text-muted-foreground">CI: {c.ciBasis}</span>
                              )}
                            </td>
                            <td
                              className={cn(
                                "text-right py-2 pr-4",
                                (c.expectedDollarsPerDay ?? 0) >= 0 ? "text-neon-green" : "text-rose-500"
                              )}
                            >
                              {c.expectedDollarsPerDay != null ? `$${c.expectedDollarsPerDay.toFixed(2)}` : "—"}
                            </td>
                            <td className="text-right py-2 pr-4">
                              {c.medianHoldMs != null ? (c.medianHoldMs / 60_000).toFixed(1) : "—"}
                            </td>
                            <td className="text-right py-2">
                              {c.p95DrawdownBps != null ? c.p95DrawdownBps.toFixed(1) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-[10px] font-mono text-muted-foreground">No edge map data</div>
              )}
            </CardContent>
          </Card>

          {/* Time trend (same horizon over time) */}
          <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
            <CardHeader className="border-b border-border/40 pb-3">
              <div className="flex items-center gap-2">
                <Timer className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-lg font-bold tracking-tight">Time trend (same horizon)</CardTitle>
              </div>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                Inching: same horizon over time. Horizon={defaultHorizon}.
              </p>
            </CardHeader>
            <CardContent className="p-6">
              {timeTrendLoading && !timeTrendKpi ? (
                <div className="text-[10px] font-mono text-muted-foreground">Loading…</div>
              ) : timeTrendKpi?.windows?.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px] font-mono border-collapse">
                    <thead>
                      <tr className="text-ink/60 uppercase tracking-tighter border-b border-border/40">
                        <th className="text-left py-2 pr-4">Window</th>
                        <th className="text-right py-2 pr-4">N_cycles</th>
                        <th className="text-right py-2 pr-4">N_fills</th>
                        <th className="text-right py-2 pr-4">N_markouts</th>
                        <th className="text-right py-2 pr-4">EV_bps [CI]</th>
                        <th className="text-right py-2">$/day</th>
                      </tr>
                    </thead>
                    <tbody>
                      {timeTrendKpi.windows.map((w) => {
                        const nCycles = w.nCycles ?? 0;
                        const lowN = nCycles < 50;
                        return (
                          <tr key={w.windowHours} className={cn("border-b border-border/20", lowN && "bg-muted/20")}>
                            <td className="py-2 pr-4 font-medium">{w.windowHours}h</td>
                            <td className={cn("text-right py-2 pr-4", lowN && "text-muted-foreground font-medium")}>
                              {w.nCycles ?? "—"}
                            </td>
                            <td className="text-right py-2 pr-4">{w.nFills ?? "—"}</td>
                            <td className="text-right py-2 pr-4">{w.nMarkouts ?? w.n ?? "—"}</td>
                            <td className="text-right py-2 pr-4">
                              <span
                                className={cn(
                                  (w.evBps ?? 0) >= 0 ? "text-neon-green" : "text-rose-500",
                                  lowN && "ring-1 ring-border rounded px-1"
                                )}
                              >
                                {w.evBps != null
                                  ? w.evBpsCiLo != null && w.evBpsCiHi != null
                                    ? `${w.evBps.toFixed(2)} [${w.evBpsCiLo.toFixed(2)}, ${w.evBpsCiHi.toFixed(2)}]`
                                    : `${w.evBps.toFixed(2)} bps`
                                  : "—"}
                              </span>
                              {w.ciBasis && (
                                <span className="block text-[9px] text-muted-foreground">CI: {w.ciBasis}</span>
                              )}
                            </td>
                            <td
                              className={cn(
                                "text-right py-2",
                                (w.expectedDollarsPerDay ?? 0) >= 0 ? "text-neon-green" : "text-rose-500"
                              )}
                            >
                              {w.expectedDollarsPerDay != null ? `$${w.expectedDollarsPerDay.toFixed(2)}` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-[10px] font-mono text-muted-foreground">No time trend data</div>
              )}
            </CardContent>
          </Card>

          <ResearchPanel wallets={wallets} defaultHorizon={defaultHorizon} onHorizonChange={handleHorizonChange} />

          {/* Edge Calibration (pred vs realized) */}
          {edgeCalibration && (
            <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
              <CardHeader className="border-b border-border/40 pb-3">
                <div className="flex items-center gap-2">
                  <Target className="h-4 w-4 text-emerald-400" />
                  <CardTitle className="text-lg font-bold tracking-tight">Edge Calibration</CardTitle>
                </div>
                <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                  Predicted vs realized markout by net_edge_bps bucket ({defaultHorizon} horizon)
                </p>
              </CardHeader>
              <CardContent className="p-6 space-y-6">
                {edgeCalibration.diagnostics?.taker && (
                  <div className="text-[10px] font-mono rounded border border-border/40 p-3 bg-card/20">
                    <div className="uppercase tracking-wider text-ink/60 mb-2">
                      Outcome coverage at horizon={defaultHorizon}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <span className="text-ink/60">fills_total</span>
                        <div className="font-bold text-foreground">{edgeCalibration.diagnostics.taker.fills_total}</div>
                      </div>
                      <div>
                        <span className="text-ink/60">fills_with_markout</span>
                        <div className="font-bold text-foreground">
                          {edgeCalibration.diagnostics.taker.fills_with_markout}
                        </div>
                      </div>
                      <div>
                        <span className="text-ink/60">fills_with_pred_edge</span>
                        <div className="font-bold text-foreground">
                          {edgeCalibration.diagnostics.taker.fills_with_pred_edge}
                        </div>
                      </div>
                      <div>
                        <span className="text-ink/60">fills_in_calibration</span>
                        <div className="font-bold text-foreground">
                          {edgeCalibration.diagnostics.taker.fills_in_calibration}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                <div className="grid gap-6 md:grid-cols-2">
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                      Taker Calibration
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[10px] font-mono border-collapse">
                        <thead>
                          <tr className="text-ink/60 uppercase tracking-tighter">
                            <th className="text-left py-2 pr-4">Bucket</th>
                            <th className="text-right py-2 pr-4">Count</th>
                            <th className="text-right py-2">Avg Realized</th>
                          </tr>
                        </thead>
                        <tbody>
                          {edgeCalibration.taker.buckets.map((b) => (
                            <tr key={b.label} className="border-t border-border/20">
                              <td className="py-2 pr-4">{b.label}</td>
                              <td className="text-right py-2 pr-4">{b.count}</td>
                              <td
                                className={cn(
                                  "text-right py-2",
                                  (b.avgRealizedMarkoutBps ?? 0) >= 0 ? "text-neon-green" : "text-rose-500"
                                )}
                              >
                                {b.avgRealizedMarkoutBps != null ? `${b.avgRealizedMarkoutBps.toFixed(2)} bps` : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="text-[10px] font-mono pt-2 border-t border-border/20">
                      Decomposition: pred{" "}
                      {edgeCalibration.taker.decomposition.avgPredEdgeBps != null
                        ? edgeCalibration.taker.decomposition.avgPredEdgeBps.toFixed(1)
                        : "—"}{" "}
                      bps
                      {" → "}net{" "}
                      {edgeCalibration.taker.decomposition.avgNetEdgeBps != null
                        ? edgeCalibration.taker.decomposition.avgNetEdgeBps.toFixed(1)
                        : "—"}{" "}
                      bps
                      {" → "}realized{" "}
                      {edgeCalibration.taker.decomposition.avgRealizedMarkoutBps != null
                        ? edgeCalibration.taker.decomposition.avgRealizedMarkoutBps.toFixed(1)
                        : "—"}{" "}
                      bps (n={edgeCalibration.taker.decomposition.fillCount})
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                      Maker Calibration
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[10px] font-mono border-collapse">
                        <thead>
                          <tr className="text-ink/60 uppercase tracking-tighter">
                            <th className="text-left py-2 pr-4">Bucket</th>
                            <th className="text-right py-2 pr-4">Count</th>
                            <th className="text-right py-2">Avg Realized</th>
                          </tr>
                        </thead>
                        <tbody>
                          {edgeCalibration.maker.buckets.map((b) => (
                            <tr key={b.label} className="border-t border-border/20">
                              <td className="py-2 pr-4">{b.label}</td>
                              <td className="text-right py-2 pr-4">{b.count}</td>
                              <td
                                className={cn(
                                  "text-right py-2",
                                  (b.avgRealizedMarkoutBps ?? 0) >= 0 ? "text-neon-green" : "text-rose-500"
                                )}
                              >
                                {b.avgRealizedMarkoutBps != null ? `${b.avgRealizedMarkoutBps.toFixed(2)} bps` : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="text-[10px] font-mono pt-2 border-t border-border/20">
                      Decomposition: pred{" "}
                      {edgeCalibration.maker.decomposition.avgPredEdgeBps != null
                        ? edgeCalibration.maker.decomposition.avgPredEdgeBps.toFixed(1)
                        : "—"}{" "}
                      bps
                      {" → "}net{" "}
                      {edgeCalibration.maker.decomposition.avgNetEdgeBps != null
                        ? edgeCalibration.maker.decomposition.avgNetEdgeBps.toFixed(1)
                        : "—"}{" "}
                      bps
                      {" → "}realized{" "}
                      {edgeCalibration.maker.decomposition.avgRealizedMarkoutBps != null
                        ? edgeCalibration.maker.decomposition.avgRealizedMarkoutBps.toFixed(1)
                        : "—"}{" "}
                      bps (n={edgeCalibration.maker.decomposition.fillCount})
                    </div>
                  </div>
                </div>
                <div className="pt-4 border-t border-border/40 text-[10px] font-mono">
                  <span className="uppercase tracking-widest text-muted-foreground">Combined: </span>
                  Taker realized{" "}
                  {edgeCalibration.combined.takerRealizedMarkoutBps != null
                    ? edgeCalibration.combined.takerRealizedMarkoutBps.toFixed(1)
                    : "—"}{" "}
                  bps (n={edgeCalibration.combined.takerFills}, win {edgeCalibration.combined.takerWinRate.toFixed(1)}%)
                  {" · "}
                  Maker realized{" "}
                  {edgeCalibration.combined.makerRealizedMarkoutBps != null
                    ? edgeCalibration.combined.makerRealizedMarkoutBps.toFixed(1)
                    : "—"}{" "}
                  bps (n={edgeCalibration.combined.makerFills}, fill {edgeCalibration.combined.makerFillRate.toFixed(1)}
                  %)
                </div>
              </CardContent>
            </Card>
          )}

          {/* Execution Quality Summary */}
          <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
            <CardHeader className="border-b border-border/40 pb-3">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-emerald-400" />
                <CardTitle className="text-lg font-bold tracking-tight">Execution Quality</CardTitle>
              </div>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                Shadow fill rates and markouts (last {shadow?.windowHours ?? 24}h)
              </p>
            </CardHeader>
            <CardContent className="p-6 space-y-6">
              {shadowLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
              {!shadowLoading && shadow && (
                <div className="space-y-6">
                  {(viewMode === "maker" || viewMode === "all") && (
                    <div className="space-y-3">
                      <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                        Maker (shadow)
                      </div>
                      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                        <MetricCard
                          icon={<Percent className="h-4 w-4 text-muted-foreground" />}
                          label="Fill Rate"
                          value={formatFillRate(shadow.maker.fillRate)}
                        />
                        <MetricCard
                          icon={<Timer className="h-4 w-4 text-muted-foreground" />}
                          label="Markout 5s"
                          value={formatBps(shadow.maker.markout5s)}
                        />
                        <MetricCard
                          icon={<Timer className="h-4 w-4 text-muted-foreground" />}
                          label="Markout 30s"
                          value={formatBps(shadow.maker.markout30s)}
                        />
                        <MetricCard
                          icon={<Activity className="h-4 w-4 text-muted-foreground" />}
                          label="Fills"
                          value={`${shadow.maker.fills.toLocaleString()}`}
                        />
                      </div>
                      <div className="grid gap-4 grid-cols-2 md:grid-cols-3">
                        <MetricCard
                          icon={<Activity className="h-4 w-4 text-slate-400" />}
                          label="Real fills"
                          value={formatCount(shadow.maker.realFills)}
                          helperText="Matched to live trades"
                        />
                        <MetricCard
                          icon={<Activity className="h-4 w-4 text-muted-foreground" />}
                          label="Synthetic fills"
                          value={formatCount(shadow.maker.syntheticFills)}
                          helperText="Generated when the feed is idle"
                        />
                        <MetricCard
                          icon={<Percent className="h-4 w-4 text-muted-foreground" />}
                          label="Synthetic ratio"
                          value={formatRatio(shadow.maker.syntheticRatio)}
                          helperText="Synthetic / total fills"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground font-mono">
                        Synthetic fills keep the panel populated when the live trade feed is quiet; real fills back up
                        the maker PnL when synthetic ratio is low.
                      </p>
                    </div>
                  )}

                  {(viewMode === "taker" || viewMode === "all") && (
                    <div className="space-y-3">
                      <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                        Taker (shadow)
                      </div>
                      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                        <MetricCard
                          icon={<Percent className="h-4 w-4 text-muted-foreground" />}
                          label="Fill Rate"
                          value={formatFillRate(shadow.taker.fillRate)}
                        />
                        <MetricCard
                          icon={<Timer className="h-4 w-4 text-muted-foreground" />}
                          label="Markout 5s"
                          value={formatBps(shadow.taker.markout5s)}
                        />
                        <MetricCard
                          icon={<Timer className="h-4 w-4 text-muted-foreground" />}
                          label="Markout 30s"
                          value={formatBps(shadow.taker.markout30s)}
                        />
                        <MetricCard
                          icon={<Activity className="h-4 w-4 text-muted-foreground" />}
                          label="Fills"
                          value={`${shadow.taker.fills.toLocaleString()}`}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Render appropriate view based on wallet type */}
      {viewMode === "maker" && <MakerPerformanceView data={data} />}
      {viewMode === "taker" && <TakerPerformanceView data={data} />}
      {viewMode === "all" && <ConsolidatedPerformanceView data={data} />}
    </div>
  );
}
