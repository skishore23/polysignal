import type { CostBreakdown } from "@polysignal/types";

export const EDGE_SANITY_LIMITS = {
  maxAbsPredEdgeBps: 20_000,
  maxAbsNetEdgeBps: 20_000,
  maxTotalCostBps: 5_000,
  minTotalCostBps: -1_000,
  maxCostComponentBps: 5_000
} as const;

type EdgeSanityInput = {
  predEdgeBps: number;
  netEdgeBps: number;
  cost: CostBreakdown;
};

type EdgeSanityResult = {
  ok: boolean;
  reason: string;
};

const finite = (value: number): boolean => Number.isFinite(value);

const finiteNonNegative = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;

export const validateEdgeCostSanity = (input: EdgeSanityInput): EdgeSanityResult => {
  if (!finite(input.predEdgeBps)) return { ok: false, reason: "pred_edge_not_finite" };
  if (!finite(input.netEdgeBps)) return { ok: false, reason: "net_edge_not_finite" };
  if (!finite(input.cost.totalCostBps)) return { ok: false, reason: "total_cost_not_finite" };

  if (Math.abs(input.predEdgeBps) > EDGE_SANITY_LIMITS.maxAbsPredEdgeBps) {
    return { ok: false, reason: "pred_edge_out_of_range" };
  }
  if (Math.abs(input.netEdgeBps) > EDGE_SANITY_LIMITS.maxAbsNetEdgeBps) {
    return { ok: false, reason: "net_edge_out_of_range" };
  }
  if (input.cost.totalCostBps > EDGE_SANITY_LIMITS.maxTotalCostBps) {
    return { ok: false, reason: "total_cost_too_high" };
  }
  if (input.cost.totalCostBps < EDGE_SANITY_LIMITS.minTotalCostBps) {
    return { ok: false, reason: "total_cost_too_low" };
  }

  if (!finiteNonNegative(input.cost.spreadBps)) return { ok: false, reason: "spread_cost_invalid" };
  if (!finiteNonNegative(input.cost.feeBps)) return { ok: false, reason: "fee_cost_invalid" };
  if (!finiteNonNegative(input.cost.slippageBps)) return { ok: false, reason: "slippage_cost_invalid" };
  if (!finiteNonNegative(input.cost.adverseSelectionBps)) {
    return { ok: false, reason: "adverse_cost_invalid" };
  }
  if (!finiteNonNegative(input.cost.queueLossBps)) return { ok: false, reason: "queue_cost_invalid" };
  if (!finiteNonNegative(input.cost.inventoryPenaltyBps)) {
    return { ok: false, reason: "inventory_cost_invalid" };
  }

  const components = [
    input.cost.spreadBps,
    input.cost.feeBps,
    input.cost.slippageBps,
    input.cost.adverseSelectionBps,
    input.cost.queueLossBps,
    input.cost.inventoryPenaltyBps
  ];
  if (components.some((value) => value > EDGE_SANITY_LIMITS.maxCostComponentBps)) {
    return { ok: false, reason: "cost_component_out_of_range" };
  }

  return { ok: true, reason: "ok" };
};
