import { describe, expect, it } from "vitest";
import { sizeBudgetMakerQuote, type BudgetMakerQuoteSizingInput } from "../../apps/worker/src/maker/budgetQuoteSizing";

const base: BudgetMakerQuoteSizingInput = {
  price: .2, baseBudgetUSDC: 20, regimeMultiplier: .25, maximumShares: 200,
  maximumLiabilityUSDC: 20, minimumShares: "5", minimumNotionalUSDC: "5",
  shareIncrement: "0.01", feePerShareUSDC: "0",
};
const quote = (changes: Partial<BudgetMakerQuoteSizingInput> = {}) => sizeBudgetMakerQuote({ ...base, ...changes });

describe("venue-compatible liability-budget sizing", () => {
  it("uses the original .25 multiplier on twenty USDC to quote 25 shares at .20", () => {
    expect(quote()).toEqual({
      size: 25, reason: null, usedVenueFloor: false,
      audit: {
        netRoomShares: "200",
        minimumLegalShares: "25", softTargetShares: "25", maximumLegalShares: "100",
        softLiabilityBudgetUSDC: "5", chosenShares: "25", principalUSDC: "5",
        feeLiabilityUSDC: "0", totalLiabilityUSDC: "5",
      },
    });
  });

  it("ceil-quantizes the venue minimum at .49 instead of submitting 10.20 sub-minimum shares", () => {
    const r = quote({ price: .49 });
    expect(r.size).toBe(10.21); expect(r.usedVenueFloor).toBe(true);
    expect(r.audit).toMatchObject({ softTargetShares: "10.2", minimumLegalShares: "10.21", principalUSDC: "5.0029" });
  });

  it("explicitly lifts a positive soft budget below the venue floor, but not a zero regime", () => {
    const r = quote({ regimeMultiplier: .1 });
    expect(r.size).toBe(25); expect(r.usedVenueFloor).toBe(true);
    expect(r.audit).toMatchObject({ softTargetShares: "10", softLiabilityBudgetUSDC: "2" });
    expect(quote({ regimeMultiplier: 0 })).toEqual({ size: null, reason: "NO_LEGAL_QUOTE_SIZE", usedVenueFloor: false });
  });

  it.each([
    { maximumLiabilityUSDC: 4.99 }, { maximumShares: 24.999 },
    { maximumLiabilityUSDC: 0 }, { maximumShares: 0 }, { baseBudgetUSDC: 0 },
  ])("never lifts a hard bound or an explicitly zero base budget: %j", changes => {
    expect(quote(changes)).toMatchObject({ size: null, reason: "NO_LEGAL_QUOTE_SIZE", usedVenueFloor: false });
  });

  it("uses the caller's remaining pending cash and share capacity", () => {
    expect(quote({ regimeMultiplier: 1, maximumLiabilityUSDC: 6 }).size).toBe(30);
    const r = quote({ regimeMultiplier: 1, maximumShares: 26.009 });
    expect(r.size).toBe(26); expect(r.audit?.totalLiabilityUSDC).toBe("5.2");
    expect(quote({ maximumShares: 24.99 }).audit?.maximumLegalShares).toBe("24.99");
  });

  it("does not round eighteen-place pending-liability or share remainders up", () => {
    expect(quote({ maximumLiabilityUSDC: "4.999999999999999999" }))
      .toMatchObject({ size: null, reason: "NO_LEGAL_QUOTE_SIZE" });
    expect(quote({ maximumLiabilityUSDC: "5.000000000000000000" }).size).toBe(25);
    expect(quote({ maximumShares: "24.999999999999999999" }))
      .toMatchObject({ size: null, reason: "NO_LEGAL_QUOTE_SIZE" });
    expect(quote({ regimeMultiplier: 1, maximumShares: "26.009999999999999999" }).size).toBe(26);
  });

  it.each(["73.68", 73.68])("subtracts pending shares exactly before grid flooring (%s)", reservedShares => {
    expect(100 - 73.68).toBeLessThan(26.32); // A Number subtraction would falsely skip this legal boundary.
    const r = quote({ price: .19, regimeMultiplier: 1, maximumShares: 100, reservedShares });
    expect(r.size).toBe(26.32);
    expect(r.audit).toMatchObject({
      netRoomShares: "26.32", minimumLegalShares: "26.32", maximumLegalShares: "26.32",
      principalUSDC: "5.0008",
    });
  });

  it("clips equal or excess reservations to zero room without inventing capacity", () => {
    for (const reservedShares of ["100", "100.01"]) {
      const r = quote({ maximumShares: 100, reservedShares });
      expect(r).toMatchObject({ size: null, reason: "NO_LEGAL_QUOTE_SIZE" });
      expect(r.audit).toMatchObject({ netRoomShares: "0", maximumLegalShares: "0" });
    }
    expect(quote({ price: .19, regimeMultiplier: 1, maximumShares: "100",
      reservedShares: "73.680000000000000001" }))
      .toMatchObject({ size: null, reason: "NO_LEGAL_QUOTE_SIZE",
        audit: { netRoomShares: "26.319999999999999999", maximumLegalShares: "26.31" } });
  });

  it("requires principal to meet the venue minimum and charges fees to the hard liability bound", () => {
    const r = quote({ price: .4, feePerShareUSDC: "0.1", maximumLiabilityUSDC: 6.25 });
    expect(r.size).toBe(12.5); expect(r.usedVenueFloor).toBe(true);
    expect(r.audit).toMatchObject({
      minimumLegalShares: "12.5", softTargetShares: "10", principalUSDC: "5",
      feeLiabilityUSDC: "1.25", totalLiabilityUSDC: "6.25",
    });
    expect(quote({ price: .4, feePerShareUSDC: "0.1", maximumLiabilityUSDC: 6.249 }))
      .toMatchObject({ size: null, reason: "NO_LEGAL_QUOTE_SIZE" });
  });

  it("supports a non-power-of-ten lot and a separately binding share minimum", () => {
    expect(quote({ price: .49, shareIncrement: "0.25" })).toMatchObject({ size: 10.25, usedVenueFloor: true });
    const r = quote({ price: .5, minimumShares: "12.01" });
    expect(r.size).toBe(12.01); expect(r.audit?.principalUSDC).toBe("6.005");
  });

  it("never rounds a nearly-on-grid Number budget up to its intended value", () => {
    const small = { price: .5, regimeMultiplier: 1, minimumShares: "0.01", minimumNotionalUSDC: "0.01" };
    expect(quote({ ...small, baseBudgetUSDC: .145 }).size).toBe(.29);
    expect(quote({ ...small, baseBudgetUSDC: .14499999999999996 }).size).toBe(.28);
  });

  it("preserves scientific Number spellings while enforcing plain source precision", () => {
    expect(quote({ price: 1e-7, baseBudgetUSDC: 2e-8, regimeMultiplier: 1, maximumShares: .2,
      maximumLiabilityUSDC: 2e-8, minimumShares: "0.01", minimumNotionalUSDC: "0.000000001" }))
      .toMatchObject({ size: .2, reason: null });
    expect(quote({ maximumShares: 1e22, maximumLiabilityUSDC: 1e21 }).size).toBe(25);
  });

  it("rejects a legal decimal quantity that Number serialization would change", () => {
    expect(quote({ price: .49, baseBudgetUSDC: 1e15, regimeMultiplier: 1,
      maximumLiabilityUSDC: 1e15, maximumShares: Number.MAX_SAFE_INTEGER }))
      .toMatchObject({ size: null, reason: "UNREPRESENTABLE_QUOTE_SIZE", usedVenueFloor: false });
  });

  it.each<Partial<BudgetMakerQuoteSizingInput>>([
    { price: 0 }, { price: 1 }, { price: NaN }, { price: -1 }, { baseBudgetUSDC: Infinity },
    { regimeMultiplier: -1 }, { regimeMultiplier: 1.01 }, { maximumShares: -1 },
    { maximumLiabilityUSDC: NaN }, { minimumShares: "0" }, { minimumNotionalUSDC: "0" },
    { shareIncrement: "0" }, { shareIncrement: "0.0000000001" }, { minimumShares: "1e-2" },
    { minimumShares: "01" }, { minimumNotionalUSDC: "5 " }, { feePerShareUSDC: "-0.1" },
    { feePerShareUSDC: "0.0000000001" }, { minimumShares: "9007199254740991.1" },
    { maximumLiabilityUSDC: "5.0000000000000000001" }, { maximumShares: "25e0" },
    { reservedShares: -1 }, { reservedShares: NaN }, { reservedShares: "-0.01" },
    { reservedShares: "73.6800000000000000001" },
  ])("returns a typed skip for unsupported inputs: %j", changes => {
    expect(quote(changes)).toEqual({ size: null, reason: "INVALID_QUOTE_SIZING_INPUT", usedVenueFloor: false });
  });
});
