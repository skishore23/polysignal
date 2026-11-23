import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOperatingSourceState } from "../../scripts/research/maker_operating_source_bridge";
import { deriveMakerStartupInputs, type BridgeStreamItem, type MakerStartupSourceInput } from "../../scripts/research/maker_startup_source_bridge";
import type { StartupClock } from "../../scripts/research/maker_quote_startup";

const start = 1795404000000, condition = "0x" + "a".repeat(64), market = "45", token = "888";
const at = (ms: number) => ({ utc: start + ms, mono: ms });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const url = "https://clob.polymarket.com";
function snapshot(ms: number, bid = "0.47") {
  return { market: condition, asset_id: token, timestamp: String(start + ms), hash: "test-book-" + ms,
    asks: [{ price: "0.54", size: "12" }], bids: [{ price: "0.43", size: "25" }, { price: bid, size: "10" }] };
}
function trade(ms: number) {
  return { event_type: "last_trade_price", asset_id: token, market: condition, timestamp: String(start + ms),
    price: "0.51", size: "5", side: "BUY", fee_rate_bps: "999", transaction_hash: "0x" + "a".repeat(64) };
}
const frame = (ms: number, row: unknown): BridgeStreamItem => ({ kind: "frame", at: at(ms), raw: JSON.stringify(row) });
function fixture(): MakerStartupSourceInput {
  const slug = "btc-updown-5m-" + start / 1000, question = "BTC higher?", rules = "Original fixture rules";
  const row = { version:"v1", orderMinSize:5, orderPriceMinTickSize:0.01, id: market, conditionId: condition, slug, question, description: rules, eventStartTime: new Date(start).toISOString(),
    endDate: new Date(start + 300000).toISOString(), active: true, closed: false, archived: false, acceptingOrders: true,
    negRisk: false, outcomes: '["Down","Up"]', clobTokenIds: '["999","888"]', volume: "50", liquidity: 29 };
  const raw = JSON.stringify([row]);
  return { gamma: { raw, url: "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=endDate&ascending=true", at: at(0) },
    selection: { raw_body_sha256: hash(raw), status: "STRUCTURAL_METADATA_ONLY", quote_phase_admitted: false,
      selected: { market_id: market, condition_id: condition, slug, question, rules, start_utc_ms: start, end_utc_ms: start + 300000,
        raw_row_index: 0, semantic_admission: false, outcomes: [{ label: "Down", token_id: "999" }, { label: "Up", token_id: token }] } },
    clobMarket: { raw: JSON.stringify({ condition_id: condition, market_slug: slug, question, description: rules, active: true,
      closed: false, archived: false, accepting_orders: true, enable_order_book: true, neg_risk: false,
      tokens: [{ outcome: "Up", token_id: token }, { outcome: "Down", token_id: "999" }],
      minimum_order_size: 5, minimum_tick_size: 0.01, maker_base_fee: 0, taker_base_fee: 30 }), at: at(5), url: url + "/markets/" + condition },
    clobBook: { raw: JSON.stringify({ ...snapshot(10), tick_size: "0.01", min_order_size: "5", neg_risk: false }),
      at: at(10), url: url + "/book?token_id=" + token },
    tokenFee: { raw: '{"base_fee":35}', at: at(11), url: url + "/fee-rate?token_id=" + token },
    stream: [{ kind: "sample", at: at(12) }], decision: at(12), topKLevels: 1, originalLabel: "Up" };
}

const sample = (ms: number): BridgeStreamItem => ({kind: "sample", at: at(ms)});
const full = (receipt: number, venue = receipt) => frame(receipt, {event_type: "book", ...snapshot(venue)});
const bid = (extra = {}) => ({asset_id: token, side: "BUY", price: "0.47", size: "9",
  best_bid: "0.47", best_ask: "0.54", hash: "change", ...extra});
const delta = (ms: number, ...changes: ReturnType<typeof bid>[]) => frame(ms, {market: condition,
  event_type: "price_change", timestamp: String(start + ms), price_changes: changes});

function comparePrefixes(stream: BridgeStreamItem[]) {
  const f = fixture(), state = createOperatingSourceState(f), prefix: BridgeStreamItem[] = [];
  for (const item of stream) {
    state.process(item);
    prefix.push(item);
    const result = state.snapshot(item.at);
    expect(result).toEqual(deriveMakerStartupInputs({...f, stream: prefix, decision: item.at}));
    expect(state.bookStatus(item.at)).toEqual({ book: result.book, bookInvalidation: result.bookInvalidation,
      fresh: !result.missing.includes("FRESH_AUTHORITATIVE_ORIGINAL_BOOK") });
  }
  return state;
}

describe("incremental original-token observation state", () => {
  it.each([null, {}, "not-an-array"])("classifies malformed initial book sides as correctness faults: %j", (bad) => {
    const f=fixture(), row=JSON.parse(f.clobBook.raw); row.bids=bad; f.clobBook.raw=JSON.stringify(row);
    expect(()=>createOperatingSourceState(f)).toThrow("book_side_schema");
  });
  it("classifies a genuine empty initial side as an unavailable book",()=>{
    const f=fixture(),row=JSON.parse(f.clobBook.raw);row.bids=[];f.clobBook.raw=JSON.stringify(row);
    expect(()=>createOperatingSourceState(f)).toThrow("empty_book_side");
  });
  it("serves a detached book on the frame path without copying accumulated trade witnesses", () => {
    const state = createOperatingSourceState(fixture());
    state.process(full(20));
    for (let ms = 21; ms <= 120; ms++) state.process(frame(ms, trade(ms)));
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      const status = state.bookStatus(at(120));
      expect(Object.keys(status).sort()).toEqual(["book", "bookInvalidation", "fresh"]);
      expect(status.fresh).toBe(true);
      status.book.receipt.utc = 0;
      status.book.bid = "0";
      expect(state.bookStatus(at(1020)).book).toMatchObject({ receipt: at(20), bid: "0.47" });
      expect(state.bookStatus(at(1020)).fresh).toBe(true);
      expect(state.bookStatus(at(1021)).fresh).toBe(false);
      expect(() => state.bookStatus(at(119))).toThrow("causal_clocks");
      expect(() => state.bookStatus(at(300000))).toThrow("gamma_window_or_rules");
      expect(clone).not.toHaveBeenCalled();
    } finally { clone.mockRestore(); }
    expect(state.snapshot(at(120)).trades).toHaveLength(100);
  });

  it("matches every prefix across missing anchor, mixed assets, repeated levels, deletion, staleness and full restoration", () => {
    const sibling = bid({asset_id: "999", price: "0.8"});
    const stream = [delta(15,bid()), full(20), delta(24,bid(),sibling), sample(25),
      delta(30,bid(),bid()), delta(32,bid()), full(38,31), full(40,32),
      delta(45,bid({size:"0",best_bid:"0.43"}),sibling), frame(50,trade(50)),
      delta(1100,sibling), sample(1100), full(1200), sample(2200), sample(3200)];
    const r = comparePrefixes(stream).snapshot(at(3200));
    expect(r.missing).toContain("FRESH_AUTHORITATIVE_ORIGINAL_BOOK");
    expect(r.trades).toHaveLength(1);
  });

  it("advances canonical features only at samples and protects prior observations from mutation", () => {
    const f = fixture(), state = createOperatingSourceState(f);
    const stream: BridgeStreamItem[] = [];
    for (let i=0; i<14; i++) {
      const ms = 20+i*1000;
      const next = [frame(ms,[{...snapshot(ms,i % 3 ? "0.49" : "0.47"), event_type:"book"},trade(ms)]),sample(ms)];
      for(const item of next) { state.process(item); stream.push(item); }
      const expected = deriveMakerStartupInputs({...f, stream, decision:at(ms)});
      const copy = state.snapshot(at(ms));
      expect(copy).toEqual(expected);
      copy.trades.length = 0;
      copy.feature!.bestBid = -1;
      copy.identity.outcomes[0]!.label = "changed";
      copy.book.receipt.utc = 0;
      expect(state.snapshot(at(ms))).toEqual(expected);
    }
    expect(state.snapshot(at(13020)).feature?.vol30m).toBeGreaterThan(0);
  });

  const failures: [string, BridgeStreamItem[]][] = [
    ["ambiguous_duplicate_trade", [frame(20,trade(20)),frame(21,trade(20))]],
    ["backdated_delta", [full(21), frame(25, {market:condition,event_type:"price_change",
      timestamp:String(start+20),price_changes:[bid()]})]],
    ["empty_book_side", [full(20), full(25,19), frame(30,{...snapshot(30),asks:[],event_type:"book"})]],
    ["delta_asset", [full(20), delta(22,bid(),bid({asset_id:"invalid"}))]],
    ["delta_tick_context", [full(20), frame(22,{market:condition,event_type:"price_change",
      timestamp:String(start+22),tick_size:"0.001",price_changes:[bid()]})]],
    ["sample_cadence", [sample(20),sample(1019)]],
    ["frame_market", [frame(20, [trade(20),{...trade(20),market:"wrong"}])]],
    ["causal_clocks", [full(22),full(21)]],
    ["stream_disconnected", [full(20),{kind:"disconnect",at:at(21)}]],
  ];
  it.each(failures)("preserves terminal prefix error %s and hides partial frame effects", (reason, stream) => {
    const f=fixture(), state=createOperatingSourceState(f);
    expect(()=>deriveMakerStartupInputs({...f,stream,decision:at(2000)})).toThrow(reason);
    expect(()=>stream.forEach(x=>state.process(x))).toThrow(reason);
    expect(()=>state.bookStatus(at(2000))).toThrow(reason);
    expect(()=>state.snapshot(at(2000))).toThrow(reason);
    expect(()=>state.process(full(2100))).toThrow(reason);
  });

  it("preserves versioned constraints and profile-specific missing evidence after new observations", () => {
    const f = fixture();
    const row = JSON.parse(f.gamma.raw)[0];
    Object.assign(row, {version:"v2", positionIds:["999","888"], enableOrderBook:true,
      feeSchedule:{rate:0.05,exponent:1,takerOnly:false}});
    f.gamma.raw = JSON.stringify(row);
    f.gamma.url = "https://gamma-api.polymarket.com/markets/slug/" + row.slug;
    (f.selection as {raw_body_sha256: string}).raw_body_sha256 = hash(f.gamma.raw);
    f.clobMarket.url = url + "/clob-markets/" + condition;
    f.clobMarket.raw = JSON.stringify({t:[{o:"Up",t:token},{o:"Down",t:"999"}],mos:6,mts:0.01,
      fd:{r:0.05,e:1,to:false},mbf:1000,tbf:1000,oas:2});
    f.clobBook.raw = JSON.stringify({...JSON.parse(f.clobBook.raw),version:"v2"});
    delete f.tokenFee;
    const state=createOperatingSourceState(f), stream=[full(20),sample(25)];
    stream.forEach(item=>state.process(item));
    const derived=state.snapshot(at(25));
    expect(derived).toEqual(deriveMakerStartupInputs({...f,stream,decision:at(25)}));
    expect(derived.missing).toEqual(["OBSERVED_VOLATILITY_HISTORY","OBSERVED_ORIGINAL_TOKEN_TRADE_FLOW",
      "ORIGINAL_TOKEN_FEE_RATE_BPS","CLOB_MINIMUM_ORDER_SIZE_UNIT_UNRESOLVED",
      "POSITIVE_MINIMUM_ORDER_AGE_APPLICABILITY","POST_ONLY_MAKER_FEE_BOUND"]);
  });

  it("binds metadata once, closes at the original expiry and fails explicitly at the trade retention limit", () => {
    const f=fixture();
    expect(()=>createOperatingSourceState({...f,clobBook:{...f.clobBook,url:"other"}})).toThrow("receipt_url");
    const state=createOperatingSourceState(f,{maxTradesPerSlot:1});
    f.gamma.at.utc = 0;
    state.process(frame(20,trade(20)));
    expect(state.snapshot(at(20)).trades).toHaveLength(1);
    expect(()=>state.snapshot(at(300000))).toThrow("gamma_window_or_rules");
    expect(()=>state.process(frame(21,trade(21)))).toThrow("trade_capacity");
    expect(()=>state.snapshot(at(21))).toThrow("trade_capacity");
    const ended=createOperatingSourceState(fixture());
    expect(()=>ended.process(full(300000))).toThrow("gamma_window_or_rules");
  });
});

const v7 = join(process.cwd(), "reports/evidence/maker-startup-codex-20261123-v7-reanchor");
// Source captures remain machine-local. In environments that retain the V7
// evidence, bind the specific immutable manifest and actual recorded clocks.
it.skipIf(!existsSync(join(v7, "ledger.json")))("matches all 13 retained V7 decision-prefix samples and the independently checked feature", () => {
  const raw = (file: string) => readFileSync(join(v7,file), "utf8");
  const pinned = (filename: string, sha: string) => {
    const body=raw(filename); expect(hash(body)).toBe(sha); return JSON.parse(body);
  };
  const ledger=pinned("ledger.json","61b08cc062091b43127fd61123f337280e90d2a2372bb304b9a7428232ff1ad5");
  const result=pinned("result.json","24766628c65aefc2dd32a18a22f0c4e33a7f113949d72e94c2734178d465e01e");
  const selection=pinned("selection.json","064a95bd1cf6cdc6af8d5fcdf40248212d2b61ba5c095c56dacc556766d22092");
  type Receipt = { name: string; url: string; at: StartupClock; startedAt: StartupClock; httpStatus: number; sha256: string };
  const capture = (name: string) => {
    const receipt=(ledger.reads as Receipt[]).find(x=>x.name===name)!;
    const body=raw(name+".bin"); expect(hash(body)).toBe(receipt.sha256);
    return { url: receipt.url, raw: body, at: receipt.at, startedAt: receipt.startedAt,
      status: receipt.httpStatus, sha256: receipt.sha256 };
  };
  const gamma=capture("metadata"), clobMarket=capture("market"), clobBook=capture("book"), tokenFee=capture("fee");
  const meta={gamma,selection,clobMarket,clobBook,tokenFee,decision:tokenFee.at,originalLabel:selection.selected.outcomes[0].label,topKLevels:200};
  const state=createOperatingSourceState(meta);
  const prefix: BridgeStreamItem[]=[];
  const controls=ledger.controls as {number:number;kind:string;complete:boolean;at:StartupClock;sha256:string}[];
  let i=0, frameCount=0;
  for (const trace of result.traces.slice(0,13)) {
    while (i<controls.length && controls[i]!.at.mono <= trace.at.mono) {
      const rec=controls[i++]!;
      expect(rec.complete && rec.kind==="message").toBe(true);
      const body=raw("frame-"+rec.number+".bin");
      expect(hash(body)).toBe(rec.sha256);
      if(body==="PONG") continue;
      const item={kind:"frame" as const,raw:body,at:rec.at};
      state.process(item); prefix.push(item); frameCount++;
    }
    const item={kind:"sample" as const,at:trace.at};
    state.process(item); prefix.push(item);
    const d=state.snapshot(trace.at);
    expect(d).toEqual(deriveMakerStartupInputs({...meta,stream:prefix,decision:trace.at}));
    expect(d.missing).toEqual(trace.missing);
    expect(d.bookInvalidation).toBe(trace.bookInvalidation);
  }
  expect(frameCount).toBe(6043);
  const captureDigest=hash(JSON.stringify({gamma,selection,clobMarket,clobBook,tokenFee,stream:prefix},null,2)+"\n");
  expect(captureDigest).toBe("96d59d13f25e5145605e1f003e3160af26907bc6783d7c8a2417b08776df4094");
  const last=state.snapshot(prefix[prefix.length-1]!.at);
  expect(last.feature).toEqual(JSON.parse(raw("codex-readiness-source-prefix-check.json")).feature);
  expect(last.trades).toHaveLength(24);
  expect(last.missing).toEqual([]);
}, 30_000);
