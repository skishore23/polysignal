export type MakerQuoteSizingInput = {
  targetShares: number;
  price: number;
  maximumShares: number;
  maximumNotionalUSDC: number;
  minimumShares: string;
  minimumNotionalUSDC: string;
  shareIncrement: string;
};

type SkipReason = "INVALID_QUOTE_SIZING_INPUT" | "NO_LEGAL_QUOTE_SIZE" | "UNREPRESENTABLE_QUOTE_SIZE";
type SizingResult = { size: number; reason: null } | { size: null; reason: SkipReason };
type Decimal = { units: bigint; places: number };

function decimal(value: number | string): Decimal | null {
  // Numbers use their round-trippable decimal spelling, including scientific notation.
  // Public venue constraints use plain decimal strings as in the source bridge.
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
  } else if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    return null;
  }
  const [mantissa, exponent] = String(value).split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const places = fraction.length - Number(exponent ?? 0);
  const units = BigInt(whole! + fraction);
  return places < 0 ? { units: units * 10n ** BigInt(-places), places: 0 } : { units, places };
}

// Both inputs are nonnegative, and step is nonzero, so integer division rounds down.
function stepLimit(bound: Decimal, step: Decimal): bigint {
  return (bound.units * 10n ** BigInt(step.places)) / (step.units * 10n ** BigInt(bound.places));
}

function compare(a: Decimal, b: Decimal): bigint {
  return a.units * 10n ** BigInt(b.places) - b.units * 10n ** BigInt(a.places);
}

/** Largest complete share increment within the engine target, inventory room and notional cap. */
export function sizeMakerQuote(input: MakerQuoteSizingInput): SizingResult {
  if (![input.targetShares, input.price, input.maximumShares, input.maximumNotionalUSDC]
    .every(value => typeof value === "number") || ![input.minimumShares, input.minimumNotionalUSDC, input.shareIncrement]
    .every(value => typeof value === "string")) return { size: null, reason: "INVALID_QUOTE_SIZING_INPUT" };

  const target = decimal(input.targetShares), price = decimal(input.price);
  const room = decimal(input.maximumShares), cap = decimal(input.maximumNotionalUSDC);
  const minShares = decimal(input.minimumShares), minNotional = decimal(input.minimumNotionalUSDC);
  const step = decimal(input.shareIncrement);
  if (!target || !price || !room || !cap || !minShares || !minNotional || !step
    || input.price <= 0 || input.price >= 1 || step.units === 0n || minShares.units === 0n || minNotional.units === 0n) {
    return { size: null, reason: "INVALID_QUOTE_SIZING_INPUT" };
  }

  const stepNotional = { units: step.units * price.units, places: step.places + price.places };
  const limits = [stepLimit(target, step), stepLimit(room, step), stepLimit(cap, stepNotional)];
  const steps = limits.reduce((a, b) => a < b ? a : b);
  const shares = { units: steps * step.units, places: step.places };
  const notional = { units: steps * stepNotional.units, places: stepNotional.places };
  if (steps === 0n || compare(shares, minShares) < 0n || compare(notional, minNotional) < 0n) {
    return { size: null, reason: "NO_LEGAL_QUOTE_SIZE" };
  }
  // The surrounding engine stores Number quantities. Reject a conversion that would
  // move the exact size off-grid or across a bound when serialized by the engine.
  const size = Number(shares.units.toString() + "e-" + shares.places);
  const roundTrip = decimal(size);
  if (!roundTrip || compare(roundTrip, shares) !== 0n) {
    return { size: null, reason: "UNREPRESENTABLE_QUOTE_SIZE" };
  }
  return { size, reason: null };
}
