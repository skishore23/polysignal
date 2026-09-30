import type { MarketProfile } from "./MarketProfile";

export const FEE_ROUND_DECIMALS = 5;
export const MIN_NON_ZERO_FEE_USDC = 0.00001;
export const LIQUIDITY_SINGLE_SIDED_FACTOR = 3;
export const LIQUIDITY_SINGLE_SIDED_MID_MIN = 0.1;
export const LIQUIDITY_SINGLE_SIDED_MID_MAX = 0.9;
export const CLOB_BATCH_ORDER_CAP = 15;

export const CRYPTO_15M_FEE_RATE = 0.07;
export const CRYPTO_15M_FEE_EXPONENT = 1;
export const CRYPTO_5M_FEE_RATE = 0.07;
export const CRYPTO_5M_FEE_EXPONENT = 1;
export const SPORTS_FEE_RATE = 0.05;
export const SPORTS_FEE_EXPONENT = 1;

export const CRYPTO_15M_MAX_EFFECTIVE_TAKER_FEE_RATE = 0.035;
export const CRYPTO_5M_MAX_EFFECTIVE_TAKER_FEE_RATE = 0.035;
export const SPORTS_MAX_EFFECTIVE_TAKER_FEE_RATE = 0.025;

export const CRYPTO_15M_REBATE_POOL_PCT = 0.2;
export const CRYPTO_5M_REBATE_POOL_PCT = 0.2;
export const SPORTS_REBATE_POOL_PCT = 0.15;

/** Current documentation is a scenario, not a proven historical effective interval. */
export const CURRENT_FEE_CONTRACT_VERSION = "polymarket-docs-2026-09-30";

export type FeeSchedule = {
  version: string;
  marketProfile: MarketProfile;
  feeRate: number;
  formula: "SHARES_RATE_P_ONE_MINUS_P";
  paymentAsset: "BUY_SHARES_SELL_USDC" | "USDC";
  roundingDecimals: number;
  effectiveFromMs: number | null;
  effectiveToMs: number | null;
  marketId?: string;
  tokenId?: string;
};

export type FeeCurveParams = {
  feeRate: number;
  exponent: number;
  maxEffectiveTakerFeeRate: number;
  makerRebatePoolPct: number;
};

const PROFILE_PARAMS: Record<"CRYPTO_15M" | "CRYPTO_5M" | "SPORTS", FeeCurveParams> = {
  CRYPTO_15M: {
    feeRate: CRYPTO_15M_FEE_RATE,
    exponent: CRYPTO_15M_FEE_EXPONENT,
    maxEffectiveTakerFeeRate: CRYPTO_15M_MAX_EFFECTIVE_TAKER_FEE_RATE,
    makerRebatePoolPct: CRYPTO_15M_REBATE_POOL_PCT
  },
  CRYPTO_5M: {
    feeRate: CRYPTO_5M_FEE_RATE,
    exponent: CRYPTO_5M_FEE_EXPONENT,
    maxEffectiveTakerFeeRate: CRYPTO_5M_MAX_EFFECTIVE_TAKER_FEE_RATE,
    makerRebatePoolPct: CRYPTO_5M_REBATE_POOL_PCT
  },
  SPORTS: {
    feeRate: SPORTS_FEE_RATE,
    exponent: SPORTS_FEE_EXPONENT,
    maxEffectiveTakerFeeRate: SPORTS_MAX_EFFECTIVE_TAKER_FEE_RATE,
    makerRebatePoolPct: SPORTS_REBATE_POOL_PCT
  }
};

/** Exact decimal arithmetic for decimal-string inputs from venue metadata. */
const decimalRatio = (value: number): { numerator: bigint; denominator: bigint } => {
  if (!Number.isFinite(value) || value < 0) throw new Error("INVALID_DECIMAL");
  const [rawMantissa, exponentText] = value.toString().toLowerCase().split("e");
  const mantissa = rawMantissa ?? "0";
  const exponent = exponentText == null ? 0 : Number(exponentText);
  const digits = mantissa.replace(".", "");
  const decimalPlaces = (mantissa.split(".")[1] ?? "").length - exponent;
  const numerator = BigInt(digits) * 10n ** BigInt(Math.max(0, -decimalPlaces));
  const denominator = 10n ** BigInt(Math.max(0, decimalPlaces));
  return { numerator, denominator };
};

const roundFeeUsdc = (shares: number, rate: number, price: number, decimals: number): number => {
  const q = decimalRatio(shares);
  const r = decimalRatio(rate);
  const p = decimalRatio(price);
  const complement = p.denominator - p.numerator;
  const numerator = q.numerator * r.numerator * p.numerator * complement;
  const denominator = q.denominator * r.denominator * p.denominator * p.denominator;
  const scaled = numerator * 10n ** BigInt(decimals);
  const roundedUnits = (2n * (scaled % denominator) >= denominator ? 1n : 0n) + scaled / denominator;
  return Number(roundedUnits) / 10 ** decimals;
};

export const selectFeeSchedule = (input: {
  marketProfile: MarketProfile;
  feeRateBps?: number | null;
  schedule?: FeeSchedule;
  asOfMs?: number;
  marketId?: string;
  tokenId?: string;
}): FeeSchedule => {
  if (input.feeRateBps != null && (!Number.isFinite(input.feeRateBps) || input.feeRateBps < 0)) {
    throw new Error("INVALID_FEE_RATE");
  }
  if (input.marketProfile === "FEE_FREE" && input.feeRateBps != null && input.feeRateBps > 0) {
    throw new Error("FEE_SCHEDULE_MARKET_MISMATCH");
  }
  const base: FeeSchedule =
    input.schedule ??
    ((): FeeSchedule => {
      if (input.marketProfile === "UNKNOWN") throw new Error("MISSING_FEE_SCHEDULE");
      const rate = input.marketProfile === "FEE_FREE" ? 0 : PROFILE_PARAMS[input.marketProfile].feeRate;
      return {
        version: CURRENT_FEE_CONTRACT_VERSION,
        marketProfile: input.marketProfile,
        feeRate: rate,
        formula: "SHARES_RATE_P_ONE_MINUS_P" as const,
        paymentAsset: "BUY_SHARES_SELL_USDC" as const,
        roundingDecimals: FEE_ROUND_DECIMALS,
        effectiveFromMs: null,
        effectiveToMs: null
      };
    })();
  if (
    base.marketProfile !== input.marketProfile ||
    (base.marketId != null && base.marketId !== input.marketId) ||
    (base.tokenId != null && base.tokenId !== input.tokenId)
  ) {
    throw new Error("FEE_SCHEDULE_MARKET_MISMATCH");
  }
  if (
    !base.version.trim() ||
    (base.effectiveFromMs != null && !Number.isFinite(base.effectiveFromMs)) ||
    (base.effectiveToMs != null &&
      (!Number.isFinite(base.effectiveToMs) ||
        base.effectiveFromMs == null ||
        base.effectiveToMs <= base.effectiveFromMs))
  ) {
    throw new Error("INVALID_FEE_SCHEDULE");
  }
  if (
    input.asOfMs != null &&
    (!Number.isFinite(input.asOfMs) ||
      base.effectiveFromMs == null ||
      base.effectiveToMs == null ||
      input.asOfMs < base.effectiveFromMs ||
      input.asOfMs >= base.effectiveToMs)
  ) {
    throw new Error("MISSING_FEE_SCHEDULE");
  }
  const feeRate = input.feeRateBps == null ? base.feeRate : input.feeRateBps / 10_000;
  if (
    !Number.isFinite(feeRate) ||
    feeRate < 0 ||
    feeRate > 1 ||
    !Number.isInteger(base.roundingDecimals) ||
    base.roundingDecimals < 0 ||
    base.roundingDecimals > 10 ||
    base.formula !== "SHARES_RATE_P_ONE_MINUS_P" ||
    (base.paymentAsset !== "USDC" && base.paymentAsset !== "BUY_SHARES_SELL_USDC")
  ) {
    throw new Error("INVALID_FEE_SCHEDULE");
  }
  return { ...base, feeRate };
};

export type TakerFeeInput = {
  marketProfile: MarketProfile;
  shares: number;
  price: number;
  side: "BUY" | "SELL";
  feeRateBps?: number | null;
  schedule?: FeeSchedule;
  asOfMs?: number;
  marketId?: string;
  tokenId?: string;
};

export type TakerFeeOutput = {
  scheduleVersion: string;
  paymentAsset: FeeSchedule["paymentAsset"];
  feeUsdc: number;
  feePerShare: number;
  feeBps: number;
  notionalUsdc: number;
  sharesFee: number;
  usdcFee: number;
  sharesReceived: number;
  usdcReceived: number;
};

export const computeTakerFee = (input: TakerFeeInput): TakerFeeOutput => {
  if (
    !Number.isFinite(input.shares) ||
    input.shares <= 0 ||
    !Number.isFinite(input.price) ||
    input.price <= 0 ||
    input.price >= 1 ||
    (input.side !== "BUY" && input.side !== "SELL")
  ) {
    throw new Error("INVALID_FEE_INPUT");
  }
  const shares = input.shares;
  const price = input.price;
  const notionalUsdc = shares * price;
  if (!Number.isFinite(notionalUsdc)) throw new Error("INVALID_FEE_INPUT");
  const schedule = selectFeeSchedule(input);
  const feeUsdc = roundFeeUsdc(shares, schedule.feeRate, price, schedule.roundingDecimals);
  if (!Number.isFinite(feeUsdc) || feeUsdc < 0 || feeUsdc > notionalUsdc) {
    throw new Error("INVALID_FEE_OUTPUT");
  }
  const feePerShare = shares > 0 ? feeUsdc / shares : 0;
  const feeBps = notionalUsdc > 0 ? (feeUsdc / notionalUsdc) * 10_000 : 0;

  const sharesFee = input.side === "BUY" && schedule.paymentAsset === "BUY_SHARES_SELL_USDC" ? feeUsdc / price : 0;
  const usdcFee = input.side === "SELL" || schedule.paymentAsset === "USDC" ? feeUsdc : 0;

  return {
    scheduleVersion: schedule.version,
    paymentAsset: schedule.paymentAsset,
    feeUsdc,
    feePerShare,
    feeBps,
    notionalUsdc,
    sharesFee,
    usdcFee,
    sharesReceived: input.side === "BUY" ? Math.max(0, shares - sharesFee) : shares,
    usdcReceived: input.side === "SELL" ? Math.max(0, notionalUsdc - usdcFee) : notionalUsdc
  };
};

export type FeeEquivalentInput = {
  marketProfile: MarketProfile;
  shares: number;
  price: number;
  feeRateBps?: number | null;
};

export const computeFeeEquivalentUsdc = (input: FeeEquivalentInput): number | null => {
  try {
    return computeTakerFee({
      marketProfile: input.marketProfile,
      shares: input.shares,
      price: input.price,
      side: "SELL",
      feeRateBps: input.feeRateBps
    }).feeUsdc;
  } catch {
    return null;
  }
};

export const getMakerRebatePoolPct = (marketProfile: MarketProfile): number => {
  if (marketProfile === "CRYPTO_15M") return CRYPTO_15M_REBATE_POOL_PCT;
  if (marketProfile === "CRYPTO_5M") return CRYPTO_5M_REBATE_POOL_PCT;
  if (marketProfile === "SPORTS") return SPORTS_REBATE_POOL_PCT;
  return 0;
};

export const estimateExpectedMakerRebateBps = (input: {
  marketProfile: MarketProfile;
  shares: number;
  price: number;
  rebateShareAssumption: number;
  feeRateBps?: number | null;
}): number => {
  const share =
    Number.isFinite(input.rebateShareAssumption) && input.rebateShareAssumption >= 0 && input.rebateShareAssumption <= 1
      ? input.rebateShareAssumption
      : 0;
  if (share <= 0) return 0;
  const feeEquivalentUsdc = computeFeeEquivalentUsdc({
    marketProfile: input.marketProfile,
    shares: input.shares,
    price: input.price,
    feeRateBps: input.feeRateBps
  });
  const poolPct = getMakerRebatePoolPct(input.marketProfile);
  if (feeEquivalentUsdc == null || feeEquivalentUsdc <= 0 || poolPct <= 0) return 0;

  const expectedRebateUsdc = feeEquivalentUsdc * poolPct * share;
  const notionalUsdc = input.shares * input.price;
  if (notionalUsdc <= 0) return 0;
  return (expectedRebateUsdc / notionalUsdc) * 10_000;
};

const parseFinitePositive = (value: number | null | undefined): number | null => {
  if (!Number.isFinite(value)) return null;
  const num = value as number;
  return num > 0 ? num : null;
};

export const isMidpointInSingleSidedRange = (midpoint: number): boolean =>
  Number.isFinite(midpoint) && midpoint >= LIQUIDITY_SINGLE_SIDED_MID_MIN && midpoint <= LIQUIDITY_SINGLE_SIDED_MID_MAX;

export const normalizeRewardsMaxSpreadCents = (value: number | null | undefined): number | null =>
  parseFinitePositive(value);

export type LiquidityOrderScoreInput = {
  midpointPrice: number;
  orderPrice: number;
  sizeShares: number;
  maxSpreadCents: number;
  minSizeShares?: number | null;
  multiplier?: number | null;
};

export const computeLiquidityOrderScore = (input: LiquidityOrderScoreInput): number => {
  const midpoint = parseFinitePositive(input.midpointPrice);
  const orderPrice = parseFinitePositive(input.orderPrice);
  const sizeShares = parseFinitePositive(input.sizeShares);
  const maxSpreadCents = normalizeRewardsMaxSpreadCents(input.maxSpreadCents);
  const minSizeShares = parseFinitePositive(input.minSizeShares ?? 0) ?? 0;
  const multiplier = parseFinitePositive(input.multiplier ?? 1) ?? 1;

  if (
    midpoint == null ||
    midpoint > 1 ||
    orderPrice == null ||
    orderPrice >= 1 ||
    sizeShares == null ||
    maxSpreadCents == null ||
    (input.minSizeShares != null && (!Number.isFinite(input.minSizeShares) || input.minSizeShares < 0)) ||
    (input.multiplier != null && (!Number.isFinite(input.multiplier) || input.multiplier <= 0)) ||
    sizeShares < minSizeShares
  ) {
    return 0;
  }

  const distanceCents = Math.abs(orderPrice - midpoint) * 100;
  if (!Number.isFinite(distanceCents) || distanceCents >= maxSpreadCents) return 0;

  // Both distances are in cents; their ratio is dimensionless.
  const scoreBase = (maxSpreadCents - distanceCents) / maxSpreadCents;
  return scoreBase * scoreBase * sizeShares * multiplier;
};

export const computeLiquidityQMin = (input: { qOne: number; qTwo: number; midpointPrice: number }): number => {
  if (!Number.isFinite(input.qOne) || input.qOne < 0 || !Number.isFinite(input.qTwo) || input.qTwo < 0) return 0;
  const qOne = parseFinitePositive(input.qOne) ?? 0;
  const qTwo = parseFinitePositive(input.qTwo) ?? 0;
  if (isMidpointInSingleSidedRange(input.midpointPrice)) {
    return Math.max(
      Math.min(qOne, qTwo),
      Math.max(qOne / LIQUIDITY_SINGLE_SIDED_FACTOR, qTwo / LIQUIDITY_SINGLE_SIDED_FACTOR)
    );
  }
  return Math.min(qOne, qTwo);
};
