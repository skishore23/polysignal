#!/usr/bin/env tsx

import { execSync } from "child_process";
import { getDb } from "../apps/web/lib/db.js";
import { getPositions, getPositionSummary } from "../apps/web/lib/queries.js";

type Metrics = {
  timestamp: string;
  totalPositions: number;
  openPositions: number;
  closedPositions: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgHoldTime: number;
  exitReasons: Record<string, number>;
  instantExits: number;
  signalFlipExits: number;
  stopLossExits: number;
  unrealizedPnl: number;
};

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
}

function getMetrics(): Metrics {
  const positions = getPositions();
  const summary = getPositionSummary();
  const closedPositions = positions.filter((p) => p.status === "CLOSED");
  const openPositions = positions.filter((p) => p.status === "OPEN");

  const wins = closedPositions.filter((p) => {
    if (p.exitPrice == null || p.entryPrice == null || p.size == null) return false;
    const pnl = p.side === "LONG"
      ? (p.exitPrice - p.entryPrice) * p.size
      : (p.entryPrice - p.exitPrice) * p.size;
    return pnl > 0;
  }).length;

  const totalPnl = closedPositions.reduce((sum, p) => {
    if (p.exitPrice == null || p.entryPrice == null || p.size == null) return sum;
    const pnl = p.side === "LONG"
      ? (p.exitPrice - p.entryPrice) * p.size
      : (p.entryPrice - p.exitPrice) * p.size;
    return sum + pnl;
  }, 0);

  const unrealizedPnl = openPositions.reduce((sum, p) => {
    if (p.entryPrice == null || p.size == null || p.tsOpen == null) return sum;
    const heldSec = (Date.now() - p.tsOpen) / 1000;
    if (heldSec < 60) return sum;
    const latest = getPositions().find((pos) => pos.id === p.id);
    if (!latest || latest.exitPrice == null) return sum;
    const pnl = p.side === "LONG"
      ? (latest.exitPrice - p.entryPrice) * p.size
      : (p.entryPrice - latest.exitPrice) * p.size;
    return sum + pnl;
  }, 0);

  const avgPnl = closedPositions.length > 0 ? totalPnl / closedPositions.length : 0;

  const avgHoldTime = closedPositions
    .filter((p) => p.tsClose != null && p.tsOpen != null)
    .reduce((sum, p) => sum + (p.tsClose! - p.tsOpen!) / 1000, 0) / closedPositions.length || 0;

  const exitReasons: Record<string, number> = {};
  closedPositions.forEach((p) => {
    if (p.exitReason) {
      exitReasons[p.exitReason] = (exitReasons[p.exitReason] || 0) + 1;
    }
  });

  const instantExits = closedPositions.filter((p) => {
    if (p.tsClose == null || p.tsOpen == null) return false;
    return (p.tsClose - p.tsOpen) < 5000;
  }).length;

  const signalFlipExits = closedPositions.filter((p) => p.exitReason === "signal_flip").length;
  const stopLossExits = closedPositions.filter((p) => p.exitReason === "stop_loss").length;

  return {
    timestamp: new Date().toISOString(),
    totalPositions: positions.length,
    openPositions: openPositions.length,
    closedPositions: closedPositions.length,
    winRate: closedPositions.length > 0 ? wins / closedPositions.length : 0,
    totalPnl,
    avgPnl,
    avgHoldTime,
    exitReasons,
    instantExits,
    signalFlipExits,
    stopLossExits,
    unrealizedPnl
  };
}

function displayMetrics(current: Metrics, previous?: Metrics): void {
  console.log("\n" + "=".repeat(80));
  console.log(`PROFITABILITY MONITOR - ${new Date(current.timestamp).toLocaleString()}`);
  console.log("=".repeat(80) + "\n");

  console.log("📊 Position Summary:");
  console.log(`   Total: ${current.totalPositions} (${current.openPositions} open, ${current.closedPositions} closed)`);

  if (current.closedPositions > 0) {
    console.log("\n💰 PnL Metrics:");
    console.log(`   Win Rate: ${formatPercent(current.winRate)}${previous ? ` (${current.winRate > previous.winRate ? "↑" : current.winRate < previous.winRate ? "↓" : "→"} ${formatPercent(Math.abs(current.winRate - (previous.winRate || 0)))})` : ""}`);
    console.log(`   Total Realized PnL: ${formatCurrency(current.totalPnl)}${previous ? ` (${current.totalPnl > previous.totalPnl ? "↑" : current.totalPnl < previous.totalPnl ? "↓" : "→"} ${formatCurrency(Math.abs(current.totalPnl - previous.totalPnl))})` : ""}`);
    console.log(`   Average PnL per Position: ${formatCurrency(current.avgPnl)}${previous ? ` (${current.avgPnl > previous.avgPnl ? "↑" : current.avgPnl < previous.avgPnl ? "↓" : "→"} ${formatCurrency(Math.abs(current.avgPnl - previous.avgPnl))})` : ""}`);
    console.log(`   Average Hold Time: ${formatDuration(current.avgHoldTime)}${previous ? ` (${current.avgHoldTime > previous.avgHoldTime ? "↑" : current.avgHoldTime < previous.avgHoldTime ? "↓" : "→"} ${formatDuration(Math.abs(current.avgHoldTime - previous.avgHoldTime))})` : ""}`);

    console.log("\n🚪 Exit Analysis:");
    const totalExits = current.closedPositions;
    Object.entries(current.exitReasons).forEach(([reason, count]) => {
      const pct = (count / totalExits) * 100;
      const trend = previous ? ` (${count > (previous.exitReasons[reason] || 0) ? "↑" : count < (previous.exitReasons[reason] || 0) ? "↓" : "→"})` : "";
      console.log(`   ${reason}: ${count} (${formatPercent(pct)})${trend}`);
    });

    console.log("\n⚠️  Critical Issues:");
    const instantPct = (current.instantExits / totalExits) * 100;
    const flipPct = (current.signalFlipExits / totalExits) * 100;
    const stopPct = (current.stopLossExits / totalExits) * 100;
    console.log(`   Instant Exits (<5s): ${current.instantExits} (${formatPercent(instantPct)}) ${instantPct < 5 ? "✅" : instantPct < 10 ? "⚠️" : "❌"}`);
    console.log(`   Signal Flip Exits: ${current.signalFlipExits} (${formatPercent(flipPct)}) ${flipPct < 10 ? "✅" : flipPct < 20 ? "⚠️" : "❌"}`);
    console.log(`   Stop Loss Exits: ${current.stopLossExits} (${formatPercent(stopPct)}) ${stopPct < 20 ? "✅" : stopPct < 30 ? "⚠️" : "❌"}`);
  }

  if (current.openPositions > 0) {
    console.log(`\n📈 Unrealized PnL: ${formatCurrency(current.unrealizedPnl)} (${current.openPositions} open positions)`);
  }

  console.log("\n" + "=".repeat(80));
  
  if (current.closedPositions > 0) {
    const status = current.totalPnl > 0 
      ? "✅ PROFITABLE" 
      : current.winRate > 0.05 
        ? "⚠️  IMPROVING" 
        : "❌ NEEDS WORK";
    console.log(`Status: ${status} | Win Rate: ${formatPercent(current.winRate)} | Total PnL: ${formatCurrency(current.totalPnl)}`);
  }
}

async function main() {
  console.log("=".repeat(80));
  console.log("PROFITABILITY MONITOR - Continuous Analysis");
  console.log("=".repeat(80));
  console.log("\nMonitoring system profitability with optimized parameters...");
  console.log("Press Ctrl+C to stop\n");

  let previousMetrics: Metrics | undefined;
  let iteration = 0;
  const checkInterval = 60000; // 60 seconds

  while (true) {
    iteration++;
    
    try {
      const currentMetrics = getMetrics();
      displayMetrics(currentMetrics, previousMetrics);
      previousMetrics = currentMetrics;

      if (currentMetrics.closedPositions > 0) {
        const trend = previousMetrics 
          ? currentMetrics.winRate > previousMetrics.winRate 
            ? "IMPROVING" 
            : currentMetrics.winRate < previousMetrics.winRate 
              ? "DECLINING" 
              : "STABLE"
          : "INITIAL";
        console.log(`\nTrend: ${trend} (Iteration ${iteration})`);
      }

      console.log(`\n⏳ Next check in ${checkInterval / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    } catch (error) {
      console.error("\n❌ Error during analysis:", error);
      console.log("⏳ Retrying in 10 seconds...");
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

main().catch(console.error);
