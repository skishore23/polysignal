import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveMakerStartupInputs, type MakerStartupSourceInput, type BridgeStreamItem } from "../../scripts/research/maker_startup_source_bridge";

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
function changeRaw(c: {raw:string}, mutate: (row: any) => void) {
  const row = JSON.parse(c.raw); mutate(row); c.raw = JSON.stringify(row);
}

function changeGamma(f: MakerStartupSourceInput, mutate: (row: any) => void) {
  changeRaw(f.gamma, rows => mutate(rows[0]));
  (f.selection as { raw_body_sha256: string }).raw_body_sha256 = hash(f.gamma.raw);
}
function v2fixture() {
  const f = fixture();
  changeGamma(f, row => Object.assign(row, { version:"v2", clobTokenIds:'["1000","2000"]',
    positionIds:["999","888"], enableOrderBook:true, orderMinSize:6, feesEnabled:true,
    feeSchedule:{rate:0.05,exponent:1,takerOnly:true,rebateRate:0.25} }));
  f.clobMarket.url = url + "/clob-markets/" + condition;
  f.clobMarket.raw = JSON.stringify({ t:[{o:"Up",t:token},{o:"Down",t:"999"}], mos:5, mts:0.01,
    tbf:9, fd:{r:0.05,e:1,to:true}, oas:0 });
  changeRaw(f.clobBook, b => b.version = "v2");
  return f;
}

describe("original-token maker source bridge", () => {
  it("preserves labels, top-K and observed clock; distinguishes null history from zero volatility", () => {
    const r = deriveMakerStartupInputs(fixture());
    expect(r.identity).toMatchObject({token, label: "Up", outcomes: [{label:"Down",token:"999"}, {label:"Up",token}]});
    expect(r.feature).toMatchObject({marketId: market, tokenId: token, ts:start+12, bidDepthTop:10, askDepthTop:12,
      bestBid:0.47, bestAsk:0.54, r10s:null, vol30m:null});
    expect(r.missing).toEqual(["OBSERVED_VOLATILITY_HISTORY","OBSERVED_ORIGINAL_TOKEN_TRADE_FLOW"]);
    expect(r.book).toMatchObject({minimum:"5",lot:"0.01",venueUtc:start+10});
    expect(r.fee?.perShareUSDC).toBe("0");
  });
  function slotFixture() {
    const f = v2fixture();
    const row = JSON.parse(f.gamma.raw)[0];
    f.gamma.raw = JSON.stringify(row, null, 2) + "\n";
    f.gamma.url = "https://gamma-api.polymarket.com/markets/slug/" + row.slug;
    (f.selection as { raw_body_sha256: string }).raw_body_sha256 = hash(f.gamma.raw);
    return f;
  }
  it("binds the exact Gamma slot object, original bytes and V2 position to the current five-minute market", () => {
    const f = slotFixture(), r = deriveMakerStartupInputs(f);
    expect(r.identity).toMatchObject({market, condition, slug:"btc-updown-5m-"+start/1000, protocolVersion:"v2", token});
    expect(r.sourceHashes.gamma).toBe(hash(f.gamma.raw));
    expect(r.sourceHashes.gamma).not.toBe(hash(JSON.stringify([JSON.parse(f.gamma.raw)])));
  });
  const invalidSlots: [string,(f:MakerStartupSourceInput)=>void,string][] = [
    ["other slot URL",f=>{f.gamma.url=f.gamma.url.replace(String(start/1000),String(start/1000+300));},"receipt_url"],
    ["arbitrary URL query",f=>{f.gamma.url+="?x=1";},"receipt_url"],
    ["slot row slug mismatch",f=>{changeRaw(f.gamma,row=>row.slug="btc-updown-5m-"+(start/1000-300));},"gamma_slot_slug"],
    ["array served from slot URL",f=>{f.gamma.raw=JSON.stringify([JSON.parse(f.gamma.raw)]);},"object_required"],
    ["object served from legacy list URL",f=>{f.gamma.url=fixture().gamma.url;},"gamma_selection_shape"],
    ["nonzero slot row index",f=>{(f.selection as {selected:{raw_row_index:number}}).selected.raw_row_index=1;},"gamma_slot_row_index"],
  ];
  it.each(invalidSlots)("rejects %s", (_label, mutate, reason) => {
    const f = slotFixture(); mutate(f);
    (f.selection as {raw_body_sha256:string}).raw_body_sha256=hash(f.gamma.raw);
    expect(()=>deriveMakerStartupInputs(f)).toThrow(reason);
  });
  it("derives real rolling returns from chronologically sampled source books and preserves public trades", () => {
    const input = fixture();
    const stream = [...input.stream];
    for (let i = 1; i <= 12; i++) {
      const ms = i * 1000 + 12;
      stream.push(frame(ms, [{ ...snapshot(ms, i === 11 ? "0.49" : "0.47"), event_type:"book" }]), {kind:"sample",at:at(ms)});
    }
    stream.push(frame(12013, trade(12013)));
    const r = deriveMakerStartupInputs({...input, stream, decision:at(12013)});
    expect(r.missing).toEqual([]);
    expect(r.feature?.vol30m).toBeGreaterThan(0);
    expect(r.feature?.r1m).toBeNull();
    expect(r.trades).toMatchObject([{ token, venueUtc:start+12013, price:0.51, size:5, side:"BUY" }]);
    expect(r.feeRateBps).toBe(35);
  });
  it("retains missing token rate and maker fee bound even when a trade reports a fee", () => {
    const f = fixture(); delete f.tokenFee;
    f.stream = [...f.stream, frame(12, trade(12))];
    const r = deriveMakerStartupInputs(f);
    expect(r.feeRateBps).toBeNull(); expect(r.fee).toBeNull();
    expect(r.missing).toContain("ORIGINAL_TOKEN_FEE_RATE_BPS");
  });
  it("only revalidates an unusable delta on another complete current snapshot and feature sample", () => {
    const f = fixture(), delta = frame(99,{event_type:"price_change",market:condition});
    const partial = deriveMakerStartupInputs({...f,stream:[...f.stream,delta], decision:at(99)});
    expect(partial.missing).toContain("FRESH_AUTHORITATIVE_ORIGINAL_BOOK");
    const newer = frame(1012,{...snapshot(1012,"0.49"),event_type:"book"});
    const pending = deriveMakerStartupInputs({...f,stream:[...f.stream,delta,newer], decision:at(1012)});
    expect(pending.missing).toContain("CURRENT_CANONICAL_FEATURE_SAMPLE");
    const r = deriveMakerStartupInputs({...f,stream:[...f.stream,delta,newer,{kind:"sample",at:at(1012)}],decision:at(1012)});
    expect(r.missing).not.toContain("CURRENT_CANONICAL_FEATURE_SAMPLE"); expect(r.book.bid).toBe("0.49");
  });
  it("uses original V2 position labels, compact CLOB parameters and two dimensioned minimums", () => {
    const r = deriveMakerStartupInputs(v2fixture());
    expect(r.identity).toMatchObject({protocolVersion:"v2", token, label:"Up",minimumNotional:"6",
      feeSchedule:{rate:"0.05",exponent:1,takerOnly:true,rebateRate:"0.25"}});
    expect(r.book).toMatchObject({minimum:"6",minimumUnit:"USDC_NOTIONAL",minimumShares:"5",marketMinimum:"5"});
    expect(r.clobFeeCurve).toEqual({rate:"0.05",exponent:1,takerOnly:true});
    expect(r.makerBaseFee).toBeNull(); expect(r.takerBaseFee).toBe(9); expect(r.feeRateBps).toBe(35);
    expect(r.fee?.perShareUSDC).toBe("0");
    expect(r.missing).toEqual(["OBSERVED_VOLATILITY_HISTORY","OBSERVED_ORIGINAL_TOKEN_TRADE_FLOW"]);
  });
  it("V2 WS book may omit the REST-only version marker after the REST asset is bound", () => {
    const f = v2fixture();
    const r = deriveMakerStartupInputs({...f, decision:at(1012), stream:[...f.stream,
      frame(1012,{...snapshot(1012,"0.49"),event_type:"book"}),{kind:"sample",at:at(1012)}]});
    expect(r.feature?.bestBid).toBe(0.49);
  });
  it("preserves source uncertainty when the minimum order age or unlabeled minimum might bind", () => {
    const f = v2fixture(); changeRaw(f.clobMarket,m=>{m.oas=9; m.mos=7;});
    const r = deriveMakerStartupInputs(f);
    expect(r.orderAgeSeconds).toBe(9);
    expect(r.missing).toEqual(expect.arrayContaining(["POSITIVE_MINIMUM_ORDER_AGE_APPLICABILITY","CLOB_MINIMUM_ORDER_SIZE_UNIT_UNRESOLVED"]));
  });
  it.each([true, false, null])("applies the legacy market's explicit payer rule with 1000 bps base fees (takerOnly=%s)", (takerOnly) => {
    const f = fixture();
    changeGamma(f, row => {
      row.feesEnabled = true;
      if (takerOnly !== null) row.feeSchedule = {rate:0.05, exponent:1, takerOnly, rebateRate:0.2};
    });
    changeRaw(f.clobMarket, row => {
      row.maker_base_fee = 1000;
      row.taker_base_fee = 1000;
    });
    f.tokenFee!.raw = '{"base_fee":1000}';
    const r = deriveMakerStartupInputs(f);
    expect([r.makerBaseFee, r.takerBaseFee, r.feeRateBps]).toEqual([1000,1000,1000]);
    expect(r.book).toMatchObject({minimum:"5",minimumUnit:"USDC_NOTIONAL",minimumShares:"5"});
    if (takerOnly === true) {
      expect(r.fee?.perShareUSDC).toBe("0");
      expect(r.fee?.provenance).toContain("feeSchedule.takerOnly=true");
      expect(r.missing).not.toContain("POST_ONLY_MAKER_FEE_BOUND");
      delete f.tokenFee;
      expect(deriveMakerStartupInputs(f).fee).toBeNull();
    } else {
      expect(r.fee).toBeNull();
      expect(r.missing).toContain("POST_ONLY_MAKER_FEE_BOUND");
    }
  });
  it("does not infer a maker fee bound from the independent position fee or from an ambiguous schedule", () => {
    const f = v2fixture();
    changeRaw(f.clobMarket,m=>m.fd.to=false);
    changeGamma(f,g=>g.feeSchedule.takerOnly=false);
    const r = deriveMakerStartupInputs(f);
    expect(r.feeRateBps).toBe(35); expect(r.fee).toBeNull();
    expect(r.missing).toContain("POST_ONLY_MAKER_FEE_BOUND");
  });
  it("rejects conflicting complete V2 source facts", () => {
    const cases: [(f:MakerStartupSourceInput)=>void,string][] = [
      [f=>changeRaw(f.clobMarket,m=>m.t[0].t="2000"),"clob_token_mapping"],
      [f=>changeGamma(f,g=>g.positionIds=JSON.stringify(g.positionIds)),"v2_position_ids_required"],
      [f=>{const ambiguous="0"+token;changeGamma(f,g=>g.positionIds[1]=ambiguous);
        (f.selection as {selected:{outcomes:{token_id:string}[]}}).selected.outcomes[1]!.token_id=ambiguous;},"original_outcome_mapping"],
      [f=>changeRaw(f.clobBook,b=>delete b.version),"unsupported_book_version"],
      [f=>{f.clobMarket.url=url+"/markets/"+condition;},"receipt_url"],
      [f=>changeRaw(f.clobMarket,m=>m.fd.r=0.5),"conflicting_fee_curves"],
      [f=>changeRaw(f.clobMarket,m=>m.fd.to=false),"conflicting_fee_curves"],
      [f=>changeGamma(f,g=>g.orderPriceMinTickSize=0.1),"tick_or_minimum"],
      [f=>changeRaw(f.clobMarket,m=>m.tbf=0.5),"market_base_fee"],
      [f=>changeRaw(f.clobMarket,m=>m.oas="0"),"clob_minimum_order_age"],
      [f=>changeGamma(f,g=>delete g.orderMinSize),"gamma_trading_constraints"],
    ];
    for (const [mutate,reason] of cases) {
      const f = v2fixture(); mutate(f); expect(()=>deriveMakerStartupInputs(f)).toThrow(reason);
    }
  });
  const invalid: [string, (f: MakerStartupSourceInput) => void, string][] = [
    ["Gamma digest",f=>{f.gamma.raw += " ";},"gamma_selection_binding"],
    ["V2 Gamma with legacy IDs populated",f=>{changeRaw(f.gamma,rows=>rows[0].version="v2"); (f.selection as {raw_body_sha256:string}).raw_body_sha256=hash(f.gamma.raw);},"v2_position_ids_required"],
    ["unknown Gamma version",f=>{changeGamma(f,r=>r.version="v3");},"unsupported_gamma_market_version"],
    ["foreign outcome",f=>{f.originalLabel="Yes";},"original_label_absent"],
    ["substituted outcome",f=>{changeRaw(f.clobMarket,m=>m.tokens.reverse()[0].token_id=token);},"clob_token_mapping"],
    ["wrong fee route",f=>{f.tokenFee!.url += "9";},"receipt_url"],
    ["conflicting fee aliases",f=>{f.tokenFee!.raw='{"base_fee":35,"fee_rate_bps":0}';},"fee_rate_schema"],
    ["boolean fee",f=>{f.tokenFee!.raw='{"base_fee":false}';},"fee_rate_schema"],
    ["V2 position masquerading as CTF",f=>{changeRaw(f.clobBook,b=>b.version="v2");},"unsupported_book_version"],
    ["foreign book",f=>{changeRaw(f.clobBook,b=>b.asset_id="999");},"book_identity"],
    ["tick mismatch",f=>{changeRaw(f.clobBook,b=>b.tick_size="0.001");},"book_market_limits"],
    ["off grid",f=>{changeRaw(f.clobBook,b=>b.bids[0].price="0.431");},"price_grid"],
    ["zero depth",f=>{changeRaw(f.clobBook,b=>b.bids[1].size="0");},"duplicate_or_empty_level"],
    ["crossed",f=>{changeRaw(f.clobBook,b=>b.asks[0].price="0.47");},"crossed_book"],
    ["future venue time",f=>{changeRaw(f.clobBook,b=>b.timestamp=String(start+13));},"future_venue_time"],
    ["unsampled fake warmup",f=>{f.stream=[...f.stream,...f.stream];},"sample_cadence"],
    ["wrong trade token",f=>{f.stream=[frame(12,{...trade(12),asset_id:"999"})];},"trade_identity_or_side"],
    ["duplicate trade",f=>{f.stream=[frame(12,[trade(12),trade(12)])];},"ambiguous_duplicate_trade"],
    ["unknown event",f=>{f.stream=[frame(12,{event_type:"tick_size_change",market:condition})];},"unsupported_stream_event"],
    ["disconnect",f=>{f.stream=[{kind:"disconnect",at:at(12)}];},"stream_disconnected"],
    ["future receipt",f=>{f.decision=at(11);},"causal_clocks"],
  ];
  it.each(invalid)("%s", (_name, mutate, why) => {
    const input = fixture(); mutate(input); expect(()=>deriveMakerStartupInputs(input)).toThrow(why);
  });
});
