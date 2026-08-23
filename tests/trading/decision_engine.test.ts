import { describe, expect, it } from "vitest";
import {
  decideArbOpportunity,
  decideMarketProfileScope,
  parseCsvAllowlist
} from "../../apps/worker/src/trading/DecisionEngine";

describe("DecisionEngine helpers", () => {
  it("parses allowlists", () => {
    expect(parseCsvAllowlist(null)).toBeNull();
    expect(parseCsvAllowlist(" , ")).toBeNull();
    expect(Array.from(parseCsvAllowlist("m1, m2") ?? [])).toEqual(["m1", "m2"]);
  });

  it("applies profile scope gates", () => {
    expect(decideMarketProfileScope("CRYPTO_15M", "PROFILE_KNOWN_ONLY")).toEqual({ ok: true, reason: "ok" });
    expect(decideMarketProfileScope("CRYPTO_5M", "PROFILE_KNOWN_ONLY").ok).toBe(true);
    expect(decideMarketProfileScope("SPORTS", "PROFILE_KNOWN_ONLY").ok).toBe(true);
    expect(decideMarketProfileScope("FEE_FREE", "PROFILE_KNOWN_ONLY").ok).toBe(false);
    expect(decideMarketProfileScope("CRYPTO_5M", "ALL").ok).toBe(true);
    expect(decideMarketProfileScope("UNKNOWN", "ALL").ok).toBe(false);
  });

  it("gates arb opportunities", () => {
    expect(decideArbOpportunity(10, 5).ok).toBe(true);
    expect(decideArbOpportunity(1, 5).ok).toBe(false);
  });
});
