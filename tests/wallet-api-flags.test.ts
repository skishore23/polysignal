import { describe, expect, it } from "vitest";
import { resolveWalletMakerTakerFlags } from "../apps/web/lib/wallet-flags";

describe("resolveWalletMakerTakerFlags", () => {
  it("create: defaults to taker-only when neither sent", () => {
    const out = resolveWalletMakerTakerFlags({});
    expect(out.makerEnabled).toBe(0);
    expect(out.autoTradeEnabled).toBe(1);
  });

  it("create: uses body when both sent", () => {
    expect(resolveWalletMakerTakerFlags({ makerEnabled: true, autoTradeEnabled: false })).toEqual({
      makerEnabled: 1,
      autoTradeEnabled: 0
    });
    expect(resolveWalletMakerTakerFlags({ makerEnabled: false, autoTradeEnabled: true })).toEqual({
      makerEnabled: 0,
      autoTradeEnabled: 1
    });
  });

  it("update: preserves existing when maker/taker not sent (partial update)", () => {
    const existing = { makerEnabled: 0, autoTradeEnabled: 1 };
    const out = resolveWalletMakerTakerFlags({}, existing);
    expect(out.makerEnabled).toBe(0);
    expect(out.autoTradeEnabled).toBe(1);
  });

  it("update: preserves existing when only name/other fields sent (no maker/taker in body)", () => {
    const existing = { makerEnabled: 0, autoTradeEnabled: 1 };
    const out = resolveWalletMakerTakerFlags({ name: "Renamed" } as any, existing);
    expect(out.makerEnabled).toBe(0);
    expect(out.autoTradeEnabled).toBe(1);
  });

  it("update: does not flip taker-only wallet to maker-only when body has only makerEnabled true", () => {
    const existing = { makerEnabled: 0, autoTradeEnabled: 1 };
    const out = resolveWalletMakerTakerFlags({ makerEnabled: true }, existing);
    expect(out.makerEnabled).toBe(1);
    expect(out.autoTradeEnabled).toBe(1);
  });

  it("update: uses body when both sent", () => {
    const existing = { makerEnabled: 1, autoTradeEnabled: 0 };
    const out = resolveWalletMakerTakerFlags(
      { makerEnabled: false, autoTradeEnabled: true },
      existing
    );
    expect(out).toEqual({ makerEnabled: 0, autoTradeEnabled: 1 });
  });

  it("update: preserves existing when existing has null (fallback to 0/1)", () => {
    const out = resolveWalletMakerTakerFlags({}, { makerEnabled: null, autoTradeEnabled: null });
    expect(out.makerEnabled).toBe(0);
    expect(out.autoTradeEnabled).toBe(1);
  });
});
