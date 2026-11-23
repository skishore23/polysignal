import { describe, expect, it } from "vitest";
import { sizeMakerQuote, type MakerQuoteSizingInput } from "../../apps/worker/src/maker/quoteSizing";

const base: MakerQuoteSizingInput = {
  targetShares: 20, price: 0.49, maximumShares: 25, maximumNotionalUSDC: 6,
  minimumShares: "5", minimumNotionalUSDC: "5", shareIncrement: "0.01"
};
const quote = (changes: Partial<MakerQuoteSizingInput> = {}) => sizeMakerQuote({ ...base, ...changes });
const empty = { size: null, reason: "NO_LEGAL_QUOTE_SIZE" };
const invalid = { size: null, reason: "INVALID_QUOTE_SIZING_INPUT" };

describe("maker share-increment sizing", () => {
  it("floors the independent $6 cap at 0.49 to 12.24 shares", () => {
    expect(quote()).toEqual({ size: 12.24, reason: null });
    expect(1224 * 49).toBe(59976); // 5.9976 USDC.
    expect(1225 * 49).toBeGreaterThan(60000);
  });
  it("keeps 0.29 exactly on its 0.01 increment and never rounds a lower target up", () => {
    const small = { minimumShares: "0.01", minimumNotionalUSDC: "0.01" };
    expect(quote({ ...small, targetShares: 0.29 }).size).toBe(0.29);
    expect(quote({ ...small, targetShares: 0.2899999999999999 }).size).toBe(0.28);
  });
  it("floors inventory room or target independently of available notional", () => {
    expect(quote({ maximumShares: 10.219 }).size).toBe(10.21);
    expect(quote({ targetShares: 10.239 }).size).toBe(10.23);
    expect(quote({ targetShares: 10.20 })).toEqual(empty);
    expect(quote({ maximumShares: 10.20 })).toEqual(empty);
    expect(quote({ maximumNotionalUSDC: 4.99 })).toEqual(empty);
  });
  it("checks share and USDC minima in their own units, including equality", () => {
    expect(quote({ targetShares: 5, price: 0.50 })).toEqual(empty);
    expect(quote({ price: 0.50, targetShares: 10 })).toEqual({ size: 10, reason: null });
    expect(quote({ targetShares: 10, price: 0.50, minimumShares: "10.01" })).toEqual(empty);
    expect(quote({ targetShares: 10, price: 0.50, minimumNotionalUSDC: "5.0001" })).toEqual(empty);
  });
  it("supports a non-power-of-ten increment and an unaligned minimum without lifting the target", () => {
    expect(quote({ targetShares: 11.49, shareIncrement: "0.25" }).size).toBe(11.25);
    expect(quote({ targetShares: 11.49, shareIncrement: "0.25", minimumShares: "11.3" })).toEqual(empty);
  });
  it("reads scientific Number spellings with exact decimal arithmetic", () => {
    expect(quote({ targetShares: 3e-7, maximumShares: 2e-7, price: 1e-7, maximumNotionalUSDC: 2e-14,
      shareIncrement: "0.0000001", minimumShares: "0.0000001", minimumNotionalUSDC: "0.00000000000001" }))
      .toEqual({ size: 2e-7, reason: null });
    expect(quote({ targetShares: 1e22, maximumShares: 1e21 }).size).toBe(12.24);
  });
  it("rejects a share quantity the Number data path would silently change", () => {
    expect(quote({ targetShares: 1, maximumShares: 1, minimumShares: "0.01", minimumNotionalUSDC: "0.01",
      shareIncrement: "0.33333333333333333" })).toEqual({ size: null, reason: "UNREPRESENTABLE_QUOTE_SIZE" });
  });
  it.each(["targetShares","maximumShares","maximumNotionalUSDC"] as const)("zero %s has no legal quantity", field => {
    expect(quote({[field]:0})).toEqual(empty);
  });
  it.each<Partial<MakerQuoteSizingInput>>([
    {price: 0}, {price: 1}, {price: NaN}, {maximumShares: Infinity}, {targetShares: -1},
    {minimumShares:"-1"}, {minimumShares:"0"}, {minimumNotionalUSDC:"0"}, {shareIncrement:"0"},
    {shareIncrement:"0x10"}, {shareIncrement:"0.01 "}, {minimumNotionalUSDC:"NaN"}
  ])("returns a typed skip for invalid inputs %j", args => {
    expect(quote(args)).toEqual(invalid);
  });
});
