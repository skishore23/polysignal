"use client";

import type { ConnectionState } from "../lib/sse/types";

const stateStyles: Record<ConnectionState, { dot: string }> = {
  connected: {
    dot: "bg-neon-green animate-live-breathe shadow-[0_0_8px_rgba(16,185,129,0.6)]",
  },
  connecting: {
    dot: "bg-yellow-500 animate-pulse",
  },
  reconnecting: {
    dot: "bg-orange-500 animate-pulse",
  },
  disconnected: {
    dot: "bg-red-500",
  },
};

type ConnectionIndicatorProps = {
  state: ConnectionState;
  lastUpdate?: number;
  formatTime?: (ts: number) => string;
  feedFreshnessSec?: number;
};

function resolveLabel(state: ConnectionState, feedFreshnessSec: number | undefined): string {
  if (state === "disconnected") return "OFFLINE";
  if (state === "connecting") return "CONNECTING";
  if (state === "reconnecting") return "RECONNECTING";
  if (state === "connected") {
    if (feedFreshnessSec != null) {
      if (feedFreshnessSec < 60) return "Live";
      return `${feedFreshnessSec}s ago`;
    }
    return "LIVE";
  }
  return "LIVE";
}

export function ConnectionIndicator({ state, lastUpdate, formatTime, feedFreshnessSec }: ConnectionIndicatorProps) {
  const { dot } = stateStyles[state];
  const label = resolveLabel(state, feedFreshnessSec);

  const defaultFormatTime = (ts: number) => {
    const diff = Date.now() - ts;
    if (diff < 1000) return "now";
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    return new Date(ts).toLocaleTimeString();
  };

  const formatter = formatTime ?? defaultFormatTime;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-black/60 border border-neon-green/20 text-[10px] font-mono">
      <div className="relative flex items-center justify-center">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        {state === "connected" && (
          <span className="absolute h-2 w-2 rounded-full bg-neon-green/40 animate-live-ring" />
        )}
      </div>
      <span className={state === "connected" ? "text-neon-green" : "text-ink/60"}>{label}</span>
      {lastUpdate != null && (
        <>
          <div className="w-px h-3 bg-ink/20" />
          <span className="text-ink/50 w-[60px] text-right" suppressHydrationWarning>{formatter(lastUpdate)}</span>
        </>
      )}
    </div>
  );
}
