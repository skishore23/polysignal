"use client";

import { UniverseRow } from "../lib/queries";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { TrendingUp, TrendingDown, Minus, Activity, BarChart2, Zap } from "lucide-react";
import { cn } from "../lib/utils";

interface OpportunityCardProps {
    row: UniverseRow;
    horizon: number;
    onClick: () => void;
    isActionable?: boolean;
}

export function OpportunityCard({ row, horizon, onClick, isActionable = false }: OpportunityCardProps) {
    const signal = row.signals[horizon] || "HOLD";
    const isBuy = signal === "BUY";
    const isSell = signal === "SELL";
    const isHold = signal === "HOLD";

    // Confidences are not in UniverseRow by default (only in OpportunityRow), 
    // so we'll simulate or just show signal for now unless we enrich the data.
    // The plan asks for "Confidence". `UniverseRow` doesn't have it directly in the Record.
    // We might need to fetch it or just omit for now. 
    // However, let's just color code the signal strongly.

    const price = row.mid ? (row.mid * 100).toFixed(1) : "-";

    return (
        <Card
            className={cn(
                "cursor-pointer active:scale-[0.98] transition-all duration-200 border-l-4 shadow-sm hover:shadow-md bg-card/40 backdrop-blur-sm overflow-hidden w-full",
                isBuy ? "border-l-emerald-500 border-t-emerald-500/10 border-r-emerald-500/10 border-b-emerald-500/10" :
                    isSell ? "border-l-rose-500 border-t-rose-500/10 border-r-rose-500/10 border-b-rose-500/10" :
                        "border-l-muted border-border/40"
            )}
            onClick={onClick}
        >
            <CardContent className="p-3 sm:p-4 space-y-2 sm:space-y-3 overflow-hidden">
                {/* Header: Market Outcome & Signal */}
                <div className="flex justify-between items-start gap-2 sm:gap-4">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1 sm:gap-2 flex-wrap mb-1">
                            <span className="text-[8px] sm:text-[10px] font-mono font-bold text-muted-foreground tracking-wider uppercase bg-secondary/50 px-1 rounded-sm truncate max-w-[80px] sm:max-w-[120px]">{row.slug?.toUpperCase() || "UNKNOWN"}</span>
                            {row.outcome === "YES" ? (
                                <Badge variant="neutral" className="text-[8px] sm:text-[9px] h-3.5 sm:h-4 px-1 sm:px-1.5 text-emerald-500 bg-emerald-500/5 border-emerald-500/20 font-mono tracking-wide flex-shrink-0">YES</Badge>
                            ) : row.outcome === "NO" ? (
                                <Badge variant="neutral" className="text-[8px] sm:text-[9px] h-3.5 sm:h-4 px-1 sm:px-1.5 text-rose-500 bg-rose-500/5 border-rose-500/20 font-mono tracking-wide flex-shrink-0">NO</Badge>
                            ) : null}
                        </div>
                        <p className="font-medium text-[11px] sm:text-sm leading-snug line-clamp-2 text-foreground/90">{row.question}</p>
                    </div>

                    <div className="flex flex-col items-end flex-shrink-0">
                        <div className={cn(
                            "text-[10px] sm:text-sm font-bold font-mono flex items-center gap-0.5 sm:gap-1.5 mb-0.5",
                            isBuy ? "text-emerald-400" : isSell ? "text-rose-400" : "text-muted-foreground"
                        )}>
                            {isBuy && <TrendingUp className="h-2.5 w-2.5 sm:h-3.5 sm:w-3.5" />}
                            {isSell && <TrendingDown className="h-2.5 w-2.5 sm:h-3.5 sm:w-3.5" />}
                            {isHold && <Minus className="h-2.5 w-2.5 sm:h-3.5 sm:w-3.5" />}
                            <span className="hidden sm:inline">{signal}</span>
                        </div>
                        <span className="text-lg sm:text-2xl font-bold tracking-tighter font-mono text-foreground">{price}<span className="text-[9px] sm:text-xs text-muted-foreground ml-0.5 font-normal">¢</span></span>
                    </div>
                </div>

                {/* Footer: Metrics */}
                <div className="flex items-center justify-between text-[9px] sm:text-[10px] text-muted-foreground pt-2.5 border-t border-border/40 border-dashed gap-2">
                    <div className="flex items-center gap-2 sm:gap-3 font-mono">
                        <span className="flex items-center gap-1">
                            <Activity className="h-3 w-3 text-sky-400/80 flex-shrink-0" />
                            <span className="text-foreground/80">{row.obi ? row.obi.toFixed(2) : "-"}</span>
                        </span>
                        <span className="flex items-center gap-1">
                            <Zap className="h-3 w-3 text-amber-400/80 flex-shrink-0" />
                            <span className="text-foreground/80">{row.accel1m ? row.accel1m.toFixed(1) : "-"}</span>
                        </span>
                    </div>

                    <div className="flex items-center flex-shrink-0">
                        <span className="font-mono text-[9px] bg-secondary px-1.5 py-0.5 rounded-sm border border-border/50 text-foreground/70">
                            {Math.round(horizon / 60)}m
                        </span>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
