import { describe, it, expect } from "vitest";
import {
  computeQuantileEdges,
  binValue,
  encodeState,
  decodeState,
  lookupStateAt,
  buildTransitionCounts
} from "../../packages/data/src/markovRegime";

describe("Markov regime utilities", () => {
  it("computes quantile edges deterministically", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const edges = computeQuantileEdges(values, 3);
    expect(edges).toEqual([3, 6]);
  });

  it("bins values using edges (<= goes lower)", () => {
    const edges = [3, 6];
    expect(binValue(2, edges)).toBe(0);
    expect(binValue(3, edges)).toBe(0);
    expect(binValue(4, edges)).toBe(1);
    expect(binValue(6, edges)).toBe(1);
    expect(binValue(7, edges)).toBe(2);
  });

  it("encodes and decodes state ids", () => {
    const bins = [0, 2, 1];
    const state = encodeState(bins, 3);
    expect(state).toBe(7);
    expect(decodeState(state, 3, 3)).toEqual(bins);
  });

  it("builds transition counts", () => {
    const transitions = buildTransitionCounts([0, 1, 1, 2]);
    expect(transitions.get(0)?.get(1)).toBe(1);
    expect(transitions.get(1)?.get(1)).toBe(1);
    expect(transitions.get(1)?.get(2)).toBe(1);
  });

  it("looks up state by timestamp", () => {
    const timeline = [
      { ts: 10, state: 1 },
      { ts: 20, state: 2 }
    ];
    expect(lookupStateAt(timeline, 5)).toBeNull();
    expect(lookupStateAt(timeline, 10)).toBe(1);
    expect(lookupStateAt(timeline, 15)).toBe(1);
    expect(lookupStateAt(timeline, 20)).toBe(2);
    expect(lookupStateAt(timeline, 30)).toBe(2);
  });
});
