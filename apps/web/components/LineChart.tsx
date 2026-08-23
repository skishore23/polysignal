"use client";

import * as React from "react";
import { cn } from "../lib/utils";

export type ChartPoint = {
  ts: number;
  mid: number | null;
  obi: number | null;
  micropriceMinusMid?: number | null;
  spread?: number | null;
  accel1m?: number | null;
  skew30m?: number | null;
  entropy30m?: number | null;
};

function toPath(values: number[], width: number, height: number, padding: number = 20): string {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const chartHeight = height - padding * 2;
  return values
    .map((v, idx) => {
      const x = (idx / Math.max(values.length - 1, 1)) * width;
      const y = padding + chartHeight - ((v - min) / range) * chartHeight;
      return `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function LineChart({ data, className }: { data: ChartPoint[]; className?: string }) {
  const width = 640;
  const height = 200;
  
  // Filter out null values for valid data points
  const validData = data.filter((d) => d.mid != null);
  
  if (validData.length === 0) {
    return (
      <div className={cn("w-full h-48 flex items-center justify-center border border-border/40 bg-card/30", className)}>
        <div className="text-center text-muted-foreground">
          <div className="text-sm font-mono">No chart data available</div>
          <div className="text-[10px] mt-1">Feature history will appear here once collected</div>
        </div>
      </div>
    );
  }
  
  const midValues = validData.map((d) => d.mid ?? 0);
  const obiValues = validData.map((d) => d.obi ?? 0);

  const midPath = toPath(midValues, width, height);
  const obiPath = toPath(obiValues, width, height);

  return (
    <div className={cn("w-full", className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-48 border border-border/40 bg-card/30"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient id="mid-gradient" x1="0" x2="1">
            <stop offset="0%" stopColor="#f97316" />
            <stop offset="100%" stopColor="#ea580c" />
          </linearGradient>
          <linearGradient id="obi-gradient" x1="0" x2="1">
            <stop offset="0%" stopColor="#14b8a6" />
            <stop offset="100%" stopColor="#0d9488" />
          </linearGradient>
        </defs>
        {/* Grid lines */}
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="#ffffff" strokeOpacity="0.05" />
        <line x1="0" y1={height / 4} x2={width} y2={height / 4} stroke="#ffffff" strokeOpacity="0.03" />
        <line x1="0" y1={height * 3 / 4} x2={width} y2={height * 3 / 4} stroke="#ffffff" strokeOpacity="0.03" />
        {/* Data lines */}
        {midPath && <path d={midPath} fill="none" stroke="url(#mid-gradient)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}
        {obiPath && <path d={obiPath} fill="none" stroke="url(#obi-gradient)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />}
      </svg>
      <div className="flex items-center justify-center gap-4 mt-2 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-0.5 bg-orange-500 rounded-full" />
          <span>Mid Price</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-0.5 bg-teal-500 rounded-full" />
          <span>OBI</span>
        </div>
      </div>
    </div>
  );
}
