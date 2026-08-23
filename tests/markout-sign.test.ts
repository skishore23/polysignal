/**
 * Markout sign convention sanity test.
 * Locks in: BUY midH>midF => positive; SELL midH<midF => positive.
 * Run before big data checks to catch sign bugs in 30 seconds.
 */
import { it, expect } from "vitest";

function computeMarkoutBps(side: "BUY" | "SELL", midAtFill: number, midAtHorizon: number): number {
  const pnl =
    side === "BUY"
      ? (midAtHorizon - midAtFill) / midAtFill
      : (midAtFill - midAtHorizon) / midAtFill;
  return pnl * 10_000;
}

it("BUY: midH > midF => markout_bps > 0", () => {
  const midF = 0.5;
  const midH = 0.52;
  const bps = computeMarkoutBps("BUY", midF, midH);
  expect(bps).toBeGreaterThan(0);
});

it("BUY: midH < midF => markout_bps < 0", () => {
  const midF = 0.5;
  const midH = 0.48;
  const bps = computeMarkoutBps("BUY", midF, midH);
  expect(bps).toBeLessThan(0);
});

it("SELL: midH < midF => markout_bps > 0", () => {
  const midF = 0.5;
  const midH = 0.48;
  const bps = computeMarkoutBps("SELL", midF, midH);
  expect(bps).toBeGreaterThan(0);
});

it("SELL: midH > midF => markout_bps < 0", () => {
  const midF = 0.5;
  const midH = 0.52;
  const bps = computeMarkoutBps("SELL", midF, midH);
  expect(bps).toBeLessThan(0);
});
