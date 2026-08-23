"use client";

import * as React from "react";
import { useStream } from "../hooks/useStream";

type AlertRow = {
  id: number;
  ts: number;
  type: string;
  token_id: string | null;
  market_id: string | null;
  question?: string | null;
  outcome?: string | null;
  payload?: unknown;
};

type AlertItem = AlertRow & { key: string };


type SystemHealth = {
  feedFreshnessSec: number;
  activeTokens: number;
  signalsLast5m: number;
  isHealthy: boolean;
};


type MakerStats = {
  openPositions: number;
  totalRealized: number;
  totalUnrealized: number;
  netPnl: number;
  avgSpreadCapture: number;
  avgFillRate: number;
  fillsLast1h: number;
  longExposure: number;
  shortExposure: number;
  inventorySkew: number;
};

type MakerFill = {
  tokenId: string;
  question: string | null;
  outcome: string | null;
  side: string;
  price: number;
  size: number;
  ts: number;
};

type MakerRiskPosition = {
  tokenId: string;
  question: string | null;
  outcome: string | null;
  position: number;
  avgEntry: number;
  mid: number | null;
  unrealized: number;
  pnlPct: number;
  riskType: "high_exposure" | "underwater" | "inventory_imbalance";
};

type IntelligenceData = {
  makerStats: MakerStats | null;
  makerFills: MakerFill[];
  makerRiskPositions: MakerRiskPosition[];
  systemHealth: SystemHealth;
  isMakerWallet: boolean;
};

function shortId(value: string) {
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

const alertLabel = (type: string) => {
  switch (type) {
    case "EXIT_SUGGESTED":
      return "Exit suggested";
    case "STOP_HIT":
      return "Stop hit";
    case "MAX_LOSS_HIT":
      return "Max loss hit";
    case "TAKE_PROFIT_HIT":
      return "Take profit hit";
    case "MAX_HOLD_HIT":
      return "Max hold hit";
    case "POSITION_OPENED":
      return "Position opened";
    case "TEST_ALERT":
      return "Test alert";
    case "RECONNECT":
      return "Feed reconnected";
    case "STALE_DATA":
      return "Feed stale";
    default:
      return type;
  }
};

const alertAction = (type: string) => {
  switch (type) {
    case "EXIT_SUGGESTED":
      return "Action: consider closing the exposure.";
    case "STOP_HIT":
      return "Action: stop hit, close the exposure.";
    case "MAX_LOSS_HIT":
      return "Action: max loss limit reached, close the exposure.";
    case "TAKE_PROFIT_HIT":
      return "Action: take profit, close the exposure.";
    case "MAX_HOLD_HIT":
      return "Action: max hold time reached, close the exposure.";
    case "POSITION_OPENED":
      return "Action: new order opened, monitor for exit signals.";
    case "TEST_ALERT":
      return "Action: test event only.";
    default:
      return "Action: review details.";
  }
};

const formatPct = (value: number) => `${(value * 100).toFixed(2)}%`;

export function AlertsFeed({ walletId }: { walletId?: number | null }) {
  const [alerts, setAlerts] = React.useState<AlertItem[]>([]);
  const [intelligence, setIntelligence] = React.useState<IntelligenceData | null>(null);
  const [lastUpdate, setLastUpdate] = React.useState<number>(Date.now());

  // Stream alerts with reliable connection
  const handleAlerts = React.useCallback((data: AlertRow[]) => {
    setAlerts((prev) => {
      const next = [...prev];
      for (const alert of data) {
        const key = `${alert.type}:${alert.token_id ?? "system"}:${alert.market_id ?? ""}`;
        const idx = next.findIndex((item) => item.key === key);
        if (idx >= 0) next.splice(idx, 1);
        next.unshift({ ...alert, key });
      }
      return next.slice(0, 20);
    });
  }, []);

  useStream<AlertRow[]>({
    url: "/api/stream/alerts",
    enabled: true,
    onMessage: handleAlerts,
  });

  // Fetch intelligence data
  React.useEffect(() => {
    const fetchIntelligence = () => {
      const url = walletId != null ? `/api/wallet-intelligence?walletId=${walletId}` : "/api/wallet-intelligence";
      fetch(url)
        .then((res) => res.json())
        .then((data) => {
          setIntelligence(data);
          setLastUpdate(Date.now());
        })
        .catch(() => {});
    };

    fetchIntelligence();
    const interval = setInterval(fetchIntelligence, 5000);
      return () => clearInterval(interval);
  }, [walletId]);

  const actionable = alerts.filter(
    (alert) => alert.type !== "STALE_DATA" && alert.type !== "RECONNECT"
  );

  const health = intelligence?.systemHealth;
  const makerStats = intelligence?.makerStats;
  const makerFills = intelligence?.makerFills ?? [];
  const makerRiskPositions = intelligence?.makerRiskPositions ?? [];
  const isMakerWallet = intelligence?.isMakerWallet ?? false;

  return (
    <div className="space-y-6">
      {/* System Health */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-primary/70">System Pulse</div>
          <div className="flex items-center gap-2 text-[9px] font-mono">
            <div className="relative flex items-center justify-center">
              <span className="h-1.5 w-1.5 rounded-full bg-neon-green animate-live-breathe" />
              <span className="absolute h-1.5 w-1.5 rounded-full bg-neon-green/50 animate-live-ring" />
            </div>
            <span className="text-ink/40" suppressHydrationWarning>{new Date(lastUpdate).toLocaleTimeString()}</span>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 sm:gap-2 text-[10px]">
          <div className={`border p-2 col-span-2 sm:col-span-1 ${health?.isHealthy ? "border-neon-green/50 bg-neon-green/5" : "border-neon-red/50 bg-neon-red/5"}`}>
            <div className="text-ink/50">Feed</div>
            <div className={health?.isHealthy ? "text-neon-green" : "text-neon-red"}>
              {health ? (health.feedFreshnessSec < 60 ? "Live" : `${health.feedFreshnessSec}s stale`) : "..."}
            </div>
          </div>
          <div className="border border-ink/20 p-2">
            <div className="text-ink/50">Tokens</div>
            <div className="text-ink">{health?.activeTokens ?? "-"}</div>
          </div>
          <div className="border border-ink/20 p-2">
            <div className="text-ink/50">Signals/5m</div>
            <div className="text-ink">{health?.signalsLast5m ?? "-"}</div>
          </div>
        </div>
      </div>

      {/* Maker Stats */}
      {walletId != null && isMakerWallet && makerStats && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-primary/70 mb-3">Maker Performance</div>
          <div className="grid grid-cols-2 gap-1.5 sm:gap-2 text-[10px]">
            <div className="border border-ink/20 p-1.5 sm:p-2">
              <div className="text-ink/50">Open Positions</div>
              <div className="text-ink">{makerStats.openPositions}</div>
            </div>
            <div className="border border-ink/20 p-1.5 sm:p-2">
              <div className="text-ink/50">Net PnL</div>
              <div className={makerStats.netPnl >= 0 ? "text-neon-green" : "text-neon-red"}>
                {makerStats.netPnl >= 0 ? "+" : ""}${makerStats.netPnl.toFixed(2)}
              </div>
            </div>
            <div className="border border-ink/20 p-1.5 sm:p-2">
              <div className="text-ink/50">Spread Capture</div>
              <div className="text-ink">{formatPct(makerStats.avgSpreadCapture)}</div>
            </div>
            <div className="border border-ink/20 p-1.5 sm:p-2">
              <div className="text-ink/50">Fills/1h</div>
              <div className="text-ink">{makerStats.fillsLast1h}</div>
            </div>
          </div>
          <div className="mt-2 border border-ink/20 p-2">
            <div className="text-ink/50 text-[10px] mb-1">Inventory</div>
            <div className="flex items-center gap-2 text-[10px]">
              <span className="text-neon-green">{makerStats.longExposure.toFixed(0)} L</span>
              <div className="flex-1 h-1.5 bg-ink/20 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-neon-green to-neon-red"
                  style={{ 
                    width: "100%",
                    clipPath: `inset(0 ${50 - makerStats.inventorySkew * 50}% 0 ${50 + makerStats.inventorySkew * 50}%)` 
                  }}
                />
                <div 
                  className={`h-full -mt-1.5 ${makerStats.inventorySkew >= 0 ? "bg-neon-green" : "bg-neon-red"}`}
                  style={{ width: `${50 + makerStats.inventorySkew * 50}%` }}
                />
              </div>
              <span className="text-neon-red">{makerStats.shortExposure.toFixed(0)} S</span>
            </div>
          </div>
        </div>
      )}

      {/* Maker Risk Positions */}
      {isMakerWallet && makerRiskPositions.length > 0 && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-neon-orange mb-3">
            Risk Positions ({makerRiskPositions.length})
          </div>
          <div className="space-y-2">
            {makerRiskPositions.slice(0, 5).map((pos, idx) => (
              <div key={`${pos.tokenId}-${idx}`} className="border border-ink/20 p-2 bg-black/20 text-xs">
                <div className="flex justify-between items-start">
                  <span className={`font-medium ${pos.riskType === "underwater" ? "text-neon-red" : "text-neon-orange"}`}>
                    {pos.riskType === "underwater" ? "Underwater" : "High Exposure"}
                  </span>
                  <span className={`font-mono ${pos.pnlPct >= 0 ? "text-neon-green" : "text-neon-red"}`}>
                    {formatPct(pos.pnlPct)}
                  </span>
                </div>
                <div className="text-neon-blue truncate mt-1">{pos.question ?? shortId(pos.tokenId)}</div>
                <div className="text-ink/50 text-[10px] mt-1">
                  {pos.position > 0 ? "LONG" : "SHORT"} {Math.abs(pos.position)} @ {pos.avgEntry.toFixed(4)}
                  {pos.mid && <span> • Mark: {pos.mid.toFixed(4)}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Maker Recent Fills */}
      {isMakerWallet && makerFills.length > 0 && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-primary/70 mb-3">
            Recent Fills
          </div>
          <div className="space-y-2">
            {makerFills.slice(0, 5).map((fill, idx) => (
              <div key={`${fill.tokenId}-${fill.ts}-${idx}`} className="bg-black/30 border border-ink/20 p-2 text-xs">
                <div className="flex justify-between items-start">
                  <span className={`font-medium ${fill.side === "BUY" ? "text-neon-green" : "text-neon-red"}`}>
                    {fill.side} {fill.size}
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono" suppressHydrationWarning>
                    {new Date(fill.ts).toLocaleTimeString()}
                  </span>
                </div>
                <div className="text-neon-blue truncate mt-1 text-[11px]">
                  {fill.question ?? shortId(fill.tokenId)}
                </div>
                <div className="text-ink/50 text-[10px] mt-1">
                  {fill.outcome} @ {fill.price.toFixed(4)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action Alerts - only show when there are alerts */}
      {actionable.length > 0 && (
          <div>
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-neon-red mb-3">Action Required</div>
            <div className="space-y-2">
              {actionable.map((alert) => {
                const label = alert.question ?? alert.market_id ?? "System";
                const tokenLabel = alert.token_id ? shortId(alert.token_id) : null;
                const payload = alert.payload as { reason?: string; mark?: number; message?: string } | null;
                return (
                <div key={alert.id ?? alert.key} className="bg-black/40 border border-neon-red/40 p-3 text-xs">
                    <div className="flex justify-between items-start mb-1">
                      <span className="font-bold text-white">{alertLabel(alert.type)}</span>
                      <span className="text-[10px] text-muted-foreground font-mono" suppressHydrationWarning>{new Date(alert.ts).toLocaleTimeString()}</span>
                    </div>
                    <div className="text-neon-blue mb-1 truncate">{label}</div>
                    <div className="text-ink/60 mb-2 font-mono text-[10px]">
                      {alert.outcome ?? (tokenLabel ? `Token ${tokenLabel}` : "system")}
                    </div>
                  <div className="bg-white/5 p-2 mb-2 text-ink/80">{alertAction(alert.type)}</div>
                    {payload?.reason && <div className="text-muted-foreground text-[10px]">Reason: {payload.reason}</div>}
                  {payload?.mark != null && <div className="text-muted-foreground text-[10px]">Mark {payload.mark.toFixed(4)}</div>}
                    {payload?.message && <div className="text-muted-foreground text-[10px]">{payload.message}</div>}
                  </div>
                );
              })}
          </div>
        </div>
      )}

    </div>
  );
}
