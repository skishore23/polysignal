"use client";

import Link from "next/link";
import { UniverseRow } from "../lib/queries";
import { formatNum, cn } from "../lib/utils";
import { formatHorizonLabel } from "../lib/horizons";
import { Badge } from "./ui/badge";
import { Tooltip } from "./ui/tooltip";

export function EvidencePanel({ row, horizons }: { row: UniverseRow | null; horizons: number[] }) {
  if (!row) {
    return (
      <div className="h-full border-l border-border/40 bg-transparent p-6 flex items-center justify-center text-muted-foreground text-xs font-mono uppercase tracking-widest">
        Select a market to inspect decision context
      </div>
    );
  }

  const actionable = horizons.filter((h) => {
    const signal = row.signals[h];
    return signal === "BUY" || signal === "SELL";
  });

  return (
    <div className="border-l border-border/40 bg-transparent">
      <div className="p-4 border-b border-border/40 bg-black/20">
        <h2 className="text-lg font-bold text-ink tracking-tight leading-tight">{row.question}</h2>
        <div className="flex items-center gap-2 mt-2">
          <Badge variant="neutral" className="border-border text-muted-foreground bg-transparent border">
            {row.outcome}
          </Badge>
          <Link
            href={`/market/${row.tokenId}`}
            className="text-[9px] font-mono text-neon-blue hover:underline uppercase tracking-widest ml-auto"
          >
            Details -&gt;
          </Link>
        </div>
      </div>

      <div className="p-4 space-y-6">
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[10px] font-mono uppercase text-primary/70 tracking-widest">Decision Snapshot</h3>
            <Link
              href={`/chain?id=${row.tokenId}`}
              className="text-[9px] font-mono text-neon-blue hover:underline uppercase tracking-widest"
            >
              Full Chain -&gt;
            </Link>
          </div>
          <div className="space-y-2">
            {horizons.map((h) => (
              <div key={h} className="flex items-center justify-between p-3 border border-ink/20 bg-black/20">
                <span className="text-xs font-mono text-ink/50">{formatHorizonLabel(h)}</span>
                <span
                  className={cn(
                    "font-bold font-mono",
                    row.signals[h] === "BUY"
                      ? "text-neon-green"
                      : row.signals[h] === "SELL"
                        ? "text-neon-red"
                        : "text-ink/30"
                  )}
                >
                  {row.signals[h] ?? "HOLD"}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground font-mono">
            Actionable horizons: <span className="text-foreground">{actionable.length}</span>
          </p>
        </div>

        <div>
          <h3 className="text-[10px] font-mono uppercase text-primary/70 mb-3 tracking-widest">Market Features</h3>
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <FeatureBox
              label="Mid"
              value={row.mid != null ? formatNum(row.mid) : "-"}
              color="text-ink"
              tooltip="Current midpoint from best bid/ask."
            />
            <FeatureBox
              label="Spread"
              value={row.spread != null ? formatNum(row.spread) : "-"}
              color="text-ink"
              tooltip="Bid/ask distance."
            />
            <FeatureBox
              label="OBI"
              value={row.obi != null ? `${(row.obi * 100).toFixed(1)}%` : "-"}
              color={row.obi != null ? (row.obi > 0 ? "text-neon-green" : "text-neon-red") : "text-ink"}
              tooltip="Order book imbalance at top of book."
            />
            <FeatureBox
              label="Micro-Mid"
              value={row.micropriceMinusMid != null ? formatNum(row.micropriceMinusMid) : "-"}
              color={
                row.micropriceMinusMid != null
                  ? row.micropriceMinusMid > 0
                    ? "text-neon-green"
                    : "text-neon-red"
                  : "text-ink"
              }
              tooltip="Microprice minus midpoint."
            />
            <FeatureBox
              label="Accel 1m"
              value={row.accel1m != null ? formatNum(row.accel1m) : "-"}
              color={row.accel1m != null ? (row.accel1m > 0 ? "text-neon-green" : "text-neon-red") : "text-ink"}
              tooltip="Short-horizon acceleration."
            />
            <FeatureBox
              label="Vol 30m"
              value={row.vol30m != null ? formatNum(row.vol30m) : "-"}
              color="text-ember"
              tooltip="Rolling 30-minute realized volatility."
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const FeatureBox = ({
  label,
  value,
  color = "text-ink",
  tooltip
}: {
  label: string;
  value: string;
  color?: string;
  tooltip: string;
}) => (
  <div className="border border-ink/20 p-2 bg-black/10">
    <Tooltip content={tooltip}>
      <div className="text-[9px] text-ink/50 uppercase mb-0.5 cursor-help border-b border-dotted border-ink/20 inline-block">
        {label}
      </div>
    </Tooltip>
    <div className={cn("text-sm font-mono font-bold", color)}>{value}</div>
  </div>
);
