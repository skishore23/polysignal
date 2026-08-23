export type ShadowFillSide = "BUY" | "SELL";

export type ShadowFillInput = {
  walletId: number;
  tokenId: string;
  side: ShadowFillSide;
  price: number;
  size: number;
  ts: number;
};

export type ShadowPositionState = {
  walletId: number;
  tokenId: string;
  position: number;
  avgEntry: number;
  realizedPnl: number;
  openTs: number | null;
  openedCycles: number;
  closedCycles: number;
  winCount: number;
  lossCount: number;
  totalHoldSec: number;
  lastClosedRealizedPnl: number;
  lastFillTs: number | null;
};

export type ShadowPositionMark = {
  unrealizedPnl: number;
  longExposure: number;
  shortExposure: number;
};

export const shadowPositionKey = (walletId: number, tokenId: string): string =>
  `${walletId}:${tokenId}`;

export const createShadowPositionState = (
  walletId: number,
  tokenId: string
): ShadowPositionState => ({
  walletId,
  tokenId,
  position: 0,
  avgEntry: 0,
  realizedPnl: 0,
  openTs: null,
  openedCycles: 0,
  closedCycles: 0,
  winCount: 0,
  lossCount: 0,
  totalHoldSec: 0,
  lastClosedRealizedPnl: 0,
  lastFillTs: null
});

const validFill = (fill: ShadowFillInput): boolean =>
  Number.isFinite(fill.price) &&
  Number.isFinite(fill.size) &&
  fill.price > 0 &&
  fill.size > 0 &&
  Number.isFinite(fill.ts);

/**
 * Applies one fill to a position state with deterministic cycle accounting.
 * A sign flip closes one cycle and immediately opens another.
 */
export const applyShadowFillToState = (
  current: ShadowPositionState,
  fill: ShadowFillInput
): ShadowPositionState => {
  if (!validFill(fill)) return current;

  const prevPos = current.position;
  const prevAvg = current.avgEntry;
  const prevRealized = current.realizedPnl;
  const delta = fill.side === "BUY" ? fill.size : -fill.size;
  const nextPos = prevPos + delta;
  const wasOpen = prevPos !== 0;
  const opensNow = prevPos === 0 && nextPos !== 0;
  const closesNow = wasOpen && nextPos === 0;
  const flips = wasOpen && nextPos !== 0 && Math.sign(prevPos) !== Math.sign(nextPos);

  let nextAvg = prevAvg;
  let nextRealized = prevRealized;
  if (prevPos === 0) {
    nextAvg = fill.price;
  } else {
    const sameDirection = (prevPos > 0 && delta > 0) || (prevPos < 0 && delta < 0);
    if (sameDirection) {
      const totalAbs = Math.abs(prevPos) + Math.abs(delta);
      nextAvg = totalAbs > 0
        ? (Math.abs(prevPos) * prevAvg + Math.abs(delta) * fill.price) / totalAbs
        : fill.price;
    } else {
      const closingSize = Math.min(Math.abs(prevPos), Math.abs(delta));
      const pnlPerUnit = prevPos > 0 ? fill.price - prevAvg : prevAvg - fill.price;
      nextRealized = prevRealized + pnlPerUnit * closingSize;
      nextAvg = nextPos === 0 ? 0 : fill.price;
    }
  }

  let openTs = current.openTs;
  let openedCycles = current.openedCycles;
  let closedCycles = current.closedCycles;
  let winCount = current.winCount;
  let lossCount = current.lossCount;
  let totalHoldSec = current.totalHoldSec;
  let lastClosedRealizedPnl = current.lastClosedRealizedPnl;

  if (opensNow) {
    openedCycles += 1;
    openTs = fill.ts;
  }

  if (closesNow || flips) {
    const cyclePnl = nextRealized - lastClosedRealizedPnl;
    if (cyclePnl > 0) winCount += 1;
    if (cyclePnl < 0) lossCount += 1;
    closedCycles += 1;
    if (openTs != null) {
      totalHoldSec += Math.max(0, (fill.ts - openTs) / 1000);
    }
    lastClosedRealizedPnl = nextRealized;
    if (flips) {
      openedCycles += 1;
      openTs = fill.ts;
    } else {
      openTs = null;
    }
  }

  return {
    ...current,
    position: nextPos,
    avgEntry: nextAvg,
    realizedPnl: nextRealized,
    openTs,
    openedCycles,
    closedCycles,
    winCount,
    lossCount,
    totalHoldSec,
    lastClosedRealizedPnl,
    lastFillTs: current.lastFillTs == null ? fill.ts : Math.max(current.lastFillTs, fill.ts)
  };
};

export const buildShadowPositionLedger = (
  fills: ShadowFillInput[]
): Map<string, ShadowPositionState> => {
  const sorted = [...fills].sort((a, b) => a.ts - b.ts);
  const out = new Map<string, ShadowPositionState>();
  for (const fill of sorted) {
    if (!validFill(fill)) continue;
    const key = shadowPositionKey(fill.walletId, fill.tokenId);
    const current = out.get(key) ?? createShadowPositionState(fill.walletId, fill.tokenId);
    out.set(key, applyShadowFillToState(current, fill));
  }
  return out;
};

export const computeShadowPositionUnrealizedPnl = (
  state: Pick<ShadowPositionState, "position" | "avgEntry">,
  mark: number
): number => {
  if (!Number.isFinite(mark) || mark <= 0 || state.position === 0) return 0;
  return state.position > 0
    ? (mark - state.avgEntry) * state.position
    : (state.avgEntry - mark) * Math.abs(state.position);
};

export const markShadowPosition = (
  state: Pick<ShadowPositionState, "position" | "avgEntry">,
  mark: number
): ShadowPositionMark => {
  const safeMark = Number.isFinite(mark) && mark > 0 ? mark : 0;
  const unrealizedPnl = computeShadowPositionUnrealizedPnl(state, safeMark);
  const longExposure = state.position > 0 && safeMark > 0 ? state.position * safeMark : 0;
  const shortExposure = state.position < 0 && safeMark > 0 ? Math.abs(state.position) * safeMark : 0;
  return { unrealizedPnl, longExposure, shortExposure };
};
