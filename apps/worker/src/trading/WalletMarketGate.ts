import { parseWalletMarketFilterJson } from "@polysignal/utils";

export type WalletMarketKind = "TAKER_BUY" | "TAKER_SELL" | "MAKER_BID" | "MAKER_ASK";

export type WalletTakerSide = "BUY" | "SELL" | "BOTH" | "NONE";

type WalletMarketFilterV1 = {
  version: 1;
  includeMarketIds?: string[];
  excludeMarketIds?: string[];
  minVolumeUsd?: number;
  maxVolumeUsd?: number;
  minLiquidityUsd?: number;
  maxLiquidityUsd?: number;
  requireActive?: boolean;
  allowedKinds?: WalletMarketKind[];
};

export type CompiledWalletMarketGate = {
  filter: WalletMarketFilterV1 | null;
  invalidReason: string | null;
};

export type MarketGateInput = {
  marketId: string | null;
  marketVolumeUsd: number | null;
  marketLiquidityUsd: number | null;
  marketActive: boolean | null;
  kind: WalletMarketKind;
};

type GateDecision = {
  ok: boolean;
  reason: string;
};

const PASS: GateDecision = { ok: true, reason: "ok" };

const isFiniteNumber = (value: number | null | undefined): value is number =>
  Number.isFinite(value as number);

export const normalizeWalletTakerSide = (raw: string | null | undefined): WalletTakerSide => {
  if (!raw) return "BOTH";
  const normalized = raw.trim().toUpperCase();
  if (normalized === "BUY" || normalized === "SELL" || normalized === "BOTH" || normalized === "NONE") {
    return normalized;
  }
  return "BOTH";
};

export const compileWalletMarketGate = (input: {
  marketFilterJson: string | null | undefined;
}): CompiledWalletMarketGate => {
  const parsed = parseWalletMarketFilterJson(input.marketFilterJson ?? null);
  if (!parsed.ok) {
    return {
      filter: null,
      invalidReason: "wallet_filter_invalid"
    };
  }
  return {
    filter: (parsed.value ?? null) as WalletMarketFilterV1 | null,
    invalidReason: null
  };
};

export const evaluateWalletMarketGate = (
  gate: CompiledWalletMarketGate,
  input: MarketGateInput
): GateDecision => {
  if (gate.invalidReason) return { ok: false, reason: gate.invalidReason };
  if (!input.marketId) return { ok: false, reason: "market_id_missing" };

  const filter = gate.filter;
  if (!filter) return PASS;

  if (filter.excludeMarketIds?.includes(input.marketId)) {
    return { ok: false, reason: "market_explicitly_excluded" };
  }

  if (filter.includeMarketIds && !filter.includeMarketIds.includes(input.marketId)) {
    return { ok: false, reason: "market_not_included" };
  }

  if (filter.allowedKinds && !filter.allowedKinds.includes(input.kind)) {
    return { ok: false, reason: "market_kind_not_allowed" };
  }

  if (filter.requireActive === true && input.marketActive !== true) {
    return { ok: false, reason: "market_inactive" };
  }

  if (filter.minVolumeUsd != null) {
    if (!isFiniteNumber(input.marketVolumeUsd)) return { ok: false, reason: "market_volume_missing" };
    if (input.marketVolumeUsd < filter.minVolumeUsd) {
      return { ok: false, reason: "market_volume_below_min" };
    }
  }
  if (filter.maxVolumeUsd != null) {
    if (!isFiniteNumber(input.marketVolumeUsd)) return { ok: false, reason: "market_volume_missing" };
    if (input.marketVolumeUsd > filter.maxVolumeUsd) {
      return { ok: false, reason: "market_volume_above_max" };
    }
  }

  if (filter.minLiquidityUsd != null) {
    if (!isFiniteNumber(input.marketLiquidityUsd)) {
      return { ok: false, reason: "market_liquidity_missing" };
    }
    if (input.marketLiquidityUsd < filter.minLiquidityUsd) {
      return { ok: false, reason: "market_liquidity_below_min" };
    }
  }
  if (filter.maxLiquidityUsd != null) {
    if (!isFiniteNumber(input.marketLiquidityUsd)) {
      return { ok: false, reason: "market_liquidity_missing" };
    }
    if (input.marketLiquidityUsd > filter.maxLiquidityUsd) {
      return { ok: false, reason: "market_liquidity_above_max" };
    }
  }

  return PASS;
};
