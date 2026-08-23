import { describe, expect, it } from "vitest";

import {
  classifyMarketProfile,
  isShadowOnlyProfile
} from "../../apps/worker/src/trading/MarketProfile";

describe("classifyMarketProfile", () => {
  it("classifies explicit crypto 15m markets as CRYPTO_15M when fee-enabled", () => {
    const profile = classifyMarketProfile({
      question: "Bitcoin Up or Down - 2:00AM-2:15AM ET",
      slug: "btc-updown-15m-1771051800",
      feeRateBps: 2500
    });
    expect(profile).toBe("CRYPTO_15M");
  });

  it("classifies crypto 5m markets as CRYPTO_5M", () => {
    const profile = classifyMarketProfile({
      question: "Bitcoin Up or Down - 1:50AM-1:55AM ET",
      slug: "btc-updown-5m-1771051800",
      feeRateBps: 1000
    });
    expect(profile).toBe("CRYPTO_5M");
  });

  it("uses duration evidence to classify 15m even without explicit 15m text", () => {
    const profile = classifyMarketProfile({
      question: "Bitcoin Up or Down",
      slug: "btc-updown-1771051800",
      eventStartDate: "2026-02-14T06:50:00Z",
      eventEndDate: "2026-02-14T07:05:00Z",
      feeRateBps: 2500
    });
    expect(profile).toBe("CRYPTO_15M");
  });

  it("marks only CRYPTO_5M as shadow-only", () => {
    expect(isShadowOnlyProfile("CRYPTO_5M")).toBe(true);
    expect(isShadowOnlyProfile("CRYPTO_15M")).toBe(false);
    expect(isShadowOnlyProfile("SPORTS")).toBe(false);
  });
});
