export type BudgetMakerQuoteSizingInput = {
  price: number;
  baseBudgetUSDC: number;
  regimeMultiplier: number;
  /** Filled-inventory room before subtracting the caller's pending reservation. */
  maximumShares: number | string;
  reservedShares?: number | string;
  /** Already combines the caller's cash, per-order, aggregate and exposure bounds. */
  maximumLiabilityUSDC: number | string;
  minimumShares: string;
  minimumNotionalUSDC: string;
  shareIncrement: string;
  feePerShareUSDC: string;
};

export type BudgetQuoteSkipReason =
  | "INVALID_QUOTE_SIZING_INPUT"
  | "NO_LEGAL_QUOTE_SIZE"
  | "UNREPRESENTABLE_QUOTE_SIZE";

export type BudgetQuoteSizingAudit = {
  netRoomShares: string;
  minimumLegalShares: string;
  softTargetShares: string;
  maximumLegalShares: string;
  softLiabilityBudgetUSDC: string;
  chosenShares: string | null;
  principalUSDC: string | null;
  feeLiabilityUSDC: string | null;
  totalLiabilityUSDC: string | null;
};

export type BudgetQuoteSizingResult = {
  size: number | null;
  reason: BudgetQuoteSkipReason | null;
  usedVenueFloor: boolean;
  audit?: BudgetQuoteSizingAudit;
};

type Decimal = { units: bigint; places: number };
const power = (places: number) => 10n ** BigInt(places);

function numberDecimal(value: unknown): Decimal | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  // Interpret the actual round-trip spelling, including scientific notation.
  // Do not round a caller's almost-on-grid value up to its intended value.
  const [mantissa, exponent] = String(value).split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const places = fraction.length - Number(exponent ?? 0);
  const units = BigInt(whole! + fraction);
  return places < 0 ? { units: units * power(-places), places: 0 } : { units, places };
}

function sourceDecimal(value: unknown): Decimal | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const result = { units: BigInt(whole! + fraction), places: fraction.length };
  // Match the source bridge's supported numeric domain without a lossy comparison.
  return result.units <= BigInt(Number.MAX_SAFE_INTEGER) * power(result.places) ? result : null;
}

function derivedDecimal(value: unknown): Decimal | null {
  if (typeof value === "number") return numberDecimal(value);
  // Remaining liability is a difference of price*quantity sums, with up to
  // eighteen places. Preserve that remainder instead of converting it to Number.
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(whole! + fraction), places: fraction.length };
}

function compare(a: Decimal, b: Decimal): bigint {
  return a.units * power(b.places) - b.units * power(a.places);
}

function add(a: Decimal, b: Decimal): Decimal {
  const places = Math.max(a.places, b.places);
  return { units: a.units * power(places - a.places) + b.units * power(places - b.places), places };
}

function subtractFloorZero(a: Decimal, b: Decimal): Decimal {
  const places = Math.max(a.places, b.places);
  const units = a.units * power(places - a.places) - b.units * power(places - b.places);
  return { units: units > 0n ? units : 0n, places };
}

function multiply(a: Decimal, b: Decimal): Decimal {
  return { units: a.units * b.units, places: a.places + b.places };
}

function ratioSteps(bound: Decimal, step: Decimal, ceil = false): bigint {
  const numerator = bound.units * power(step.places);
  const denominator = step.units * power(bound.places);
  return ceil ? (numerator + denominator - 1n) / denominator : numerator / denominator;
}

function text(value: Decimal): string {
  const digits = value.units.toString().padStart(value.places + 1, "0");
  if (!value.places) return digits;
  const fraction = digits.slice(-value.places).replace(/0+$/, "");
  return digits.slice(0, -value.places) + (fraction ? "." + fraction : "");
}

const skipped = (reason: BudgetQuoteSkipReason, audit?: BudgetQuoteSizingAudit): BudgetQuoteSizingResult =>
  ({ size: null, reason, usedVenueFloor: false, ...(audit ? { audit } : {}) });

/**
 * Venue-compatible soft budget, subject to independently supplied hard bounds.
 * A positive regime may lift the SOFT budget to the venue minimum; it never
 * lifts a cash/liability/inventory bound or authorizes a disallowed regime.
 * The caller must apply regime.allowed and all other policy/source gates.
 */
export function sizeBudgetMakerQuote(input: BudgetMakerQuoteSizingInput): BudgetQuoteSizingResult {
  const price = numberDecimal(input.price), base = numberDecimal(input.baseBudgetUSDC);
  const multiplier = numberDecimal(input.regimeMultiplier), room = derivedDecimal(input.maximumShares);
  const reserved = input.reservedShares === undefined
    ? { units: 0n, places: 0 } : derivedDecimal(input.reservedShares);
  const cap = derivedDecimal(input.maximumLiabilityUSDC);
  const minimumShares = sourceDecimal(input.minimumShares), minimumNotional = sourceDecimal(input.minimumNotionalUSDC);
  const lot = sourceDecimal(input.shareIncrement), fee = sourceDecimal(input.feePerShareUSDC);
  if (!price || !base || !multiplier || !room || !reserved || !cap || !minimumShares || !minimumNotional || !lot || !fee
    || input.price <= 0 || input.price >= 1 || input.regimeMultiplier > 1
    || minimumShares.units === 0n || minimumNotional.units === 0n || lot.units === 0n) {
    return skipped("INVALID_QUOTE_SIZING_INPUT");
  }
  if (multiplier.units === 0n || base.units === 0n) {
    return skipped("NO_LEGAL_QUOTE_SIZE");
  }

  const netRoom = subtractFloorZero(room, reserved);
  const perShareLiability = add(price, fee);
  const stepPrincipal = multiply(lot, price), stepLiability = multiply(lot, perShareLiability);
  const minimumByShares = ratioSteps(minimumShares, lot, true);
  const minimumByNotional = ratioSteps(minimumNotional, stepPrincipal, true);
  const minimumSteps = minimumByShares > minimumByNotional ? minimumByShares : minimumByNotional;
  const hardByRoom = ratioSteps(netRoom, lot), hardByLiability = ratioSteps(cap, stepLiability);
  const hardSteps = hardByRoom < hardByLiability ? hardByRoom : hardByLiability;
  const softBudget = multiply(base, multiplier);
  const softSteps = ratioSteps(softBudget, stepLiability);
  const quantity = (steps: bigint): Decimal => ({ units: steps * lot.units, places: lot.places });
  const audit: BudgetQuoteSizingAudit = {
    netRoomShares: text(netRoom),
    minimumLegalShares: text(quantity(minimumSteps)),
    softTargetShares: text(quantity(softSteps)),
    maximumLegalShares: text(quantity(hardSteps)),
    softLiabilityBudgetUSDC: text(softBudget),
    chosenShares: null, principalUSDC: null, feeLiabilityUSDC: null, totalLiabilityUSDC: null,
  };
  if (minimumSteps > hardSteps) return skipped("NO_LEGAL_QUOTE_SIZE", audit);

  const boundedSoftSteps = softSteps < hardSteps ? softSteps : hardSteps;
  const steps = minimumSteps > boundedSoftSteps ? minimumSteps : boundedSoftSteps;
  const shares = quantity(steps);
  const size = Number(text(shares));
  const roundTrip = numberDecimal(size);
  if (!roundTrip || compare(roundTrip, shares) !== 0n) return skipped("UNREPRESENTABLE_QUOTE_SIZE", audit);
  return {
    size, reason: null, usedVenueFloor: minimumSteps > boundedSoftSteps,
    audit: {
      ...audit, chosenShares: text(shares),
      principalUSDC: text(multiply(shares, price)),
      feeLiabilityUSDC: text(multiply(shares, fee)),
      totalLiabilityUSDC: text(multiply(shares, perShareLiability)),
    },
  };
}
