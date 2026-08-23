import type { MarketProfile } from "./MarketProfile";

export const FEE_ROUND_DECIMALS = 4;
export const MIN_NON_ZERO_FEE_USDC = 0.0001;
export const LIQUIDITY_SINGLE_SIDED_FACTOR = 3;
export const LIQUIDITY_SINGLE_SIDED_MID_MIN = 0.1;
export const LIQUIDITY_SINGLE_SIDED_MID_MAX = 0.9;
export const CLOB_BATCH_ORDER_CAP = 15;

export const CRYPTO_15M_FEE_RATE = 0.25;
export const CRYPTO_15M_FEE_EXPONENT = 2;
// CRYPTO_5M is shadow-only. We use the same curve shape as short-term crypto as a conservative approximation.
export const CRYPTO_5M_FEE_RATE = 0.25;
export const CRYPTO_5M_FEE_EXPONENT = 2;
export const SPORTS_FEE_RATE = 0.0175;
export const SPORTS_FEE_EXPONENT = 1;

export const CRYPTO_15M_MAX_EFFECTIVE_TAKER_FEE_RATE = 0.015625; // 1.5625%
export const CRYPTO_5M_MAX_EFFECTIVE_TAKER_FEE_RATE = 0.015625; // 1.5625%
export const SPORTS_MAX_EFFECTIVE_TAKER_FEE_RATE = 0.004375; // 0.4375%

export const CRYPTO_15M_REBATE_POOL_PCT = 0.2;
export const CRYPTO_5M_REBATE_POOL_PCT = 0;
export const SPORTS_REBATE_POOL_PCT = 0.25;

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

const roundFeeUsdc = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const factor = 10 ** FEE_ROUND_DECIMALS;
  const rounded = Math.round(value * factor) / factor;
  if (rounded === 0) return 0;
  return Math.max(MIN_NON_ZERO_FEE_USDC, rounded);
};

const getFeeParams = (
  marketProfile: MarketProfile,
  overrideFeeRateBps?: number | null
): FeeCurveParams | null => {
  if (marketProfile !== "CRYPTO_15M" && marketProfile !== "CRYPTO_5M" && marketProfile !== "SPORTS") {
    return null;
  }
  const base = PROFILE_PARAMS[marketProfile];
  const overrideRate =
    Number.isFinite(overrideFeeRateBps) && (overrideFeeRateBps as number) > 0
      ? (overrideFeeRateBps as number) / 10_000
      : null;
  if (overrideRate == null) return base;
  return {
    ...base,
    feeRate: overrideRate
  };
};

export type TakerFeeInput = {
  marketProfile: MarketProfile;
  shares: number;
  price: number;
  side: "BUY" | "SELL";
  feeRateBps?: number | null;
};

export type TakerFeeOutput = {
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
  const shares = Number.isFinite(input.shares) ? Math.max(0, input.shares) : 0;
  const price = Number.isFinite(input.price) ? Math.max(0, input.price) : 0;
  const notionalUsdc = shares * price;
  const params = getFeeParams(input.marketProfile, input.feeRateBps);
  if (shares <= 0 || price <= 0 || params == null) {
    return {
      feeUsdc: 0,
      feePerShare: 0,
      feeBps: 0,
      notionalUsdc,
      sharesFee: 0,
      usdcFee: 0,
      sharesReceived: shares,
      usdcReceived: notionalUsdc
    };
  }

  const curve = Math.pow(price * (1 - price), params.exponent);
  const rawFee = shares * price * params.feeRate * curve;
  const feeUsdc = roundFeeUsdc(rawFee);
  const feePerShare = shares > 0 ? feeUsdc / shares : 0;
  const feeBps = notionalUsdc > 0 ? (feeUsdc / notionalUsdc) * 10_000 : 0;

  const sharesFee = input.side === "BUY" && price > 0 ? feeUsdc / price : 0;
  const usdcFee = input.side === "SELL" ? feeUsdc : 0;

  return {
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

export const computeFeeEquivalentUsdc = (input: FeeEquivalentInput): number =>
  computeTakerFee({
    marketProfile: input.marketProfile,
    shares: input.shares,
    price: input.price,
    side: "SELL",
    feeRateBps: input.feeRateBps
  }).feeUsdc;

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
  const share = Number.isFinite(input.rebateShareAssumption)
    ? Math.max(0, input.rebateShareAssumption)
    : 0;
  if (share <= 0) return 0;
  const feeEquivalentUsdc = computeFeeEquivalentUsdc({
    marketProfile: input.marketProfile,
    shares: input.shares,
    price: input.price,
    feeRateBps: input.feeRateBps
  });
  const poolPct = getMakerRebatePoolPct(input.marketProfile);
  if (feeEquivalentUsdc <= 0 || poolPct <= 0) return 0;

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
  Number.isFinite(midpoint) &&
  midpoint >= LIQUIDITY_SINGLE_SIDED_MID_MIN &&
  midpoint <= LIQUIDITY_SINGLE_SIDED_MID_MAX;

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
    orderPrice == null ||
    sizeShares == null ||
    maxSpreadCents == null ||
    sizeShares < minSizeShares
  ) {
    return 0;
  }

  const distanceCents = Math.abs(orderPrice - midpoint) * 100;
  if (!Number.isFinite(distanceCents) || distanceCents >= maxSpreadCents) return 0;

  const scoreBase = maxSpreadCents * (maxSpreadCents - distanceCents);
  return scoreBase * scoreBase * sizeShares * multiplier;
};

export const computeLiquidityQMin = (input: {
  qOne: number;
  qTwo: number;
  midpointPrice: number;
}): number => {
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
