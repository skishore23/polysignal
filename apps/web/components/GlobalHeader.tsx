"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "../lib/utils";
import { ChevronDown, Circle, Activity } from "lucide-react";
import { TopNav } from "./TopNav";

export function GlobalHeader() {
    return (
        <header className="flex-none px-4 py-3 border-b border-border/60 flex items-center justify-between bg-background/80 backdrop-blur-xl z-20 sticky top-0">
            <div className="flex items-center gap-4">
                <div className="flex flex-col">
                    <h1 className="text-xl font-bold tracking-tighter leading-none flex items-center gap-1.5" style={{ fontFamily: "var(--font-space-mono)" }}>
                        <span className="text-foreground">POLY</span>
                        <span className="h-2 w-2 bg-neon-green animate-live-breathe inline-block rounded-full shadow-[0_0_10px_rgba(74,222,128,0.5)]" />
                        <span className="text-foreground">SIGNAL</span>
                    </h1>
                    <span className="text-[9px] text-muted-foreground font-mono tracking-widest uppercase md:hidden flex items-center gap-1 mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-neon-green/50"></span>
                        ALPHA_1
                    </span>
                </div>
                <div className="hidden md:block ml-8">
                    <TopNav />
                </div>
            </div>

            <div className="flex items-center gap-2">
                {/* Mode Pill */}
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-secondary/80 rounded-sm border border-border/50 shadow-sm backdrop-blur-sm">
                    <div className="h-1.5 w-1.5 rounded-full bg-neon-green animate-pulse" />
                    <span className="text-[10px] font-mono font-bold text-foreground tracking-widest">LIVE</span>
                </div>

                {/* Status indicator */}
                <div className="h-8 w-8 rounded-sm bg-secondary/80 flex items-center justify-center border border-border/50 text-neon-green shadow-inner">
                    <Activity className="h-4 w-4" />
                </div>
            </div>
        </header>
    );
}
