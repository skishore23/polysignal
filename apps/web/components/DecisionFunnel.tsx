"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { ChevronDown, ChevronRight, Activity, Timer } from "lucide-react";

type FunnelData = {
  windowMin: number;
  horizonMs: number;
  since: number;
  throughput: {
    signals_created: number;
    skips_by_reason: Array<{ reason: string; count: number }>;
    orders_submitted: number;
    fills: number;
    markouts_available: number;
  };
  snapshot: {
    tradeable_universe_now: number;
  };
  latency: {
    median_submit_to_fill_ms: number | null;
    median_fill_to_markout_ms: number | null;
  };
};

export function DecisionFunnel() {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<FunnelData | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch("/api/funnel?windowMin=15&horizonMs=300000")
      .then((r) => r.json())
      .then((d: FunnelData) => {
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
          <CardTitle className="text-base font-bold tracking-tight">DECISION FUNNEL</CardTitle>
        </div>
        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
          Last 15m throughput · Right now: tradeable universe
        </p>
      </CardHeader>
      {open && (
        <CardContent className="p-3 space-y-4">
          {loading && <p className="text-[10px] text-muted-foreground font-mono">Loading...</p>}
          {!loading && data && (
            <>
              <div className="text-[10px] font-mono space-y-2">
                <div className="uppercase tracking-wider text-ink/60">Last 15m throughput</div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  <div className="border border-border/40 p-2 rounded">
                    <div className="text-ink/60">Decisions</div>
                    <div className="text-foreground font-bold">{data.throughput.signals_created}</div>
                  </div>
                  <div className="border border-border/40 p-2 rounded">
                    <div className="text-ink/60">Orders</div>
                    <div className="text-foreground font-bold">{data.throughput.orders_submitted}</div>
                  </div>
                  <div className="border border-border/40 p-2 rounded">
                    <div className="text-ink/60">Fills</div>
                    <div className="text-foreground font-bold">{data.throughput.fills}</div>
                  </div>
                  <div className="border border-border/40 p-2 rounded">
                    <div className="text-ink/60">Markouts</div>
                    <div className="text-foreground font-bold">{data.throughput.markouts_available}</div>
                  </div>
                  <div className="border border-border/40 p-2 rounded col-span-2 sm:col-span-1">
                    <div className="text-ink/60">Skips</div>
                    <div className="text-foreground font-bold">
                      {data.throughput.skips_by_reason.reduce((s, r) => s + r.count, 0)}
                    </div>
                  </div>
                </div>
                {data.throughput.skips_by_reason.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-1">
                    {data.throughput.skips_by_reason.map((r) => (
                      <span key={r.reason} className="text-ink/80 font-mono text-[10px]">
                        {r.reason}={r.count}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="text-[10px] font-mono space-y-2">
                <div className="uppercase tracking-wider text-ink/60">Right now: tradeable universe</div>
                <div className="flex items-center gap-2">
                  <Activity className="h-3 w-3 text-muted-foreground" />
                  <span className="text-foreground font-bold">{data.snapshot.tradeable_universe_now}</span>
                  <span className="text-ink/60">markets pass liquidity</span>
                </div>
              </div>
              <div className="text-[10px] font-mono space-y-2">
                <div className="uppercase tracking-wider text-ink/60">Latency</div>
                <div className="flex flex-wrap gap-4">
                  <div className="flex items-center gap-1.5">
                    <Timer className="h-3 w-3 text-muted-foreground" />
                    <span>Submit→Fill: </span>
                    <span className="font-bold">
                      {data.latency.median_submit_to_fill_ms != null
                        ? `${data.latency.median_submit_to_fill_ms.toFixed(0)} ms`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Timer className="h-3 w-3 text-muted-foreground" />
                    <span>Fill→Markout: </span>
                    <span className="font-bold">
                      {data.latency.median_fill_to_markout_ms != null
                        ? `${data.latency.median_fill_to_markout_ms.toFixed(0)} ms`
                        : "—"}
                    </span>
                  </div>
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
