"use client";

import { cn } from "../lib/utils";
import { MoveRight, Circle, Database, BrainCircuit, Activity } from "lucide-react";

export function SignalProvenanceGraph() {
    const nodes = [
        { id: "src", label: "Market Data", type: "source", icon: Database, color: "text-muted-foreground" },
        { id: "feat", label: "Feature Engine", type: "process", icon: Activity, color: "text-neon-blue" },
        { id: "rules", label: "Signal Rules", type: "logic", icon: BrainCircuit, color: "text-purple-400" },
        { id: "sig", label: "Signal (BUY/SELL)", type: "output", icon: Circle, color: "text-neon-green" }
    ];

    return (
        <div className="relative p-6 rounded-md bg-black/40 border border-border/40 overflow-hidden">
            {/* Background Grid */}
            <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:14px_24px]" />

            <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-4 md:gap-2">
                {nodes.map((node, i) => {
                    const Icon = node.icon;
                    return (
                        <div key={node.id} className="flex items-center">
                            {/* Node */}
                            <div className="flex flex-col items-center gap-2 group">
                                <div className={cn(
                                    "h-12 w-12 rounded-lg bg-card/50 border border-border/60 flex items-center justify-center shadow-sm backdrop-blur-sm transition-all duration-300 group-hover:scale-110",
                                    node.type === "output" && "border-neon-green/50 shadow-[0_0_15px_rgba(74,222,128,0.2)] bg-neon-green/5"
                                )}>
                                    <Icon className={cn("h-6 w-6", node.color)} />
                                </div>
                                <div className="text-center">
                                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{node.type}</div>
                                    <div className="text-xs font-bold font-display">{node.label}</div>
                                </div>
                            </div>

                            {/* Connector (if not last) */}
                            {i < nodes.length - 1 && (
                                <div className="hidden md:flex flex-1 mx-4 items-center justify-center text-muted-foreground/30">
                                    <div className="h-[2px] w-12 bg-border/40 relative">
                                        <div className="absolute inset-0 bg-primary/20 w-1/2 animate-flow-beam" />
                                    </div>
                                    <MoveRight className="h-4 w-4 ml-[-8px]" />
                                </div>
                            )}

                            {/* Mobile Connector */}
                            {i < nodes.length - 1 && (
                                <div className="md:hidden h-8 w-[2px] bg-border/40 my-2 relative">
                                    <div className="absolute inset-0 bg-primary/20 h-1/2 animate-flow-beam-vertical" />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            <div className="mt-8 pt-4 border-t border-border/20 grid grid-cols-3 gap-4 text-center">
                <div>
                    <div className="text-[9px] uppercase font-mono text-muted-foreground">Rules</div>
                    <div className="text-sm font-mono font-bold">Deterministic</div>
                </div>
                <div>
                    <div className="text-[9px] uppercase font-mono text-muted-foreground">Trail</div>
                    <div className="text-sm font-mono font-bold">Evidence persisted</div>
                </div>
                <div>
                    <div className="text-[9px] uppercase font-mono text-muted-foreground">Audit</div>
                    <div className="text-sm font-mono font-bold text-neon-green">Replayable</div>
                </div>
            </div>
        </div>
    );
}
