"use client";

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Activity, Zap, DollarSign, BarChart2, CheckCircle2, Send, Ban, TrendingUp, XCircle, ShieldAlert } from "lucide-react";
import { EvidenceEvent } from "../lib/evidence";

interface EvidenceTimelineProps {
    events: EvidenceEvent[];
}

// Format metadata values appropriately based on key name
const formatMetadataValue = (key: string, value: unknown): string => {
    if (value == null) return "-";
    
    const k = key.toLowerCase();
    const num = typeof value === "number" ? value : parseFloat(String(value));
    
    // Skip formatting for non-numeric or NaN values
    if (typeof value === "string" && isNaN(num)) return value;
    
    // Percentages and rates
    if (k.includes("confidence") || k.includes("rate") || k.includes("pct")) {
        return `${(num * 100).toFixed(1)}%`;
    }
    
    // Delta values (signed percentage)
    if (k.includes("delta")) {
        const sign = num > 0 ? "+" : "";
        return `${sign}${(num * 100).toFixed(2)}%`;
    }
    
    // Spread (basis points display)
    if (k === "spread") {
        return `${(num * 100).toFixed(2)}%`;
    }
    
    // Horizon in seconds -> human readable
    if (k === "horizonsec") {
        if (num < 60) return `${num}s`;
        if (num < 3600) return `${Math.round(num / 60)}m`;
        return `${Math.round(num / 3600)}h`;
    }
    
    // Prices/mid values
    if (k === "mid" || k.includes("price") || k.includes("entry") || k.includes("exit")) {
        return num.toFixed(4);
    }
    
    // Token IDs - truncate long strings
    if (k === "tokenid" && typeof value === "string" && value.length > 20) {
        return `${value.slice(0, 8)}...${value.slice(-6)}`;
    }
    
    // Model names - keep as-is
    if (k === "model") {
        return String(value);
    }
    
    // Default: if it's a very small or large number, format appropriately
    if (typeof num === "number" && !isNaN(num)) {
        if (Math.abs(num) < 0.0001 && num !== 0) return num.toExponential(2);
        if (Math.abs(num) >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
        if (Math.abs(num) >= 1000) return `${(num / 1000).toFixed(1)}k`;
        if (Number.isInteger(num)) return String(num);
        return num.toFixed(4);
    }
    
    return String(value);
};

export function EvidenceTimeline({ events }: EvidenceTimelineProps) {
    return (
        <div className="relative pl-6 space-y-8 before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-[2px] before:bg-gradient-to-b before:from-neon-green/50 before:to-transparent before:content-['']">
            {events.map((event, i) => (
                <div key={event.id} className="relative group">
                    {/* Dot on line */}
                    <div className={cn(
                        "absolute -left-[19px] top-1 h-3 w-3 rounded-full border-2 transition-all duration-300 z-10",
                        event.type === "SIGNAL_CREATED" ? "border-neon-green bg-black shadow-[0_0_8px_theme(colors.neon.green)]" :
                            event.type === "ORDER_SUBMITTED" ? "border-amber-500 bg-black shadow-[0_0_8px_theme(colors.amber.500)]" :
                                event.type === "FILLED" ? "border-neon-blue bg-black shadow-[0_0_8px_theme(colors.neon.blue)]" :
                                    event.type === "MARKOUT" ? "border-emerald-500 bg-black shadow-[0_0_8px_theme(colors.emerald.500)]" :
                                        event.type === "EXECUTION" ? "border-neon-blue bg-black shadow-[0_0_8px_theme(colors.neon.blue)]" :
                                            event.type === "CANCELED" ? "border-rose-500 bg-black" :
                                                event.type === "EDGE_FAIL" ? "border-rose-500/80 bg-black" :
                                                    event.type === "INVENTORY_FAIL" ? "border-orange-500/80 bg-black" :
                                                        event.type === "FLOW_GATE" ? "border-yellow-500/80 bg-black" :
                                                            event.type === "REGIME_BLOCK" ? "border-amber-600/80 bg-black" :
                                                                "border-muted-foreground/50 bg-black group-hover:border-foreground"
                    )} />

                    <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums" suppressHydrationWarning>
                                {new Date(event.ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                <span className="text-[9px] opacity-50">.{new Date(event.ts).getMilliseconds().toString().padStart(3, '0')}</span>
                            </span>
                            <Badge variant="outline" className={cn(
                                "text-[9px] h-4 px-1.5 rounded-sm font-mono uppercase tracking-wider bg-black/40 backdrop-blur-sm",
                                event.type === "SIGNAL_CREATED" ? "border-neon-green/30 text-neon-green" :
                                    event.type === "ORDER_SUBMITTED" ? "border-amber-500/30 text-amber-500" :
                                        event.type === "FILLED" ? "border-neon-blue/30 text-neon-blue" :
                                            event.type === "MARKOUT" ? "border-emerald-500/30 text-emerald-500" :
                                                event.type === "EXECUTION" ? "border-neon-blue/30 text-neon-blue" :
                                                    event.type === "CANCELED" ? "border-rose-500/30 text-rose-500" :
                                                        event.type === "EDGE_FAIL" ? "border-rose-500/30 text-rose-500" :
                                                            event.type === "INVENTORY_FAIL" ? "border-orange-500/30 text-orange-500" :
                                                                event.type === "FLOW_GATE" ? "border-yellow-500/30 text-yellow-500" :
                                                                    event.type === "REGIME_BLOCK" ? "border-amber-600/30 text-amber-600" :
                                                                        "border-border/40 text-muted-foreground"
                            )}>
                                {event.type.replace("_", " ")}
                            </Badge>
                        </div>

                        <div className="p-3 rounded-sm border border-border/40 bg-card/20 backdrop-blur-sm group-hover:border-border/60 transition-colors">
                            <div className="flex items-start gap-3">
                                <div className="mt-0.5">
                                    {event.type === "SIGNAL_CREATED" && <Zap className="h-4 w-4 text-neon-green" />}
                                    {event.type === "ORDER_SUBMITTED" && <Send className="h-4 w-4 text-amber-500" />}
                                    {event.type === "FILLED" && <CheckCircle2 className="h-4 w-4 text-neon-blue" />}
                                    {event.type === "CANCELED" && <Ban className="h-4 w-4 text-rose-500" />}
                                    {event.type === "MARKOUT" && <TrendingUp className="h-4 w-4 text-emerald-500" />}
                                    {event.type === "EDGE_FAIL" && <XCircle className="h-4 w-4 text-rose-500" />}
                                    {event.type === "INVENTORY_FAIL" && <XCircle className="h-4 w-4 text-orange-500" />}
                                    {event.type === "FLOW_GATE" && <ShieldAlert className="h-4 w-4 text-yellow-500" />}
                                    {event.type === "REGIME_BLOCK" && <ShieldAlert className="h-4 w-4 text-amber-600" />}
                                    {event.type === "PRICE_UPDATE" && <DollarSign className="h-4 w-4 text-muted-foreground" />}
                                    {event.type === "ORDERBOOK_IMBALANCE" && <BarChart2 className="h-4 w-4 text-orange-400" />}
                                    {event.type === "EXECUTION" && <CheckCircle2 className="h-4 w-4 text-neon-blue" />}
                                    {event.type === "CONFIRMATION" && <Activity className="h-4 w-4 text-purple-400" />}
                                </div>
                                <div className="space-y-1 flex-1">
                                    <h4 className="text-sm font-bold font-display tracking-tight text-foreground">{event.title}</h4>
                                    <p className="text-xs text-muted-foreground font-mono leading-relaxed">{event.details}</p>

                                    {event.metadata && (
                                        <div className="grid grid-cols-2 gap-2 mt-3 pt-2 border-t border-border/20">
                                            {Object.entries(event.metadata).map(([k, v]) => (
                                                <div key={k} className="flex flex-col">
                                                    <span className="text-[9px] text-muted-foreground/50 uppercase font-mono">{k}</span>
                                                    <span className="text-xs font-mono text-foreground">{formatMetadataValue(k, v)}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
