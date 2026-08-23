export type Side = "BUY" | "SELL";

export type BootstrapResult = {
  n: number;
  mean: number;
  ciLo: number;
  ciHi: number;
};

export type CycleInputRow = {
  fillId: number;
  ts: number;
  walletId: number | null;
  tokenId: string;
  side: Side;
  price: number | null;
  size: number | null;
  netEdgeBps?: number | null;
  spreadBps?: number | null;
};

export type ReconstructedCycle = {
  cycleId: string;
  walletId: number | null;
  tokenId: string;
  direction: "LONG" | "SHORT";
  openFillId: number;
  closeFillId: number;
  openTs: number;
  closeTs: number;
  holdMs: number;
  fillsInCycle: number;
  entryAvgPx: number;
  exitPx: number;
  entryNotional: number;
  closedNotional: number;
  realizedPnl: number;
  realizedPnlBps: number | null;
  entryNetEdgeBps: number | null;
  entrySpreadBps: number | null;
  closeSpreadBps: number | null;
};

export type CycleAnomaly = {
  groupKey: string;
  fillId: number;
  ts: number;
  code: "invalid_side" | "invalid_price_or_size" | "time_inversion";
  detail: string;
};

export type CycleReconstructionResult = {
  cycles: ReconstructedCycle[];
  openStates: Array<{
    walletId: number | null;
    tokenId: string;
    position: number;
    avgEntry: number;
    openTs: number;
    openFillId: number;
    realizedSinceOpen: number;
    closedNotional: number;
    fillsInCycle: number;
    entryNetEdgeBps: number | null;
    entrySpreadBps: number | null;
  }>;
  anomalies: CycleAnomaly[];
};

export function toBps(value: number): number {
  return value * 10_000;
}

export function fromBps(bps: number): number {
  return bps / 10_000;
}

export function computeMarkoutBps(side: Side, midAtFill: number, midAtHorizon: number): number {
  const pnl =
    side === "BUY"
      ? (midAtHorizon - midAtFill) / midAtFill
      : (midAtFill - midAtHorizon) / midAtFill;
  return toBps(pnl);
}

export function computeSpreadBpsFromBidAsk(bidPx: number, askPx: number, midPx: number): number {
  if (!Number.isFinite(bidPx) || !Number.isFinite(askPx) || !Number.isFinite(midPx) || midPx <= 0) {
    return NaN;
  }
  return toBps((askPx - bidPx) / midPx);
}

export function computeSpreadBpsFromSpreadPx(spreadPx: number, midPx: number): number {
  if (!Number.isFinite(spreadPx) || !Number.isFinite(midPx) || midPx <= 0) {
    return NaN;
  }
  return toBps(spreadPx / midPx);
}

export function bucketSpreadBps(spreadBps: number | null | undefined): string {
  if (spreadBps == null || !Number.isFinite(spreadBps) || spreadBps < 0) return "unknown";
  if (spreadBps <= 10) return "0-10";
  if (spreadBps <= 25) return "10-25";
  if (spreadBps <= 50) return "25-50";
  if (spreadBps <= 100) return "50-100";
  if (spreadBps <= 200) return "100-200";
  return "200+";
}

export function bucketNetEdgeBps(netEdgeBps: number | null | undefined): string {
  if (netEdgeBps == null || !Number.isFinite(netEdgeBps)) return "unknown";
  if (netEdgeBps <= 0) return "<=0";
  if (netEdgeBps <= 25) return "0-25";
  if (netEdgeBps <= 50) return "25-50";
  if (netEdgeBps <= 100) return "50-100";
  if (netEdgeBps <= 200) return "100-200";
  return "200+";
}

function seededRng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const clamped = Math.max(0, Math.min(1, p));
  const i = clamped * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo] ?? NaN;
  const loVal = sorted[lo] ?? NaN;
  const hiVal = sorted[hi] ?? NaN;
  return loVal + (i - lo) * (hiVal - loVal);
}

export function mean(values: number[]): number {
  if (!values.length) return NaN;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export function pearsonCorrelation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  if (!Number.isFinite(mx) || !Number.isFinite(my)) return NaN;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];
    const y = ys[i];
    const dx = x - mx;
    const dy = y - my;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  if (!Number.isFinite(den) || den === 0) return NaN;
  return num / den;
}

export function bootstrapMeanCi(
  values: number[],
  options: { iterations?: number; alpha?: number; seed?: number } = {}
): BootstrapResult {
  const cleaned = values.filter((value) => Number.isFinite(value));
  const n = cleaned.length;
  if (n === 0) {
    return { n: 0, mean: NaN, ciLo: NaN, ciHi: NaN };
  }
  if (n === 1) {
    const only = cleaned[0] ?? NaN;
    return { n, mean: only, ciLo: only, ciHi: only };
  }

  const iterations = Math.max(100, Math.floor(options.iterations ?? 1000));
  const alpha = Math.min(0.5, Math.max(0.001, options.alpha ?? 0.05));
  const rng = seededRng(options.seed ?? 1_337);

  const means: number[] = [];
  means.length = iterations;
  for (let b = 0; b < iterations; b += 1) {
    let sampleSum = 0;
    for (let i = 0; i < n; i += 1) {
      const j = Math.floor(rng() * n);
      sampleSum += cleaned[j] ?? 0;
    }
    means[b] = sampleSum / n;
  }
  means.sort((a, b) => a - b);

  const ciLo = percentile(means, alpha / 2);
  const ciHi = percentile(means, 1 - alpha / 2);
  return {
    n,
    mean: mean(cleaned),
    ciLo,
    ciHi
  };
}

export function bootstrapFillLevelCi(
  fillValues: Array<{ value: number | null | undefined }>,
  options: { iterations?: number; alpha?: number; seed?: number } = {}
): BootstrapResult {
  const values = fillValues
    .map((row) => row.value)
    .filter((value): value is number => value != null && Number.isFinite(value));
  return bootstrapMeanCi(values, options);
}

export function bootstrapCycleLevelCi(
  cycles: ReconstructedCycle[],
  valueSelector: (cycle: ReconstructedCycle) => number | null | undefined,
  options: { iterations?: number; alpha?: number; seed?: number } = {}
): BootstrapResult {
  const values = cycles
    .map(valueSelector)
    .filter((value): value is number => value != null && Number.isFinite(value));
  return bootstrapMeanCi(values, options);
}

export function reconstructCycles(fills: CycleInputRow[]): CycleReconstructionResult {
  const rows = [...fills].sort((a, b) => {
    if (a.walletId !== b.walletId) return (a.walletId ?? -1) - (b.walletId ?? -1);
    if (a.tokenId !== b.tokenId) return a.tokenId.localeCompare(b.tokenId);
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.fillId - b.fillId;
  });

  type MutableState = {
    walletId: number | null;
    tokenId: string;
    position: number;
    avgEntry: number;
    openTs: number;
    openFillId: number;
    fillsInCycle: number;
    realizedSinceOpen: number;
    closedNotional: number;
    entryNetEdgeBps: number | null;
    entrySpreadBps: number | null;
    direction: "LONG" | "SHORT";
    lastTs: number;
  };

  const states = new Map<string, MutableState>();
  const cycles: ReconstructedCycle[] = [];
  const anomalies: CycleAnomaly[] = [];
  let cycleCounter = 0;

  const closeCycle = (
    state: MutableState,
    closeFill: CycleInputRow,
    exitPx: number,
    closeSpreadBps: number | null
  ): void => {
    cycleCounter += 1;
    const holdMs = Math.max(0, closeFill.ts - state.openTs);
    const realizedPnlBps =
      state.closedNotional > 0 ? toBps(state.realizedSinceOpen / state.closedNotional) : null;
    cycles.push({
      cycleId: `${state.walletId ?? -1}:${state.tokenId}:${cycleCounter}`,
      walletId: state.walletId,
      tokenId: state.tokenId,
      direction: state.direction,
      openFillId: state.openFillId,
      closeFillId: closeFill.fillId,
      openTs: state.openTs,
      closeTs: closeFill.ts,
      holdMs,
      fillsInCycle: state.fillsInCycle,
      entryAvgPx: state.avgEntry,
      exitPx,
      entryNotional: Math.abs(state.position) * state.avgEntry,
      closedNotional: state.closedNotional,
      realizedPnl: state.realizedSinceOpen,
      realizedPnlBps,
      entryNetEdgeBps: state.entryNetEdgeBps,
      entrySpreadBps: state.entrySpreadBps,
      closeSpreadBps
    });
  };

  for (const fill of rows) {
    const groupKey = `${fill.walletId ?? -1}:${fill.tokenId}`;
    const side = fill.side;
    const price = fill.price ?? NaN;
    const size = fill.size ?? NaN;

    if (side !== "BUY" && side !== "SELL") {
      anomalies.push({
        groupKey,
        fillId: fill.fillId,
        ts: fill.ts,
        code: "invalid_side",
        detail: `Unexpected side=${String(side)}`
      });
      continue;
    }
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
      anomalies.push({
        groupKey,
        fillId: fill.fillId,
        ts: fill.ts,
        code: "invalid_price_or_size",
        detail: `Invalid fill price=${String(fill.price)} size=${String(fill.size)}`
      });
      continue;
    }

    const delta = side === "BUY" ? size : -size;
    const existing = states.get(groupKey);
    if (!existing) {
      states.set(groupKey, {
        walletId: fill.walletId,
        tokenId: fill.tokenId,
        position: delta,
        avgEntry: price,
        openTs: fill.ts,
        openFillId: fill.fillId,
        fillsInCycle: 1,
        realizedSinceOpen: 0,
        closedNotional: 0,
        entryNetEdgeBps: fill.netEdgeBps ?? null,
        entrySpreadBps: fill.spreadBps ?? null,
        direction: delta >= 0 ? "LONG" : "SHORT",
        lastTs: fill.ts
      });
      continue;
    }

    const state = existing;
    if (fill.ts < state.lastTs) {
      anomalies.push({
        groupKey,
        fillId: fill.fillId,
        ts: fill.ts,
        code: "time_inversion",
        detail: `fill.ts=${fill.ts} < prev.ts=${state.lastTs}`
      });
    }
    state.lastTs = fill.ts;
    state.fillsInCycle += 1;

    const nextPos = state.position + delta;
    const sameDirection =
      (state.position > 0 && delta > 0) ||
      (state.position < 0 && delta < 0);

    if (sameDirection) {
      const totalAbs = Math.abs(state.position) + Math.abs(delta);
      if (totalAbs > 0) {
        state.avgEntry =
          (Math.abs(state.position) * state.avgEntry + Math.abs(delta) * price) / totalAbs;
      }
      state.position = nextPos;
      continue;
    }

    const closingQty = Math.min(Math.abs(state.position), Math.abs(delta));
    const pnlPerUnit =
      state.position > 0 ? price - state.avgEntry : state.avgEntry - price;
    state.realizedSinceOpen += pnlPerUnit * closingQty;
    state.closedNotional += closingQty * state.avgEntry;

    if (nextPos === 0) {
      closeCycle(state, fill, price, fill.spreadBps ?? null);
      states.delete(groupKey);
      continue;
    }

    const flipped = Math.sign(nextPos) !== Math.sign(state.position);
    if (flipped) {
      closeCycle(state, fill, price, fill.spreadBps ?? null);
      states.set(groupKey, {
        walletId: fill.walletId,
        tokenId: fill.tokenId,
        position: nextPos,
        avgEntry: price,
        openTs: fill.ts,
        openFillId: fill.fillId,
        fillsInCycle: 1,
        realizedSinceOpen: 0,
        closedNotional: 0,
        entryNetEdgeBps: fill.netEdgeBps ?? null,
        entrySpreadBps: fill.spreadBps ?? null,
        direction: nextPos >= 0 ? "LONG" : "SHORT",
        lastTs: fill.ts
      });
      continue;
    }

    state.position = nextPos;
  }

  const openStates = Array.from(states.values()).map((state) => ({
    walletId: state.walletId,
    tokenId: state.tokenId,
    position: state.position,
    avgEntry: state.avgEntry,
    openTs: state.openTs,
    openFillId: state.openFillId,
    realizedSinceOpen: state.realizedSinceOpen,
    closedNotional: state.closedNotional,
    fillsInCycle: state.fillsInCycle,
    entryNetEdgeBps: state.entryNetEdgeBps,
    entrySpreadBps: state.entrySpreadBps
  }));

  return { cycles, openStates, anomalies };
}

