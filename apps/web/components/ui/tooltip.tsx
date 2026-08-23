"use client";

import * as React from "react";
import { cn } from "../../lib/utils";

interface TooltipProps {
    content: string;
    children: React.ReactNode;
    className?: string;
}

export function Tooltip({ content, children, className }: TooltipProps) {
    return (
        <div className={cn("group relative inline-block", className)}>
            {children}
            <div className="invisible group-hover:visible absolute z-50 top-full left-1/2 -translate-x-1/2 mt-2 p-2 w-48 bg-slate-800 text-white text-[10px] rounded shadow-xl border border-white/10 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-center normal-case leading-relaxed font-sans">
                {content}
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 -mb-1 border-4 border-transparent border-b-slate-800" />
            </div>
        </div>
    );
}
