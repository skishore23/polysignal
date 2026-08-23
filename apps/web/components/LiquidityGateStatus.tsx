"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

type TokenGate = {
  tokenId: string;
  freshnessSec: number | null;
  spreadBps: number | null;
  depth: number | null;
  pass: boolean;
  failReason?: "staleness" | "spread" | "depth";
  updatesPerMin: number | null;
};

type LiquidityGateData = {
  tokens: TokenGate[];
  global: {
    submits: number;
    skipsByReason: { reason: string; count: number }[];
    fills: number;
    tradeableUniverseSize?: number;
    failCountByReason?: { staleness: number; spread: number; depth: number };
  };
};

export function LiquidityGateStatus() {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<LiquidityGateData | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch("/api/liquidity-gate")
      .then((r) => r.json())
      .then((d: LiquidityGateData) => {
        setData(d);
      })
      .catch(() => {
        setData(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open]);

  return (
    <Card className="border-border/40 bg-card/10">
      <CardHeader
        className="cursor-pointer select-none py-3 border-b border-border/40"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <CardTitle className="text-base font-bold tracking-tight">LIQUIDITY GATE</CardTitle>
        </div>
        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
          Right now: tradeable universe · per-market pass/fail
        </p>
      </CardHeader>
      {open && (
        <CardContent className="p-3 space-y-3">
          {loading && <p className="text-[10px] text-muted-foreground font-mono">Loading...</p>}
          {!loading && data && (
            <>
              <div className="text-[10px] font-mono space-y-2">
                <div className="uppercase tracking-wider text-ink/60">Right now: tradeable universe</div>
                <div className="flex items-center gap-2">
                  <span className="text-foreground font-bold">{data.global.tradeableUniverseSize ?? 0}</span>
                  <span className="text-ink/60">markets pass liquidity</span>
                </div>
                {data.global.failCountByReason && (
                  <div className="flex flex-wrap gap-3 text-ink/80">
                    <span>Fail: staleness={data.global.failCountByReason.staleness}</span>
                    <span>spread={data.global.failCountByReason.spread}</span>
                    <span>depth={data.global.failCountByReason.depth}</span>
                  </div>
                )}
              </div>
              <div className="text-[10px] font-mono space-y-2">
                <div className="uppercase tracking-wider text-ink/60">Last 15 min</div>
                <div className="flex flex-wrap gap-4">
                  <span>
                    Submits: <span className="text-foreground font-bold">{data.global.submits}</span>
                  </span>
                  <span>
                    Fills: <span className="text-foreground font-bold">{data.global.fills}</span>
                  </span>
                  {data.global.skipsByReason.length > 0 && (
                    <span>
                      Skips:{" "}
                      {data.global.skipsByReason.map((s) => (
                        <span key={s.reason} className="text-ink/80">
                          {s.reason}={s.count}{" "}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
              <div className="text-[10px] font-mono space-y-2">
                <div className="uppercase tracking-wider text-ink/60">Top tokens (pass/fail)</div>
                <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                  {data.tokens.slice(0, 20).map((t) => (
                    <span
                      key={t.tokenId}
                      className={cn(
                        "px-1.5 py-0.5 rounded border",
                        t.pass ? "border-neon-green/50 bg-neon-green/5 text-neon-green" : "border-ink/30 bg-ink/5 text-ink/70"
                      )}
                      title={`${t.tokenId}: ${t.failReason ?? "pass"} | fresh=${t.freshnessSec ?? "-"}s spread=${t.spreadBps != null ? t.spreadBps.toFixed(1) : "-"}bps depth=${t.depth ?? "-"}`}
                    >
                      {t.tokenId.slice(0, 8)}
                      {t.failReason != null && <span className="opacity-70">({t.failReason})</span>}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}
          {!loading && !data && <p className="text-[10px] text-muted-foreground font-mono">No data</p>}
        </CardContent>
      )}
    </Card>
  );
}
