import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  applyShadowFillToState,
  computeShadowPositionUnrealizedPnl,
  createShadowPositionState
} from "../../packages/data/src/shadowPositionLedger";
import { decideTakerSideEdges } from "../../apps/worker/src/trading/DecisionEngine";
import { computeLiquidityOrderScore, computeTakerFee } from "../../apps/worker/src/trading/PolymarketFeeMath";

type OracleCase = Record<string, string>;
type OracleResult = Record<string, string>;

let seed = 0x5eed2026;
const random = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const decimal = (min: number, max: number, places: number): string =>
  (Math.round((min + random() * (max - min)) * 10 ** places) / 10 ** places).toFixed(places);

const near = (actual: number, reference: string): void => {
  const expected = Number(reference);
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 + 1e-10 * Math.abs(expected));
};

describe("independent Decimal differential gate", () => {
  it("compares 1,000 deterministic cases per fee, trade, score and inventory family", () => {
    const cases: OracleCase[] = [];
    for (let i = 0; i < 1000; i += 1) {
      cases.push({
        kind: "fee",
        shares: decimal(0.001, 500, 3),
        rate: decimal(0, 0.1, 4),
        price: decimal(0.01, 0.99, 3)
      });
      cases.push({
        kind: "trade",
        side: i % 2 ? "SELL" : "BUY",
        shares: decimal(1, 200, 2),
        value: decimal(0, 1, 3),
        price: decimal(0.1, 0.9, 3),
        mid: "0.500",
        cash_fee: "0"
      });
      cases.push({
        kind: "score",
        spread_cents: decimal(1, 10, 2),
        distance_cents: decimal(0, 0.9, 2),
        shares: decimal(1, 200, 2),
        multiplier: decimal(0.1, 3, 2)
      });
      const entrySize = Number(decimal(1, 200, 2));
      cases.push({
        kind: "position",
        entry_size: entrySize.toFixed(2),
        close_size: decimal(0.01, entrySize, 2),
        entry_price: decimal(0.01, 0.99, 3),
        exit_price: decimal(0.01, 0.99, 3),
        mark: decimal(0, 1, 3)
      });
    }

    const oracle = spawnSync("python3", ["scripts/math_oracle.py"], {
      cwd: process.cwd(),
      input: JSON.stringify(cases),
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    const results = JSON.parse(oracle.stdout) as OracleResult[];
    expect(results).toHaveLength(cases.length);

    cases.forEach((item, index) => {
      const expected = results[index];
      if (!expected) throw new Error(`missing oracle output for case ${index}`);
      if (item.kind === "fee") {
        const fee = computeTakerFee({
          marketProfile: "CRYPTO_15M",
          shares: Number(item.shares),
          price: Number(item.price),
          side: "SELL",
          feeRateBps: Number(item.rate) * 10_000
        });
        near(fee.feeUsdc, expected.fee ?? "NaN");
      } else if (item.kind === "trade") {
        const side = item.side as "BUY" | "SELL";
        const quote = Number(item.price);
        const bidPx = side === "SELL" ? quote : Math.min(quote, 0.1);
        const askPx = side === "BUY" ? quote : Math.max(quote, 0.9);
        const edge = decideTakerSideEdges({
          pHat: Number(item.value),
          midPx: Number(item.mid),
          bidPx,
          askPx,
          spreadPx: askPx - bidPx,
          sizeShares: Number(item.shares),
          marketProfile: "FEE_FREE",
          feeRateBps: 0,
          minNetEdgeBps: -100_000,
          slippageBps: 0,
          adverseSelectionBps: 0,
          queueLossBps: 0,
          inventoryPenaltyBps: 0
        }).find((decision) => decision.side === side);
        near(edge?.netEdgeBps ?? NaN, expected.bps ?? "NaN");
      } else if (item.kind === "score") {
        const score = computeLiquidityOrderScore({
          midpointPrice: 0.5,
          orderPrice: 0.5 - Number(item.distance_cents) / 100,
          maxSpreadCents: Number(item.spread_cents),
          sizeShares: Number(item.shares),
          multiplier: Number(item.multiplier)
        });
        near(score, expected.score ?? "NaN");
      } else if (item.kind === "position") {
        const bought = applyShadowFillToState(createShadowPositionState(1, "YES"), {
          walletId: 1,
          tokenId: "YES",
          side: "BUY",
          price: Number(item.entry_price),
          size: Number(item.entry_size),
          ts: 1
        });
        const closed = applyShadowFillToState(bought, {
          walletId: 1,
          tokenId: "YES",
          side: "SELL",
          price: Number(item.exit_price),
          size: Number(item.close_size),
          ts: 2
        });
        near(closed.position, expected.remaining ?? "NaN");
        near(closed.avgEntry, expected.basis ?? "NaN");
        near(closed.realizedPnl, expected.realized ?? "NaN");
        near(computeShadowPositionUnrealizedPnl(closed, Number(item.mark)) ?? NaN, expected.unrealized ?? "NaN");
      }
    });
  });
});
