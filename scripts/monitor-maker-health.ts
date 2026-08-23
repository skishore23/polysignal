#!/usr/bin/env tsx

import { getMakerPnLSnapshot, getMakerSnapshotHealth, getMakerWalletSummary } from "../apps/web/lib/queries.js";

const SSE_URL =
  process.env.MAKER_SSE_URL ??
  "http://localhost:3000/api/stream/maker-pnl?limit=25&pnl=25&fills=0&quotes=0";
const DATABASE_CHECK_INTERVAL_MS = Number(process.env.MAKER_HEALTH_CHECK_INTERVAL_MS ?? "3000");
const HEALTH_STALE_MS = Number(process.env.MAKER_HEALTH_STALE_MS ?? "7000");
const SSE_RECONNECT_DELAY_MS = Number(process.env.MAKER_HEALTH_SSE_RECONNECT_MS ?? "3000");

let healthStaleCounter = 0;
let pnlStaleCounter = 0;
let lastDbPnlTs: number | null = null;
let totalDataEvents = 0;
let consecutiveSseStale = 0;
let shouldStop = false;

type SseEvent = {
  event?: string;
  data?: string;
};

function formatTs(ts: number | null): string {
  if (ts == null) return "n/a";
  const date = new Date(ts);
  return `${date.toISOString()} (${Math.round((Date.now() - ts) / 1000)}s ago)`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeHealth(health: ReturnType<typeof getMakerSnapshotHealth>): {
  message: string;
  stale: boolean;
} {
  if (!health?.lastTick) {
    return {
      message: "no health row",
      stale: true
    };
  }

  const delta = Date.now() - health.lastTick;
  const stale = delta > HEALTH_STALE_MS;
  return {
    message: `${formatTs(health.lastTick)} (${delta}ms delta)`,
    stale
  };
}

function checkDatabase(): void {
  const health = getMakerSnapshotHealth();
  const healthStatus = describeHealth(health);
  if (healthStatus.stale) {
    healthStaleCounter++;
  } else if (healthStaleCounter > 0) {
    console.info(`[monitor/db] health recovered after ${healthStaleCounter} cycles`);
    healthStaleCounter = 0;
  }

  const pnlRows = getMakerPnLSnapshot(10);
  const maxTs = pnlRows.reduce((prev, row) => Math.max(prev, row.ts), 0);
  if (maxTs === lastDbPnlTs) {
    pnlStaleCounter++;
  } else {
    pnlStaleCounter = 0;
    lastDbPnlTs = maxTs;
  }

  if (pnlStaleCounter >= 3) {
    console.error(`[monitor/db] PnL snapshot stale for ${pnlStaleCounter} cycles`);
  }

  const walletSummary = getMakerWalletSummary(5);
  const aggregated = walletSummary.reduce(
    (acc, wallet) => {
      acc.realized += wallet.realized;
      acc.unrealized += wallet.unrealized;
      acc.total += wallet.total;
      acc.roi.push(wallet.roi);
      return acc;
    },
    { realized: 0, unrealized: 0, total: 0, roi: [] as number[] }
  );

  const [minRoi, maxRoi] = aggregated.roi.length
    ? [Math.min(...aggregated.roi), Math.max(...aggregated.roi)]
    : [0, 0];

  console.info(
    `[monitor/db] health=${healthStatus.message} stale=${healthStatus.stale} | PnL rows=${pnlRows.length} latest=${formatTs(maxTs)} | wallets=${walletSummary.length} ROI=[${formatPct(minRoi)}, ${formatPct(maxRoi)}] | realized=${formatCurrency(
      aggregated.realized
    )} unrealized=${formatCurrency(aggregated.unrealized)} total=${formatCurrency(aggregated.total)}`
  );
}

function parseSseEvent(block: string): SseEvent {
  const event: SseEvent = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trimStart();
    if (field === "event") {
      event.event = value || "message";
    } else if (field === "data") {
      event.data = event.data ? `${event.data}\n${value}` : value;
    }
  }
  return event;
}

function processSseChunk(buffer: string, chunkText: string, handler: (event: SseEvent) => void): string {
  buffer += chunkText;
  let boundary = buffer.indexOf("\n\n");
  while (boundary >= 0) {
    const block = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    handler(parseSseEvent(block));
    boundary = buffer.indexOf("\n\n");
  }
  return buffer;
}

function handleSseEvent(event: SseEvent): void {
  const now = Date.now();
  if (event.event === "ping") {
    if (lastDbPnlTs != null && now - lastDbPnlTs > HEALTH_STALE_MS) {
      console.warn("[monitor/sse] ping received while DB last tick is stale");
    }
    return;
  }

  if (!event.data) return;
  totalDataEvents++;
  let payload: { health?: { lastTick: number | null; stale: boolean }; pnl?: Array<{ ts: number }> };
  try {
    payload = JSON.parse(event.data);
  } catch (err) {
    console.error("[monitor/sse] failed to parse SSE payload", err);
    return;
  }

  const health = payload.health;
  const stale = health?.stale ?? false;
  const healthMsg = health ? formatTs(health.lastTick ?? null) : "none";
  const pnlRows = payload.pnl ?? [];
  const maxPnlTs = pnlRows.reduce((prev, row) => Math.max(prev, row.ts ?? 0), 0);

  if (stale) {
    consecutiveSseStale++;
    console.warn(
      `[monitor/sse] data#${totalDataEvents} stale=${stale} health=${healthMsg} | pnlRows=${pnlRows.length} latest=${formatTs(maxPnlTs)}`
    );
  } else {
    if (consecutiveSseStale > 0) {
      console.info(`[monitor/sse] cleared stale after ${consecutiveSseStale} events`);
    }
    consecutiveSseStale = 0;
    console.info(
      `[monitor/sse] data#${totalDataEvents} health=${healthMsg} | pnlRows=${pnlRows.length} latest=${formatTs(maxPnlTs)}`
    );
  }
}

async function monitorDatabase(): Promise<void> {
  console.log(`[monitor] Starting database checks every ${DATABASE_CHECK_INTERVAL_MS}ms (stale threshold ${HEALTH_STALE_MS}ms)`);
  while (!shouldStop) {
    try {
      checkDatabase();
    } catch (err) {
      console.error("[monitor/db] failed to evaluate health", err);
    }
    await sleep(DATABASE_CHECK_INTERVAL_MS);
  }
}

async function monitorSse(): Promise<void> {
  console.log(`[monitor] Connecting to SSE stream at ${SSE_URL}`);
  while (!shouldStop) {
    try {
      const controller = new AbortController();
      const response = await fetch(SSE_URL, {
        headers: {
          Accept: "text/event-stream"
        },
        signal: controller.signal
      });

      if (!response.body) {
        throw new Error("SSE response missing body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!shouldStop) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = processSseChunk(buffer, decoder.decode(value, { stream: true }), handleSseEvent);
      }

      controller.abort();
      console.warn("[monitor/sse] Stream closed unexpectedly");
    } catch (err) {
      console.error("[monitor/sse] stream error:", err);
    }

    if (!shouldStop) {
      console.log(`[monitor/sse] reconnecting in ${SSE_RECONNECT_DELAY_MS}ms`);
      await sleep(SSE_RECONNECT_DELAY_MS);
    }
  }
}

function gracefulExit(): void {
  shouldStop = true;
  console.log("[monitor] shutting down");
}

process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);

(async () => {
  await Promise.allSettled([monitorDatabase(), monitorSse()]);
  console.log("[monitor] exited");
})();
