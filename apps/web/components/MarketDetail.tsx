"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LineChart, type ChartPoint } from "./LineChart";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader } from "./ui/card";
import { formatNum, cn } from "../lib/utils";
import { useStream } from "../hooks/useStream";
import { appConfig } from "../lib/config";
import { ArrowLeft } from "lucide-react";

type DecisionRow = {
  decisionId: number;
  ts: number;
  kind: string;
  strategyLane: string | null;
  decisionGroupId: string | null;
  decision: string;
  decisionReason: string | null;
  predEdgeBps: number | null;
  costBps: number | null;
  netEdgeBps: number | null;
  spreadBps: number | null;
  size: number | null;
  ordersCount: number;
  fillsCount: number;
  fillNotional: number;
  markout1mBpsAvg: number | null;
  markout5mBpsAvg: number | null;
};

export function MarketDetail({
  tokenId,
  marketId,
  slug,
  question,
  outcome,
  initialFeatures,
  initialDecisions
}: {
  tokenId: string;
  marketId: string;
  slug: string | null;
  question: string | null;
  outcome: string | null;
  initialFeatures: ChartPoint[];
  initialDecisions: DecisionRow[];
}) {
  const [features, setFeatures] = React.useState(initialFeatures);
  const [decisions, setDecisions] = React.useState(initialDecisions);

  type MarketStreamData = {
    features: ChartPoint[];
    decisions: DecisionRow[];
  };

  const handleStreamData = React.useCallback((data: MarketStreamData) => {
    setFeatures(data.features);
    setDecisions(data.decisions);
  }, []);

  useStream<MarketStreamData>({
    url: `/api/stream/market/${marketId}?token=${tokenId}`,
    enabled: true,
    onMessage: handleStreamData,
  });

  const router = useRouter();
  const latest = features[features.length - 1];
  const submitDecisions = decisions.filter((d) => d.decision === "SUBMIT").slice(0, 10);

  return (
    <div className="space-y-8">
      {/* Back Button */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors font-mono"
      >
        <ArrowLeft className="h-4 w-4" />
        <span>Back</span>
      </button>

      {/* Page Header */}
      <div>
        <h1 className="text-xl md:text-2xl font-bold tracking-tight font-display text-foreground leading-tight">
          {question ?? marketId}
        </h1>
        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
          Question: why did this token get a signal, and what evidence supports it?
        </p>
        <div className="flex items-center gap-3 mt-2">
          <Badge variant="neutral" className="border-border text-muted-foreground bg-transparent border">
            {outcome ?? "-"}
          </Badge>
          {slug && (
            <a
              href={`${appConfig.urls.polymarketBase}/market/${slug}`}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] font-mono uppercase tracking-widest text-neon-blue hover:underline"
            >
              View on Polymarket
            </a>
          )}
        </div>
      </div>

      {/* Chart & Stats */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr,1fr]">
        <div>
          <LineChart data={features} />
        </div>
        <div className="space-y-4">
          <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
            <CardContent className="p-4">
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Latest</div>
              <div className="mt-2 text-3xl font-mono font-bold">
                {formatNum(latest?.mid ?? null)}
              </div>
              <div className="mt-3 space-y-1 text-[11px] font-mono text-muted-foreground">
                <div className="flex justify-between">
                  <span>Spread</span>
                  <span className="text-foreground">{formatNum(latest?.spread ?? null)}</span>
                </div>
                <div className="flex justify-between">
                  <span>OBI</span>
                  <span className="text-foreground">{formatNum(latest?.obi ?? null)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Micro-Mid</span>
                  <span className="text-foreground">{formatNum(latest?.micropriceMinusMid ?? null)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Accel1m</span>
                  <span className="text-foreground">{formatNum(latest?.accel1m ?? null)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Skew30</span>
                  <span className="text-foreground">{formatNum(latest?.skew30m ?? null)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Entropy30</span>
                  <span className="text-foreground">{formatNum(latest?.entropy30m ?? null, 3)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
            <CardContent className="p-4">
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Recent Decisions</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {submitDecisions.map((d) => {
                  const isBuy = d.kind.includes("BUY") || d.kind.includes("BID");
                  return (
                    <Badge key={`decision-${d.decisionId}`} variant={isBuy ? "buy" : "sell"}>
                      {d.kind}
                    </Badge>
                  );
                })}
                {submitDecisions.length === 0 && (
                  <Badge variant="hold">
                    No submits
                  </Badge>
                )}
              </div>
              <p className="mt-3 text-[10px] text-muted-foreground font-mono">
                Decision feed is canonical: one row per decision with aggregated order, fill, and markout outcomes.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Decision Chain */}
      <Card className="bg-card/30 border-border/40 backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-3">
          <h3 className="text-lg font-bold tracking-tight">DECISION CHAIN</h3>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Decision -&gt; order/fill/markout aggregated outcomes
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border/40">
            {decisions.slice(0, 20).map((d) => (
              <details key={`decision-${d.decisionId}`} className="group">
                <summary className="cursor-pointer p-4 text-sm font-mono hover:bg-secondary/20 transition-colors flex items-center gap-3 flex-wrap" suppressHydrationWarning>
                  <span className="text-muted-foreground">{new Date(d.ts).toLocaleTimeString()}</span>
                  <Badge variant="neutral" className="text-[9px]">{d.kind}</Badge>
                  <span className={cn("font-bold", d.decision === "SUBMIT" ? "text-neon-green" : "text-rose-500")}>
                    {d.decision}
                  </span>
                  <span className="text-muted-foreground">fills {d.fillsCount}</span>
                  <span className="text-muted-foreground">net {d.netEdgeBps != null ? `${d.netEdgeBps.toFixed(2)}bps` : "-"}</span>
                </summary>
                <pre className="px-4 pb-4 whitespace-pre-wrap text-xs text-muted-foreground font-mono bg-black/20">
                  {JSON.stringify(d, null, 2)}
                </pre>
              </details>
            ))}
            {decisions.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground font-mono">
                No decision records yet
              </div>
            )}
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
