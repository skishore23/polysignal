"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UniverseRow } from "../lib/queries";
import { DataGrid } from "../components/DataGrid";
import { EvidencePanel } from "../components/EvidencePanel";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { OpportunityCard } from "../components/OpportunityCard";
import { ConnectionIndicator } from "../components/ConnectionIndicator";
import { LiquidityGateStatus } from "../components/LiquidityGateStatus";
import { useStream } from "../hooks/useStream";

type HomeClientProps = {
  initialUniverse: UniverseRow[];
  horizons: number[];
};

type SortMode = "activity" | "volume";

function actionableCount(row: UniverseRow, horizons: number[]) {
  return horizons.reduce((acc, h) => {
    const sig = row.signals[h];
    if (sig != null && sig !== "HOLD") return acc + 1;
    return acc;
  }, 0);
}

function isFresh(row: UniverseRow, ttlSec: number, now: number) {
  if (ttlSec <= 0) return true;
  if (!row.ts) return false;
  const ageSec = (now - row.ts) / 1000;
  return ageSec <= ttlSec;
}

export function HomeClient({ initialUniverse, horizons }: HomeClientProps) {
  const router = useRouter();
  const [universe, setUniverse] = React.useState<UniverseRow[]>(initialUniverse);
  const [selected, setSelected] = React.useState<UniverseRow | null>(null);
  const [lastUpdate, setLastUpdate] = React.useState<number>(Date.now());
  const [visibleHorizons, setVisibleHorizons] = React.useState<number[]>(horizons);
  const [showActionableOnly, setShowActionableOnly] = React.useState(false);
  const [sortMode, setSortMode] = React.useState<SortMode>("activity");
  const [ttlSec, setTtlSec] = React.useState<number>(0);

  const selectFirst = React.useCallback((rows: UniverseRow[]) => {
    const next = rows[0] ?? null;
    if (next) {
      setSelected(next);
    }
  }, []);

  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;

  type MarketsPayload = { rows: UniverseRow[]; meta: { feedFreshnessSec: number; ts: number } };
  const [feedFreshnessSec, setFeedFreshnessSec] = React.useState<number | null>(null);

  const handleStreamData = React.useCallback(
    (payload: MarketsPayload) => {
      const rows = payload.rows ?? [];
      setUniverse(rows);
      setFeedFreshnessSec(payload.meta?.feedFreshnessSec ?? null);
      setLastUpdate(Date.now());
      const currentSelected = selectedRef.current;
      if (!currentSelected) {
        selectFirst(rows);
        return;
      }
      const stillSelected = rows.find((row) => row.tokenId === currentSelected.tokenId);
      if (!stillSelected) {
        selectFirst(rows);
      }
    },
    [selectFirst]
  );

  const transformPayload = React.useCallback((raw: unknown): MarketsPayload => {
    const o = raw as { rows?: UniverseRow[]; meta?: { feedFreshnessSec?: number; ts?: number } };
    const rows = Array.isArray(o?.rows) ? o.rows : [];
    const meta = o?.meta ?? {};
    return { rows, meta: { feedFreshnessSec: meta.feedFreshnessSec ?? 999, ts: meta.ts ?? Date.now() } };
  }, []);

  const { connectionState } = useStream<MarketsPayload>({
    url: "/api/stream/markets?limit=200",
    enabled: true,
    transform: transformPayload,
    onMessage: handleStreamData
  });

  React.useEffect(() => {
    if (!selected && universe.length > 0) {
      selectFirst(universe);
    }
  }, [universe, selected, selectFirst]);

  const formatTime = (ts: number) => {
    const now = Date.now();
    const diff = now - ts;
    if (diff < 1000) return "now";
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    return new Date(ts).toLocaleTimeString();
  };

  // Re-render every second to update the "ago" text
  const [, forceUpdate] = React.useState(0);
  React.useEffect(() => {
    const interval = setInterval(() => forceUpdate((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const nowTs = Date.now();

  const filteredUniverse = React.useMemo(() => {
    return universe
      .filter((row) => isFresh(row, ttlSec, nowTs))
      .filter((row) => {
        if (!showActionableOnly) return true;
        return actionableCount(row, visibleHorizons) > 0;
      });
  }, [universe, showActionableOnly, ttlSec, nowTs, visibleHorizons]);

  const sortedUniverse = React.useMemo(() => {
    const rows = [...filteredUniverse];
    if (sortMode === "activity") {
      rows.sort((a, b) => {
        const aCount = actionableCount(a, visibleHorizons);
        const bCount = actionableCount(b, visibleHorizons);
        if (aCount !== bCount) return bCount - aCount;
        const aVol = a.volume ?? 0;
        const bVol = b.volume ?? 0;
        return bVol - aVol;
      });
      return rows;
    }
    if (sortMode === "volume") {
      rows.sort((a, b) => {
        const aVol = a.volume ?? 0;
        const bVol = b.volume ?? 0;
        return bVol - aVol;
      });
      return rows;
    }
    return rows;
  }, [filteredUniverse, sortMode, visibleHorizons]);

  const toggleHorizon = React.useCallback((h: number) => {
    setVisibleHorizons((prev) => {
      if (prev.includes(h)) return prev.filter((x) => x !== h);
      return [...prev, h].sort((a, b) => a - b);
    });
  }, []);

  const totalRows = sortedUniverse.length;
  const actionableRows = sortedUniverse.filter((row) => actionableCount(row, visibleHorizons) > 0).length;

  React.useEffect(() => {
    if (!selected && sortedUniverse.length > 0) {
      setSelected(sortedUniverse[0] ?? null);
      return;
    }
    if (selected && !sortedUniverse.some((row) => row.tokenId === selected.tokenId)) {
      setSelected(sortedUniverse[0] ?? null);
    }
  }, [selected, sortedUniverse]);

  return (
    <div className="p-4 md:p-6 lg:p-10 max-w-8xl space-y-8 overflow-x-hidden">
      {/* Page header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 min-w-0">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight font-display text-foreground">
            DECISION UNIVERSE
          </h1>
          <p className="text-[10px] sm:text-xs text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Live market decisions ranked by activity and liquidity
          </p>
        </div>
        <ConnectionIndicator
          state={connectionState}
          lastUpdate={lastUpdate}
          formatTime={formatTime}
          feedFreshnessSec={feedFreshnessSec ?? undefined}
        />
      </div>

      <Card className="bg-card/20 border-neon-blue/20">
        <CardHeader className="border-b border-border/40 py-3">
          <h3 className="text-sm font-bold tracking-tight">Start Here</h3>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            First-time flow: observe, explain, validate, monetize, control, adapt
          </p>
        </CardHeader>
        <CardContent className="p-3 md:p-4">
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mb-2">
            Each page answers one question. Follow them in order.
          </p>
          <div className="grid gap-2 md:grid-cols-3 text-[10px] font-mono">
            <Link className="rounded border border-border/40 bg-card/20 px-3 py-2 hover:border-neon-green/40 transition-colors" href="/">
              1. Markets: live decisions and feature state
            </Link>
            <Link className="rounded border border-border/40 bg-card/20 px-3 py-2 hover:border-neon-green/40 transition-colors" href="/chain">
              2. Decision Chain: decision to order to fill to markout
            </Link>
            <Link className="rounded border border-border/40 bg-card/20 px-3 py-2 hover:border-neon-green/40 transition-colors" href="/performance">
              3. Performance: realized/unrealized PnL and execution
            </Link>
            <Link className="rounded border border-border/40 bg-card/20 px-3 py-2 hover:border-neon-green/40 transition-colors" href="/positions">
              4. Wallets: policy and risk controls
            </Link>
            <Link className="rounded border border-border/40 bg-card/20 px-3 py-2 hover:border-neon-green/40 transition-colors" href="/regimes">
              5. Regimes: Markov diagnostics and gating readiness
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Filters - wrapped layout for all screen sizes */}
      <div className="text-[9px] sm:text-[10px] font-mono p-2 md:p-3 rounded-sm border border-border/40 bg-card/10">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 md:gap-3">
          <button
            className={`px-1.5 sm:px-2 md:px-3 py-1 md:py-1.5 rounded-sm border transition-colors whitespace-nowrap ${showActionableOnly ? "border-neon-green text-neon-green bg-neon-green/5" : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"}`}
            onClick={() => setShowActionableOnly((v) => !v)}
          >
            {showActionableOnly ? "Actionable" : "All"}
          </button>
          <div className="flex items-center gap-1 sm:gap-1.5">
            <select
              className="bg-card/50 border border-border/60 rounded-sm px-1 sm:px-1.5 md:px-2 py-1 md:py-1.5 text-foreground"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
            >
              <option value="activity">Activity</option>
              <option value="volume">Volume</option>
            </select>
          </div>
          <div className="flex items-center gap-0.5 sm:gap-1 flex-wrap">
            {horizons.map((h) => {
              const label = `${Math.round(h / 60)}m`;
              const active = visibleHorizons.includes(h);
              return (
                <button
                  key={h}
                  className={`px-1 sm:px-1.5 md:px-2 py-1 md:py-1.5 rounded-sm border transition-colors ${active ? "border-neon-green text-neon-green bg-neon-green/5" : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"}`}
                  onClick={() => toggleHorizon(h)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-0.5 sm:gap-1 flex-wrap">
            {[0, 30, 60, 120].map((sec) => (
              <button
                key={sec}
                className={`px-1 sm:px-1.5 md:px-2 py-1 md:py-1.5 rounded-sm border transition-colors ${ttlSec === sec ? "border-neon-green text-neon-green bg-neon-green/5" : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"}`}
                onClick={() => setTtlSec(sec)}
              >
                {sec === 0 ? "Off" : `${sec}s`}
              </button>
            ))}
          </div>
        </div>
        {/* Stats row - separate line on mobile */}
        <div className="flex items-center gap-4 text-muted-foreground mt-2 pt-2 border-t border-border/20 md:hidden">
          <span>Rows: <span className="text-foreground">{totalRows}</span></span>
          <span>Actionable: <span className="text-neon-green">{actionableRows}</span></span>
        </div>
        <div className="hidden md:flex ml-auto items-center gap-4 text-muted-foreground mt-2">
          <span>Rows: <span className="text-foreground">{totalRows}</span></span>
          <span>Actionable: <span className="text-neon-green">{actionableRows}</span></span>
        </div>
      </div>
      <LiquidityGateStatus />
      <div className="flex flex-col lg:flex-row gap-6 items-start min-w-0">
        {/* Mobile View: Opportunity Cards */}
        <div className="md:hidden w-full space-y-3 pb-24 min-w-0 overflow-hidden">
          {sortedUniverse.map((row) => (
            <OpportunityCard
              key={row.tokenId}
              row={row}
              horizon={visibleHorizons[0] || 300}
              onClick={() => {
                router.push(`/market/${row.tokenId}`);
              }}
            />
          ))}
        </div>

        {/* Desktop View: DataGrid + Evidence Panel */}
        <div className="hidden md:flex flex-col lg:flex-row opacity-100 transition-opacity gap-6 w-full">
          <Card className="flex-1 w-full min-w-0 bg-card/10 border-border/40">
            <CardHeader className="border-b border-border/40 py-3">
              <h3 className="text-lg font-bold tracking-tight">MARKET ASSETS</h3>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                Live orderbook features and decision activity across horizons
              </p>
            </CardHeader>
            <CardContent className="p-0 overflow-hidden">
              <DataGrid
                data={sortedUniverse}
                horizons={visibleHorizons}
                selectedId={selected?.tokenId}
                onSelect={(row) => {
                  setSelected(row);
                }}
              />
            </CardContent>
          </Card>
          <Card className="w-full lg:w-[350px] flex-none bg-card/30 border-border/40">
            <CardContent className="p-0">
              <EvidencePanel row={selected} horizons={horizons} />
            </CardContent>
          </Card>
        </div>
      </div>

    </div>
  );
}
