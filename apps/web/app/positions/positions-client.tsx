"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { WalletMarketKind, WalletMarketFilterV1 } from "@polysignal/types";
import { WalletContextBar } from "../../components/WalletContextBar";
import { WalletSettingsDrawer } from "../../components/WalletSettingsDrawer";
import { ActivePositionsCard } from "../../components/ActivePositionsCard";
import { AlertsClient } from "./alerts-client";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { formatNum, formatPct } from "../../lib/utils";

export type ShadowPositionRow = {
  id: string;
  walletId: number;
  walletName: string;
  tokenId: string;
  marketId: string | null;
  question: string | null;
  outcome: string | null;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  mid: number | null;
  realized: number;
  unrealized: number;
  tsOpen: number;
  kind: "maker" | "taker";
};

export type ShadowClosedPositionRow = {
  id: string;
  walletId: number;
  walletName: string;
  tokenId: string;
  marketId: string | null;
  question: string | null;
  outcome: string | null;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  exitPrice: number;
  realized: number;
  tsOpen: number;
  tsClose: number;
  kind: "taker";
};

type WalletInfo = {
  id: number;
  name: string;
  makerEnabled?: number | boolean;
  startingBalance?: number;
  sizeMultiplier?: number;
  maxOpenPositions?: number;
  minConfidence?: number;
  minEdge?: number;
  autoOpenLimit?: number;
  autoTradeEnabled?: number | boolean;
  // Maker-specific parameters
  makerQuoteSize?: number;
  makerQuoteWidthBps?: number;
  makerMinSpread?: number;
  makerMaxSpread?: number;
  makerMinDepth?: number;
  makerInventoryMaxAbs?: number;
  makerInventorySkewBps?: number;
  // Risk limits
  maxDailyLossUsd?: number | null;
  maxDrawdownPct?: number | null;
  cooldownMinutes?: number | null;
  marketAllowlist?: string | null;
  marketFilter?: WalletMarketFilterV1 | null;
  marketFilterJson?: string | null;
  // Position defaults
  defaultStopLossPct?: number | null;
  defaultTakeProfitPct?: number | null;
  defaultMaxLossAbs?: number | null;
  defaultMaxHoldSec?: number | null;
};

type PositionsPageClientProps = {
  initialWallets: WalletInfo[];
  initialWalletId: number | null;
  initialMode: "maker" | "taker" | null;
  initialOpenPositions: ShadowPositionRow[];
  initialClosedPositions: ShadowClosedPositionRow[];
};

const formatTime = (ts: number | null): string => {
  if (!ts || !Number.isFinite(ts)) return "-";
  return new Date(ts).toLocaleString();
};

export function PositionsPageClient({
  initialWallets,
  initialWalletId,
  initialMode,
  initialOpenPositions,
  initialClosedPositions
}: PositionsPageClientProps) {
  const router = useRouter();
  const [wallets, setWallets] = React.useState<WalletInfo[]>(initialWallets);
  const [activeWalletId, setActiveWalletId] = React.useState<number | null>(initialWalletId);
  const [mode, setMode] = React.useState<"maker" | "taker" | null>(initialMode);
  const [openPositions, setOpenPositions] = React.useState<ShadowPositionRow[]>(initialOpenPositions);
  const [closedPositions, setClosedPositions] = React.useState<ShadowClosedPositionRow[]>(initialClosedPositions);
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [formData, setFormData] = React.useState<any>(null);

  React.useEffect(() => {
    setWallets(initialWallets);
  }, [initialWallets]);

  React.useEffect(() => {
    setActiveWalletId(initialWalletId);
    setOpenPositions(initialOpenPositions);
    setClosedPositions(initialClosedPositions);
    setMode(initialMode);
  }, [initialWalletId, initialOpenPositions, initialClosedPositions, initialMode]);

  const refreshPositions = React.useCallback(async (walletId?: number | null) => {
    if (walletId == null) {
      setOpenPositions([]);
      setClosedPositions([]);
      setMode(null);
      return;
    }
    const resp = await fetch(`/api/positions?walletId=${walletId}`);
    if (!resp.ok) return;
    const data = (await resp.json()) as {
      mode: "maker" | "taker" | null;
      open: ShadowPositionRow[];
      closed: ShadowClosedPositionRow[];
    };
    setOpenPositions(data.open ?? []);
    setClosedPositions(data.closed ?? []);
    setMode(data.mode ?? null);
  }, []);

  const refreshWallets = React.useCallback(async (preferredId?: number | null) => {
    const resp = await fetch("/api/wallets");
    if (!resp.ok) return;
    const data = (await resp.json()) as WalletInfo[];
    setWallets(data);
    const nextId = preferredId ?? activeWalletId ?? data[0]?.id ?? null;
    setActiveWalletId(nextId);
    if (nextId != null) {
      await refreshPositions(nextId);
    }
  }, [activeWalletId, refreshPositions]);

  React.useEffect(() => {
    void refreshWallets();
  }, [refreshWallets]);

  React.useEffect(() => {
    if (activeWalletId == null) return;
    void refreshPositions(activeWalletId);
    const interval = setInterval(() => {
      void refreshPositions(activeWalletId);
    }, 3000);
    return () => clearInterval(interval);
  }, [activeWalletId, refreshPositions]);

  const activeWallet = wallets.find((w) => w.id === activeWalletId) ?? null;

  const handleWalletSelect = (id: number) => {
    setActiveWalletId(id);
    router.push(`/positions?walletId=${id}`);
    void refreshPositions(id);
  };

  const toFormState = (w: WalletInfo) => ({
    ...(function () {
      const allowlistFallback = (w.marketAllowlist ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);

      const inferredKinds = (() => {
        if (w.marketFilter?.allowedKinds && w.marketFilter.allowedKinds.length > 0) {
          return w.marketFilter.allowedKinds;
        }
        const maker = Boolean(w.makerEnabled);
        const taker = Boolean(w.autoTradeEnabled);
        if (maker && !taker) return ["MAKER_BID", "MAKER_ASK"] as WalletMarketKind[];
        if (!maker && taker) return ["TAKER_BUY", "TAKER_SELL"] as WalletMarketKind[];
        return ["TAKER_BUY", "TAKER_SELL", "MAKER_BID", "MAKER_ASK"] as WalletMarketKind[];
      })();

      return {
        marketFilterIncludeMarketIds:
          w.marketFilter?.includeMarketIds?.join(", ") ??
          (allowlistFallback.length > 0 ? allowlistFallback.join(", ") : ""),
        marketFilterRequireActive:
          w.marketFilter?.requireActive != null
            ? Boolean(w.marketFilter.requireActive)
            : allowlistFallback.length > 0,
        marketFilterAllowTakerBuy: inferredKinds.includes("TAKER_BUY"),
        marketFilterAllowTakerSell: inferredKinds.includes("TAKER_SELL"),
        marketFilterAllowMakerBid: inferredKinds.includes("MAKER_BID"),
        marketFilterAllowMakerAsk: inferredKinds.includes("MAKER_ASK")
      };
    })(),
    name: w.name ?? "",
    startingBalance: String(w.startingBalance ?? 10000),
    sizeMultiplier: String(w.sizeMultiplier ?? 1),
    maxOpenPositions: String(w.maxOpenPositions ?? 5),
    minConfidence: String(w.minConfidence ?? 0),
    minEdge: String(w.minEdge ?? 0),
    autoOpenLimit: String(w.autoOpenLimit ?? 5),
    autoTradeEnabled: w.autoTradeEnabled != null ? Boolean(w.autoTradeEnabled) : true,
    makerEnabled: w.makerEnabled != null ? Boolean(w.makerEnabled) : false,
    maxDailyLossUsd: w.maxDailyLossUsd != null ? String(w.maxDailyLossUsd) : "",
    maxDrawdownPct: w.maxDrawdownPct != null ? String(w.maxDrawdownPct) : "",
    cooldownMinutes: w.cooldownMinutes != null ? String(w.cooldownMinutes) : "",
    marketAllowlist: w.marketAllowlist ?? "",
    marketFilterExcludeMarketIds: w.marketFilter?.excludeMarketIds?.join(", ") ?? "",
    marketFilterMinVolumeUsd: w.marketFilter?.minVolumeUsd != null ? String(w.marketFilter.minVolumeUsd) : "",
    marketFilterMaxVolumeUsd: w.marketFilter?.maxVolumeUsd != null ? String(w.marketFilter.maxVolumeUsd) : "",
    marketFilterMinLiquidityUsd: w.marketFilter?.minLiquidityUsd != null ? String(w.marketFilter.minLiquidityUsd) : "",
    marketFilterMaxLiquidityUsd: w.marketFilter?.maxLiquidityUsd != null ? String(w.marketFilter.maxLiquidityUsd) : "",
    makerQuoteSize: String(w.makerQuoteSize ?? 50),
    makerQuoteWidthBps: String(w.makerQuoteWidthBps ?? 20),
    makerMinSpread: String(w.makerMinSpread ?? 0.002),
    makerMaxSpread: String(w.makerMaxSpread ?? 0.02),
    makerMinDepth: String(w.makerMinDepth ?? 20),
    makerInventoryMaxAbs: String(w.makerInventoryMaxAbs ?? 500),
    makerInventorySkewBps: String(w.makerInventorySkewBps ?? 15),
    defaultStopLossPct: w.defaultStopLossPct != null ? String(w.defaultStopLossPct) : "",
    defaultTakeProfitPct: w.defaultTakeProfitPct != null ? String(w.defaultTakeProfitPct) : "",
    defaultMaxLossAbs: w.defaultMaxLossAbs != null ? String(w.defaultMaxLossAbs) : "",
    defaultMaxHoldSec: w.defaultMaxHoldSec != null ? String(w.defaultMaxHoldSec) : ""
  });

  const handleEditWallet = (id: number) => {
    const w = wallets.find((wallet) => wallet.id === id);
    if (!w) return;
    setFormData(toFormState(w));
    setIsCreating(false);
    setIsSettingsOpen(true);
  };

  const handleCreateWallet = () => {
    setFormData(null);
    setIsCreating(true);
    setIsSettingsOpen(true);
  };

  const handleSaveWallet = async (data: any) => {
    const parseOptionalNum = (val: string): number | null => {
      if (!val || val.trim() === "") return null;
      const n = Number(val);
      return Number.isFinite(n) ? n : null;
    };
    const parseCsv = (val: string): string[] =>
      val
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0);

    const allowedKinds: WalletMarketKind[] = [];
    if (data.marketFilterAllowTakerBuy) allowedKinds.push("TAKER_BUY");
    if (data.marketFilterAllowTakerSell) allowedKinds.push("TAKER_SELL");
    if (data.marketFilterAllowMakerBid) allowedKinds.push("MAKER_BID");
    if (data.marketFilterAllowMakerAsk) allowedKinds.push("MAKER_ASK");

    const includeMarketIds = parseCsv(data.marketFilterIncludeMarketIds ?? "");
    const excludeMarketIds = parseCsv(data.marketFilterExcludeMarketIds ?? "");
    const minVolumeUsd = parseOptionalNum(data.marketFilterMinVolumeUsd);
    const maxVolumeUsd = parseOptionalNum(data.marketFilterMaxVolumeUsd);
    const minLiquidityUsd = parseOptionalNum(data.marketFilterMinLiquidityUsd);
    const maxLiquidityUsd = parseOptionalNum(data.marketFilterMaxLiquidityUsd);
    const marketFilter: WalletMarketFilterV1 | null = (() => {
      const candidate: WalletMarketFilterV1 = {
        version: 1,
        ...(includeMarketIds.length > 0 ? { includeMarketIds } : {}),
        ...(excludeMarketIds.length > 0 ? { excludeMarketIds } : {}),
        ...(minVolumeUsd != null ? { minVolumeUsd } : {}),
        ...(maxVolumeUsd != null ? { maxVolumeUsd } : {}),
        ...(minLiquidityUsd != null ? { minLiquidityUsd } : {}),
        ...(maxLiquidityUsd != null ? { maxLiquidityUsd } : {}),
        ...(data.marketFilterRequireActive ? { requireActive: true } : {}),
        ...(allowedKinds.length > 0 && allowedKinds.length < 4 ? { allowedKinds } : {})
      };
      const hasRules = Object.keys(candidate).some((k) => k !== "version");
      return hasRules ? candidate : null;
    })();

    const body = {
      id: isCreating ? undefined : activeWalletId,
      name: data.name,
      startingBalance: Number(data.startingBalance),
      sizeMultiplier: Number(data.sizeMultiplier),
      maxOpenPositions: Number(data.maxOpenPositions),
      minConfidence: Number(data.minConfidence),
      minEdge: Number(data.minEdge),
      autoOpenLimit: Number(data.autoOpenLimit),
      autoTradeEnabled: Boolean(data.autoTradeEnabled),
      makerEnabled: Boolean(data.makerEnabled),
      maxDailyLossUsd: parseOptionalNum(data.maxDailyLossUsd),
      maxDrawdownPct: parseOptionalNum(data.maxDrawdownPct),
      cooldownMinutes: parseOptionalNum(data.cooldownMinutes),
      marketAllowlist: data.marketAllowlist ?? "",
      marketFilter,
      makerQuoteSize: Number(data.makerQuoteSize),
      makerQuoteWidthBps: Number(data.makerQuoteWidthBps),
      makerMinSpread: Number(data.makerMinSpread),
      makerMaxSpread: Number(data.makerMaxSpread),
      makerMinDepth: Number(data.makerMinDepth),
      makerInventoryMaxAbs: Number(data.makerInventoryMaxAbs),
      makerInventorySkewBps: Number(data.makerInventorySkewBps),
      defaultStopLossPct: parseOptionalNum(data.defaultStopLossPct),
      defaultTakeProfitPct: parseOptionalNum(data.defaultTakeProfitPct),
      defaultMaxLossAbs: parseOptionalNum(data.defaultMaxLossAbs),
      defaultMaxHoldSec: parseOptionalNum(data.defaultMaxHoldSec)
    };

    const res = await fetch("/api/wallets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    const result = await res.json().catch(() => null);
    if (!res.ok || !result?.ok) {
      console.error("Failed to save wallet", result?.error ?? "unknown error");
      return;
    }

    setIsSettingsOpen(false);
    const nextId = isCreating && result?.id ? Number(result.id) : activeWalletId;
    await refreshWallets(nextId ?? undefined);
    if (nextId != null) {
      router.push(`/positions?walletId=${nextId}`);
    }
  };

  if (wallets.length === 0) {
    return (
      <div className="min-h-[300px] flex flex-col items-center justify-center space-y-4">
        <div className="text-center space-y-2">
          <h2 className="text-lg font-bold">No Wallets Found</h2>
          <p className="text-sm text-muted-foreground">Create your first wallet to start trading.</p>
        </div>
        <Button onClick={handleCreateWallet}>Create Wallet</Button>
        <WalletSettingsDrawer
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          initialState={formData}
          onSave={handleSaveWallet}
          isCreating={isCreating}
        />
      </div>
    );
  }

  const modeLabel = activeWallet?.makerEnabled ? "Maker" : "Taker";

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 min-w-0">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight font-display text-foreground">Wallets</h1>
          <p className="text-[10px] sm:text-xs text-muted-foreground font-mono uppercase tracking-widest mt-1 break-words">
            Configure maker or taker wallets and inspect shadow positions.
          </p>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1 break-words">
            Question: which policy knobs are active, and what inventory do they produce?
          </p>
        </div>
        <WalletContextBar
          wallets={wallets.map((w) => ({ id: w.id, name: w.name, makerEnabled: w.makerEnabled }))}
          activeWalletId={activeWalletId}
          onSelect={handleWalletSelect}
          onEdit={handleEditWallet}
          onCreate={handleCreateWallet}
          inline
        />
      </div>

      <div className="flex flex-col lg:flex-row gap-4 sm:gap-6 items-start">
        <div className="flex-1 w-full min-w-0 space-y-6">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">
                Live shadow fills aggregated into wallet inventory.
              </p>
            </div>
            <ActivePositionsCard
              positions={openPositions}
              title="Open Positions"
              headerRight={
                activeWallet ? (
                  <Badge
                    variant="outline"
                    className={modeLabel === "Maker" ? "border-neon-green/40 text-neon-green" : "border-border/60 text-muted-foreground"}
                  >
                    {modeLabel}
                  </Badge>
                ) : null
              }
            />
          </div>

          {mode === "taker" && (
            <Card className="border-border/40 bg-card/20">
              <CardHeader className="border-b border-border/40">
                <CardTitle className="text-base sm:text-lg">Recent Closed Positions</CardTitle>
                <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                  Completed taker cycles derived from shadow fills.
                </p>
              </CardHeader>
              <CardContent className="p-0">
                {closedPositions.length === 0 ? (
                  <div className="p-6 text-center text-xs text-muted-foreground">No closed positions yet.</div>
                ) : (
                  <Table>
                    <TableHeader className="bg-secondary/20">
                      <TableRow className="border-border/40 hover:bg-transparent text-[10px] font-mono uppercase tracking-tighter">
                        <TableHead>Market</TableHead>
                        <TableHead>Side</TableHead>
                        <TableHead>Size</TableHead>
                        <TableHead>Entry</TableHead>
                        <TableHead>Exit</TableHead>
                        <TableHead>Realized</TableHead>
                        <TableHead>Closed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {closedPositions.map((row) => {
                        const notional = row.entryPrice * row.size;
                        const realizedPct = notional > 0 ? row.realized / notional : 0;
                        return (
                          <TableRow key={row.id} className="border-border/40">
                            <TableCell>
                              <div className="font-medium">
                                {row.question ?? row.marketId ?? row.tokenId}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {row.outcome ?? row.tokenId}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="neutral"
                                className={row.side === "LONG" ? "text-neon-green bg-neon-green/10 border-neon-green/20" : "text-rose-500 bg-rose-500/10 border-rose-500/20"}
                              >
                                {row.side}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs">{formatNum(row.size)}</TableCell>
                            <TableCell className="font-mono text-xs">{formatNum(row.entryPrice)}</TableCell>
                            <TableCell className="font-mono text-xs">{formatNum(row.exitPrice)}</TableCell>
                            <TableCell className="font-mono text-xs">
                              <div className={row.realized > 0 ? "text-neon-green" : row.realized < 0 ? "text-rose-500" : "text-muted-foreground"}>
                                {formatPct(realizedPct)}
                              </div>
                              <div className="text-[10px] text-muted-foreground">${formatNum(row.realized)}</div>
                            </TableCell>
                            <TableCell className="text-[10px] text-muted-foreground">
                              {formatTime(row.tsClose)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <Card className="w-full lg:w-[350px] bg-card/30 border-border/40 min-w-0">
          <CardHeader className="border-b border-border/40 p-3 sm:p-6 pb-3 sm:pb-4">
            <h3 className="text-base sm:text-lg font-bold tracking-tight">Wallet Controls</h3>
            <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
              Edit wallet configuration and monitor alerts.
            </p>
          </CardHeader>
          <CardContent className="p-3 sm:p-6 flex flex-col gap-4 sm:gap-6">
            {activeWallet && (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground font-mono uppercase tracking-widest">Active Wallet</div>
                <div className="flex items-center gap-2">
                  <div className="font-semibold text-foreground">{activeWallet.name}</div>
                  <Badge variant="outline" className={modeLabel === "Maker" ? "border-neon-green/40 text-neon-green" : "border-border/60 text-muted-foreground"}>
                    {modeLabel}
                  </Badge>
                </div>
                <Button variant="outline" size="sm" onClick={() => handleEditWallet(activeWallet.id)}>
                  Edit Wallet
                </Button>
              </div>
            )}
            <AlertsClient walletId={activeWalletId} />
          </CardContent>
        </Card>
      </div>

      <WalletSettingsDrawer
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        initialState={formData}
        onSave={handleSaveWallet}
        isCreating={isCreating}
      />
    </div>
  );
}
