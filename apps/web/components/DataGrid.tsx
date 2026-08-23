"use client";

import * as React from "react";
import Link from "next/link";
import { formatNum, cn } from "../lib/utils";
import { UniverseRow } from "../lib/queries";
import { formatHorizonLabel } from "../lib/horizons";
import { Badge } from "./ui/badge";
import { Tooltip } from "./ui/tooltip";
import { Info } from "lucide-react";

type DataGridProps = {
    data: UniverseRow[];
    horizons: number[];
    onSelect?: (row: UniverseRow) => void;
    selectedId?: string | null;
};

const DecisionBadge = ({ decision }: { decision: string | null }) => {
    if (!decision || decision === "HOLD") return <span className="text-muted-foreground">-</span>;
    const color = decision === "BUY" ? "text-neon-green" : "text-neon-red";
    return (
        <span className={cn(
            "font-bold tracking-wider transition-all cursor-pointer",
            "hover:underline hover:decoration-dotted",
            color
        )}>
            {decision}
        </span>
    );
};

export function DataGrid({ data, horizons, onSelect, selectedId }: DataGridProps) {
    return (
        <div className="w-full min-w-0 bg-transparent text-xs font-mono">
            <table className="w-full text-left border-collapse border-spacing-0">
                <thead className="bg-black/40 text-ink/50 uppercase tracking-tighter font-mono text-[10px]">
                    <tr className="border-b border-border/30">
                        <th className="p-3 border-b border-border/30">
                            <span className="flex items-center gap-1.5">
                                Market Assets
                                <Tooltip content="Polymarket outcome tokens being traded by the models.">
                                    <Info className="w-3 h-3 text-muted-foreground/40" />
                                </Tooltip>
                            </span>
                        </th>
                        <th className="p-3 border-b border-border/30 text-right">
                            <Tooltip content="Market trading volume (USD). Higher volume = more liquidity.">
                                <span className="cursor-help border-b border-dotted border-mist/20">Volume</span>
                            </Tooltip>
                        </th>
                        <th className="p-3 border-b border-border/30 text-right">
                            <Tooltip content="The mid-point between the current best Bid and Ask prices.">
                                <span className="cursor-help border-b border-dotted border-mist/20">Mid</span>
                            </Tooltip>
                        </th>
                        <th className="p-3 border-b border-border/30 text-right">
                            <Tooltip content="Bid-Ask Spread: the liquidity gap. Lower is better.">
                                <span className="cursor-help border-b border-dotted border-mist/20">Spread</span>
                            </Tooltip>
                        </th>
                        <th className="p-3 border-b border-border/30 text-center">
                            <Tooltip content="Order Book Imbalance: ratio of buy vs sell volume. Green = buy pressure.">
                                <span className="cursor-help border-b border-dotted border-mist/20">OBI</span>
                            </Tooltip>
                        </th>
                        <th className="p-3 border-b border-border/30 text-center">
                            <Tooltip content="Price Acceleration: 1-minute momentum trend indicator.">
                                <span className="cursor-help border-b border-dotted border-mist/20">Accel</span>
                            </Tooltip>
                        </th>
                        {horizons.map((h) => (
                            <th key={h} className="p-3 border-b border-border/30 text-center">
                                <Tooltip content={`Latest decision direction over ${formatHorizonLabel(h)}; BUY/SELL are derived from latest submit side.`}>
                                    <span className="cursor-help border-b border-dotted border-mist/20">{formatHorizonLabel(h)}</span>
                                </Tooltip>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="font-mono text-[11px]">
                    {data.map((row) => (
                        <tr
                            key={row.tokenId}
                            onClick={() => onSelect?.(row)}
                            className={cn(
                                "border-b border-border/20 hover:bg-white/5 cursor-pointer transition-colors",
                                selectedId === row.tokenId && "bg-white/10"
                            )}
                        >
                            <td className="p-3 font-semibold text-ink min-w-0">
                                <div className="flex flex-col min-w-0">
                                    <span className="leading-tight truncate">{row.question}</span>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider truncate">{row.outcome ?? "Unknown"}</span>
                                        <span className="text-[8px] px-1 py-0.5 bg-slate rounded text-muted-foreground/40 font-bold tracking-tighter uppercase flex-shrink-0">Bet Token</span>
                                    </div>
                                </div>
                            </td>
                            <td className="p-3 text-right text-ink/80 font-mono">
                                {row.volume != null && row.volume > 0
                                    ? row.volume >= 1000000
                                        ? `$${(row.volume / 1000000).toFixed(2)}M`
                                        : `$${(row.volume / 1000).toFixed(0)}k`
                                    : "-"}
                            </td>
                            <td className="p-3 text-right text-ink font-mono">{row.mid != null ? formatNum(row.mid) : "-"}</td>
                            <td className="p-3 text-right text-muted-foreground font-mono">{row.spread != null ? formatNum(row.spread) : "-"}</td>
                            <td className="p-3 text-center">
                                <div className="w-16 h-1 bg-slate relative  overflow-hidden">
                                    <div
                                        className={cn("absolute h-full", (row.obi || 0) > 0 ? "bg-neon-green right-1/2" : "bg-neon-red left-1/2")}
                                        style={{ width: `${Math.min(Math.abs(row.obi || 0) * 50, 50)}%` }}
                                    />
                                </div>
                            </td>
                            <td className="p-3 text-center">
                                <span className={cn(
                                    "font-bold",
                                    row.accel1m == null ? "text-muted-foreground" : (row.accel1m > 0 ? "text-neon-green" : "text-neon-red")
                                )}>
                                    {row.accel1m == null ? "-" : (row.accel1m > 0 ? "▲" : "▼")}
                                </span>
                            </td>
                            {horizons.map((h) => (
                                <td key={h} className="p-3 text-center">
                                    <DecisionBadge decision={row.signals[h] ?? null} />
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
