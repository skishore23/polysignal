import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUN_PROTOCOL, inputHashes, runPaperStartup, selectCurrentBtcMarket, sha, validateAdmission } from "../../scripts/research/maker_paper_startup";
import { STARTUP_METADATA_URL, currentSlotMetadataUrl, type StartupSourceCapture, type RawCapture } from "../../scripts/research/maker_startup_capture";
import { BeliefEngine } from "../../apps/worker/src/belief/BeliefEngine";
import { RegimeGate } from "../../apps/worker/src/regime/RegimeGate";
import Database from "better-sqlite3";

const start = 1_800_000_000_000, condition = "0x" + "a".repeat(64);
const text = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
const at = (n: number) => ({ utc: start + n, mono: n });
function market(version = "v2", minimum = 0.1) {
  return { version, id: "123", conditionId: condition, slug: "btc-updown-5m-" + start / 1000,
    question: "Bitcoin Up or Down, five minutes", description: "Authored source fixture, not real market evidence",
    eventStartTime: new Date(start).toISOString(), endDate: new Date(start + 300000).toISOString(),
    active: true, closed: false, archived: false, acceptingOrders: true, enableOrderBook: true, negRisk: false,
    outcomes: '["Up","Down"]', clobTokenIds: '["999","888"]', positionIds: ["111", "222"],
    orderPriceMinTickSize: 0.01, orderMinSize: minimum, volume: "100", liquidity: "100",
    feesEnabled: true, feeSchedule: { rate: 0.25, exponent: 1, takerOnly: true, rebateRate: 0 } };
}
function http(url: string, raw: unknown, ms: number): RawCapture {
  const body = JSON.stringify(raw); return { url, raw: body, at: at(ms), startedAt: at(ms), status: 200, sha256: sha(body) };
}
function book(ms: number) { return { version: "v2", market: condition, asset_id: "111", timestamp: String(start + ms),
  bids: [{ price: ms % 3000 === 0 ? "0.48" : "0.49", size: "900" }], asks: [{ price: "0.51", size: "100" }],
  hash: "fixture-book-" + ms, tick_size: "0.01", min_order_size: "0.1", neg_risk: false }; }
function setup(minimum = 0.1, failure = false, offset = 0, lateSample?: number) {
  const out = mkdtempSync(path.resolve("reports/evidence/maker-startup-test-")), runName = path.basename(out);
  let time = at(offset), binding: unknown, frontier = 0, open = false; const observations: any[] = [];
  const capture = {
    readMetadata: async () => { time = at(offset); return http(STARTUP_METADATA_URL, [market("v2", minimum)], offset); },
    bindMarket: (x: unknown) => { binding = x; },
    readMarket: async () => { time = at(offset + 5); return http("https://clob.polymarket.com/clob-markets/" + condition,
      { t: [{ t: "111", o: "Up" }, { t: "222", o: "Down" }], mos: 0.1, mts: 0.01, mbf: 0, tbf: 10,
        fd: { r: 0.25, e: 1, to: true }, oas: 0 }, offset + 5); },
    readBook: async () => { time = at(offset + 10); return http("https://clob.polymarket.com/book?token_id=111", book(offset + 10), offset + 10); },
    readFee: async () => { time = at(offset + 11); return http("https://clob.polymarket.com/fee-rate?token_id=111", { base_fee: 2500 }, offset + 11); },
    stream: async (hooks: any) => {
      if (failure) throw Error("fixture_transport_failure");
      open = true;
      const instants = Array.from({ length: 20 }, (_, i) => offset + (i + 1) * 1000);
      if (lateSample !== undefined) instants.push(lateSample);
      for (const ms of instants) {
        if (hooks.shouldStop()) break;
        time = at(ms);
        const b = { ...book(ms), event_type: "book" }; observations.push(b); frontier++;
        await hooks.onMessage({ ...http("wss://ws-subscriptions-clob.polymarket.com/ws/market", b, ms), status: null });
        if (lateSample === undefined ? ms === offset + 12000 : ms === lateSample) {
          const t = { event_type: "last_trade_price", market: condition, asset_id: "111", timestamp: String(time.utc),
            price: "0.50", size: "5", side: "BUY" }; observations.push(t);
          frontier++;
          await hooks.onMessage({ ...http("wss://ws-subscriptions-clob.polymarket.com/ws/market", t, ms), status: null });
        }
        await hooks.onSample({ ...time });
      }
      open = false;
      return { reason: hooks.shouldStop() ? "caller_stop" : "fixture_end", at: time, callbacksPending: false };
    },
    settleCallbacks: async () => {},
    observationFrontier: () => ({ sequence: frontier, open }),
    ledger: () => ({ inputMode: "OFFLINE_FIXTURE", httpRequests: 4, observations: observations.length,
      tlsWireBytes: null, actualAccountChargeUSD: null }),
  };
  const hashes = inputHashes(), protocolSha256 = sha(text(RUN_PROTOCOL));
  const reviewFile = path.join(out, "authored-offline-review.json");
  writeFileSync(reviewFile, text({ decision: "APPROVE_BOUNDED_PAPER_STARTUP_RUN", runName, inputMode: "OFFLINE_FIXTURE", protocolSha256, inputSha256: hashes }));
  const admission: any = { schema: "CODEX_PAPER_STARTUP_ADMISSION_V7", executionAdmitted: true,
    inputMode: "OFFLINE_FIXTURE", runName, notBeforeUtcMs: start + offset, expiresUtcMs: start + offset + 300000,
    protocolSha256, inputSha256: hashes, reviewFile, reviewSha256: sha(readFileSync(reviewFile)) };
  const file = path.join(out, "authored-admission.json"); writeFileSync(file, text(admission));
  return { out, file, admission, clock: () => ({ ...time }), capture: capture as unknown as StartupSourceCapture,
    binding: () => binding, setTime: (ms: number) => { time = at(ms); }, advanceFrontier: () => { frontier++; } };
}

describe("complete no-fill startup wiring", () => {
  it.each(['post_dispose', 'post_drain', 'both'] as const)("still cancels an actual authored quote after %s terminal cleanup error", async kind => {
    const f = setup(), date = vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const close = vi.spyOn(Database.prototype, 'close'), originalDispose = RegimeGate.prototype.dispose;
    const dispose = vi.spyOn(RegimeGate.prototype, 'dispose').mockImplementation(function(this: RegimeGate) {
      originalDispose.call(this); if (kind !== 'post_drain') throw Error('authored_post_dispose');
    });
    const originalDrain = f.capture.settleCallbacks.bind(f.capture);
    if (kind !== 'post_dispose') vi.spyOn(f.capture, 'settleCallbacks').mockImplementation(async () => {
      await originalDrain(); throw Error('authored_post_drain');
    });
    try {
      const result = await runPaperStartup(f.file, { clock: f.clock, capture: f.capture });
      expect(result.actualQuotes).toBe(1); expect(result.status).toBe('FAILED_TERMINAL_RECONCILIATION');
      expect(result.cleanupFailure).toContain(kind === 'post_dispose' ? 'authored_post_dispose' : 'authored_post_drain');
      expect(result.terminal).toMatchObject({ syntheticCashUSDC: '10', pendingLiabilityUSDC: '0', fills: 0, profitUSDC: null });
      expect(result.afterCancel.orders.every((o: any) => o.status === 'CANCELLED')).toBe(true);
      expect(close).toHaveBeenCalled();
      const check = new Database(path.join(f.out, 'paper.sqlite'), { readonly: true, fileMustExist: true });
      try { expect(check.prepare("SELECT COUNT(*) AS n FROM shadow_orders WHERE status='OPEN'").get()).toEqual({ n: 0 }); }
      finally { check.close(); }
    } finally { dispose.mockRestore(); close.mockRestore(); date.mockRestore(); vi.restoreAllMocks(); }
  });
  it("selects IDs by explicit version, preserving original labels even when both ID sets exist", () => {
    const capture = http(STARTUP_METADATA_URL, [market()], 0);
    expect(selectCurrentBtcMarket(capture).selected).toMatchObject({ protocol_version: "v2",
      outcomes: [{ label: "Up", token_id: "111" }, { label: "Down", token_id: "222" }] });
    const old = http(STARTUP_METADATA_URL, [market("v1")], 0);
    expect(selectCurrentBtcMarket(old).selected?.outcomes[0]?.token_id).toBe("999");
    expect(selectCurrentBtcMarket(http(STARTUP_METADATA_URL, [market("unknown")], 0)).selected).toBeNull();
    expect(() => selectCurrentBtcMarket(http(STARTUP_METADATA_URL, [market(), market()], 0))).toThrow("ambiguous_metadata");
  });
  it("rejects expired or drifted admission and forbids fake transports under current-input claims", () => {
    const f = setup();
    expect(() => validateAdmission(f.admission, at(300000), true)).toThrow("frozen_window");
    expect(() => validateAdmission({ ...f.admission, inputMode: "CURRENT_PUBLIC_CAPTURE" }, at(0), true))
      .toThrow("test_transport_in_live_evidence");
    expect(() => validateAdmission({ ...f.admission, protocolSha256: "a".repeat(64) }, at(0), true)).toThrow("frozen_protocol");
    expect(() => validateAdmission({ ...f.admission, inputSha256: {} }, at(0), true)).toThrow("frozen_sources");
    expect(() => validateAdmission({ ...f.admission, runName: f.admission.runName + "-retry" }, at(0), true))
      .toThrow("review_source_or_scope");
  });
  it("binds the documented current-slot object rather than searching stale global rows", () => {
    const raw = http(currentSlotMetadataUrl(start), market(), 0);
    const s = selectCurrentBtcMarket(raw);
    expect(s.status).toBe("STRUCTURAL_METADATA_ONLY");
    expect(s.raw_body_sha256).toBe(sha(raw.raw));
    expect(s.selected).toMatchObject({ slug: "btc-updown-5m-" + start / 1000, raw_row_index: 0, protocol_version: "v2" });
    expect(() => selectCurrentBtcMarket({ ...raw, raw: JSON.stringify([market()]) })).toThrow("exact_slug_object");
    expect(() => selectCurrentBtcMarket({ ...raw, url: currentSlotMetadataUrl(start + 300000) })).toThrow("current_slot_receipt");
  });
  it("rejects a production admission whose market URL or slot is not frozen to its window", () => {
    const f = setup();
    const current = { ...f.admission, inputMode: "CURRENT_PUBLIC_CAPTURE", marketStartUtcMs: start,
      metadataUrl: STARTUP_METADATA_URL };
    expect(() => validateAdmission(current, at(0))).toThrow("frozen_current_slot");
    expect(() => validateAdmission({ ...current, metadataUrl: currentSlotMetadataUrl(start), marketStartUtcMs: start + 300000 }, at(0)))
      .toThrow("frozen_current_slot");
  });
  it("uses canonical observed features, real MakerLoop and risk sink together, with offline-only evidence", async () => {
    const f = setup(); const date = vi.spyOn(Date, "now").mockImplementation(() => f.clock().utc);
    try {
      const result = await runPaperStartup(f.file, { clock: f.clock, capture: f.capture });
      expect(result.failure).toBeUndefined();
      expect(result.status).toBe("OFFLINE_ENGINE_TRACE_ONLY");
      expect(result.actualQuotes).toBe(1);
      expect(result.beforeCancel.contract.purpose).toBe("SYNTHETIC_OFFLINE_ENGINEERING");
      expect(result.beforeCancel.orders[0]).toMatchObject({ token_id: "111", execution_mode: "SHADOW", side: "BUY" });
      expect(result.terminal).toMatchObject({ syntheticCashUSDC: "10", pendingLiabilityUSDC: "0", fills: 0, profitUSDC: null });
      expect(result.afterCancel.orders[0].status).toBe("CANCELLED");
      expect(f.binding()).toEqual({ condition, token: "111", protocolVersion: "v2" });
      expect(result.traces.some((t: any) => t.missing.includes("OBSERVED_VOLATILITY_HISTORY"))).toBe(true);
    } finally { date.mockRestore(); }
  });
  it("reports a provable incompatible notional minimum without manufacturing a quote", async () => {
    const f = setup(7); const result = await runPaperStartup(f.file, { clock: f.clock, capture: f.capture });
    expect(result.status).toBe("SKIP_VENUE_NOTIONAL_MINIMUM_EXCEEDS_PAPER_CAP");
    expect(result.actualQuotes).toBe(0); expect(result.fills).toBe(0); expect(result.profitUSDC).toBeNull();
    expect(result.constraint).toEqual({ venueMinimumNotionalUSDC: "7", perOrderUSDC: "6", totalLossUSDC: "6" });
  });
  it("classifies message exhaustion without calling it a full window or strategy verdict", async () => {
    const f = setup();
    (f.capture as any).stream = async () => ({ reason: "message_limit", at: f.clock(), callbacksPending: false });
    const r = await runPaperStartup(f.file, { clock: f.clock, capture: f.capture });
    expect(r.status).toBe("SOURCE_MESSAGE_BUDGET_EXHAUSTED_BEFORE_QUOTE");
    expect(r.readiness).toEqual({ canonicalSampleAttempts: 0, engineTicks: 0, accountCreated: false, nextBlockingInputs: null });
    expect(r.captureTermination.reason).toBe("message_limit");
    expect(r.actualQuotes).toBe(0); expect(r.terminal).toBeUndefined();
  });
  it("reports body-budget exhaustion separately and retains its exact failure", async () => {
    const f = setup();
    (f.capture as any).stream = async () => { throw Error("stream_application_limit"); };
    const r = await runPaperStartup(f.file, { clock: f.clock, capture: f.capture });
    expect(r.status).toBe("SOURCE_APPLICATION_BODY_BUDGET_EXHAUSTED_BEFORE_QUOTE");
    expect(r.failure).toContain("stream_application_limit");
    expect(r.readiness.accountCreated).toBe(false); expect(r.actualQuotes).toBe(0);
    expect(r.profitUSDC).toBeNull();
  });
  it("retains the original failing sample clock before decoding rejects cadence", async () => {
    const f = setup();
    (f.capture as any).stream = async (hooks: any) => {
      for (const ms of [1000, 1999]) { f.setTime(ms); await hooks.onSample(f.clock()); }
      return { reason: "fixture_end", at: f.clock(), callbacksPending: false };
    };
    const r = await runPaperStartup(f.file, { clock: f.clock, capture: f.capture });
    expect(r.status).toBe("FAILED_CLOSED"); expect(r.failure).toContain("sample_cadence");
    expect(r.traces).toHaveLength(2);
    expect(r.traces[1]).toMatchObject({ at: at(1999), missing: null, failure: "Error: maker_source:sample_cadence" });
    expect(r.actualQuotes).toBe(0); expect(r.readiness.accountCreated).toBe(false);
  });
  it("retains source failure and never calls it a started maker", async () => {
    const f = setup(0.1, true); const result = await runPaperStartup(f.file, { clock: f.clock, capture: f.capture });
    expect(result.status).toBe("FAILED_CLOSED"); expect(result.failure).toContain("fixture_transport_failure");
    expect(result.actualQuotes).toBe(0);
    expect(JSON.parse(readFileSync(path.join(f.out, "result.json"), "utf8")).status).toBe("FAILED_CLOSED");
  });
  it("rejects commit across market close even when authority and a fresh book remain valid", async () => {
    const f = setup(0.1, false, 100000, 299999);
    const date = vi.spyOn(Date, "now").mockImplementation(() => f.clock().utc);
    const original = BeliefEngine.prototype.estimate;
    const belief = vi.spyOn(BeliefEngine.prototype, "estimate").mockImplementation(async function(this: BeliefEngine, ...args) {
      const prior = await original.apply(this, args);
      if (f.clock().utc === start + 299999) f.setTime(300000);
      return prior;
    });
    try {
      const result = await runPaperStartup(f.file, { clock: f.clock, capture: f.capture });
      expect(result.status).toBe("FAILED_CLOSED"); expect(result.failure).toContain("execution_deadline");
      expect(result.actualQuotes).toBe(0);
      expect(result.beforeCancel.contract.executionDeadlineUtc).toBe(start + 300000);
      expect(result.guardRejections.some((r: any) => r.reason.includes("execution_deadline"))).toBe(true);
      expect(result.terminal.pendingLiabilityUSDC).toBe("0");
    } finally { belief.mockRestore(); date.mockRestore(); }
  });
  it("rejects a quote if new source data arrives during the ordinary belief await", async () => {
    const f = setup(), date = vi.spyOn(Date, "now").mockImplementation(() => f.clock().utc);
    const original = BeliefEngine.prototype.estimate;
    const belief = vi.spyOn(BeliefEngine.prototype, "estimate").mockImplementation(async function(this: BeliefEngine, ...args) {
      const prior = await original.apply(this, args); f.advanceFrontier(); return prior;
    });
    try {
      const result = await runPaperStartup(f.file, { clock: f.clock, capture: f.capture });
      expect(result.status).toBe("FAILED_CLOSED"); expect(result.failure).toContain("unprocessed_or_closed_source_frontier");
      expect(result.actualQuotes).toBe(0);
      expect(result.guardRejections.some((r: any) => r.reason.includes("unprocessed_or_closed_source_frontier"))).toBe(true);
      expect(result.terminal.pendingLiabilityUSDC).toBe("0");
    } finally { belief.mockRestore(); date.mockRestore(); }
  });
});
