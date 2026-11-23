import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { MakerLoop } from "../../apps/worker/src/maker/MakerLoop";
import { createIsolatedMaker, installStartupSink, newIsolatedStartupDatabase,
  type PaperProfile, type StartupClock, type StartupContract } from "../../scripts/research/maker_quote_startup";

const schema = readFileSync("tests/maker/fixtures/startup-canonical-schema.sql", "utf8");
const files: { db: Database.Database; dir: string }[] = [];
const t = 1_800_000_000_000;
const at = (offset: number) => ({utc: t + offset, mono: 12345 + offset});
const token = "paper-up", market = "paper-slot";
afterEach(() => {
  vi.restoreAllMocks();
  for (const {db, dir} of files.splice(0)) { db.close(); rmSync(dir, {recursive:true}); }
});

function fixture(profile: PaperProfile = "OPERATING_BURST_V1", venueOffset = 0, fee = "0") {
  const dir = mkdtempSync(resolve("reports/evidence/operating-policy-test-"));
  const db = newIsolatedStartupDatabase(join(dir,"test.sqlite"), schema);
  files.push({db,dir});
  const contract: StartupContract = {
    purpose:"SYNTHETIC_OFFLINE_ENGINEERING", paperProfile:profile, wallet:1, market, condition:"fixture-condition",
    tokens:[token,"paper-down"], book:{ token, bid:"0.49", ask:"0.51", tick:"0.01", lot:"0.01", minimum:"5",
      minimumUnit:"USDC_NOTIONAL", minimumShares:"5", receipt:at(0), venueUtc:t+venueOffset,
      valid:true, sourceHash:"a".repeat(64) }, fee:{perShareUSDC:fee,provenance:"authored paper test bound"},
  };
  let clock = at(0);
  const sink = installStartupSink(db,contract,()=>({...clock}));
  function setTime(offset: number) { clock=at(offset); }
  const cfg = JSON.parse(readFileSync("configs/worker.json","utf8")); cfg.executionMode="PAPER";
  const logs: {level:string; fields:any; message: string}[] = [];
  const logger = Object.fromEntries(["info","warn","error","debug","trace","fatal"].map(level =>
    [level,(fields:any,message:string)=>logs.push({level,fields,message})]));
  function plant(id: string, price: number, size: number) {
    db.transaction(() => {
      db.prepare(`INSERT INTO shadow_orders(ts,wallet_id,market_id,token_id,side,kind,price,size,expected_cancel_ts,
        execution_mode,source,client_order_id,decision_group_id,status,filled_size,last_update_ts,strategy_lane,decision)
        VALUES (?,1,?,?,'BUY','MAKER_BID',?,?,?,'SHADOW','maker_loop',?,?,'OPEN',0,?,'MAKER','SUBMIT')`)
        .run(clock.utc,market,token,price,size,clock.utc+5000,id,id,clock.utc);
      db.prepare(`INSERT INTO decision_log(ts,token_id,wallet_id,kind,strategy_lane,decision_group_id,decision,size)
        VALUES (?,?,1,'MAKER_BID','MAKER',?,'SUBMIT',?)`).run(clock.utc,token,id,size);
    })();
  }
  function maker() { return createIsolatedMaker(db,cfg,logger); }
  function seed() {
    db.prepare(`INSERT INTO markets(id,condition_id,question,slug,created_at,updated_at,active,volume,liquidity,
      minimum_tick_size,minimum_order_size,taker_base_fee)
      VALUES (?,?,'BTC up or down 5 minute fixture','btc-updown-5m-fixture',?,?,1,1000,1000,.01,5,.1)`)
      .run(market,contract.condition,t,t);
    db.prepare("INSERT INTO tokens(id,market_id,outcome,updated_at,fee_rate_bps) VALUES (?,?,'Up',?,2500)").run(token,market,t);
    db.prepare(`INSERT INTO wallets(id,name,starting_balance,created_at,maker_enabled,auto_trade_enabled,maker_inventory_max_abs)
      VALUES (1,'Explicit paper fixture',100,?,1,0,200)`).run(t);
    db.prepare(`INSERT INTO latest_features(token_id,market_id,ts,mid,spread,best_bid,best_ask,bid_depth_top,ask_depth_top,
      obi,vol30m,microprice_minus_mid) VALUES (?,?,?,.5,.02,.49,.51,100,100,.8,.01,0)`).run(token,market,t);
    db.prepare(`INSERT INTO clob_events(recv_ts_ms,conn_id,token_id,msg_type,payload_json)
      VALUES (?,'fixture',?,'trade','{}')`).run(t,token);
    vi.spyOn(Date,"now").mockImplementation(()=>clock.utc);
  }
  return {db, sink, plant, contract, setTime, cfg, maker, seed, logs};
}

describe("operating paper account and actual maker policy", () => {
  it("rejects excess fee-inclusive order liability and aggregate exposure before either SQL row persists", () => {
    const f=fixture("OPERATING_BURST_V1",0,"0.1");
    // 50 × (.30 principal + .10 reserved fee) = 20 per order.
    expect(()=>f.plant("too-large",.30,50.01)).toThrow("order_cap");
    f.plant("one",.30,50); f.plant("two",.30,50);
    expect(()=>f.plant("over-total",.30,20)).toThrow("aggregate_pending_loss");
    const s=f.sink.snapshot();
    expect(s.orders).toHaveLength(2); expect(s.decisions).toHaveLength(2);
    expect(s.opening.cashUSDC).toBe("100");
    expect(s.pendingLiabilityNumerator).toBe(String(40n*10n**18n));
    expect(s.fills).toHaveLength(0);
    expect(f.sink.cancelAll()).toMatchObject({syntheticCashUSDC:"100",pendingLiabilityUSDC:"0",profitUSDC:null});
  });
  it("enforces the 200-share aggregate even when valid 5-USDC orders fit the cash and liability caps", () => {
    const f=fixture();
    f.plant("one",.10,100); f.plant("two",.10,100);
    expect(()=>f.plant("over-stock",.1,50)).toThrow("pending_inventory_cap");
    const s=f.sink.snapshot();
    expect(s.orders).toHaveLength(2); expect(s.pendingLiabilityNumerator).toBe(String(20n*10n**18n));
    expect(f.sink.cancelAll().pendingLiabilityUSDC).toBe("0");
  });
  it("checks total venue age at actual commit, including processing after the receipt", () => {
    const f=fixture("OPERATING_BURST_V1",-900);
    f.setTime(100); f.plant("exact-second",.5,10);
    f.setTime(200);
    expect(()=>f.plant("too-old",.5,10)).toThrow("total_venue_age");
    expect(f.sink.snapshot().precommitChecks).toHaveLength(1);
    expect(f.sink.snapshot().orders).toHaveLength(1);
    expect(f.sink.rejections[0]?.clock).toEqual(at(200));
  });
  it("refreshes a pending operating observation only under identical market, risk and fee terms", () => {
    const f=fixture();
    f.plant("resting",.5,10);
    const next=structuredClone(f.contract);
    Object.assign(next.book,{bid:"0.48",sourceHash:"b".repeat(64),receipt:at(10),venueUtc:t+10});
    f.setTime(10); f.sink.updateObservation(next);
    const frozenTerms=[{...next,fee:{...next.fee!,perShareUSDC:"0.1"}},
      {...next,market:"another"}, {...next,book:{...next.book,minimumShares:"1"}}];
    for(const value of frozenTerms) expect(()=>f.sink.updateObservation(value)).toThrow("observation_identity_or_terms_change");
    expect(f.sink.snapshot().pendingLiabilityNumerator).toBe(String(5n*10n**18n));
    expect(f.sink.snapshot().observations).toHaveLength(2);
    const old=fixture("OWNER_6_USDC"); old.plant("resting",.5,10);
    expect(()=>old.sink.updateObservation(old.contract)).toThrow("observation_with_pending_liability");
  });
  it("releases reservations on shutdown after a backward clock while retaining the original commit timestamp", () => {
    const f=fixture();
    f.setTime(100); f.plant("q",.50,10); f.setTime(-300);
    const terminal=f.sink.cancelAll(), s=f.sink.snapshot();
    expect(s.orders).toEqual([expect.objectContaining({status:"CANCELLED",last_update_ts:t+100})]);
    expect(s.precommitChecks.map((x: {clock:StartupClock})=>x.clock)).toEqual([at(100)]);
    expect(terminal).toMatchObject({syntheticCashUSDC:"100",pendingLiabilityUSDC:"0",fills:0,paidFeesUSDC:null});
  });

  it("persists the chosen quantity's 50 bps per full 200-share capacity and preserves the zero-fill account", async () => {
    const f=fixture(); f.seed();
    const engine=f.maker(); await engine.tick();
    expect(engine.getGateDiagnostics().loaded).toBe(true);
    const s=f.sink.snapshot();
    expect(s.orders).toHaveLength(1);
    const order=s.orders[0] as any;
    expect(order.status).toBe("OPEN");
    expect(order.inventory_delta_abs).toBe(order.size);
    expect(order.inventory_penalty_bps).toBeCloseTo(50*order.size/200,12);
    expect(order.inventory_penalty_bps).toBeGreaterThan(0);
    expect(s.decisions).toContainEqual(expect.objectContaining({decision:"SUBMIT",decision_group_id:order.decision_group_id,size:order.size}));
    expect(s.fills).toHaveLength(0);
  });

  it("persists the same penalty when both admitted quantity and inventory capacity double", async () => {
    const rows: {size:number; inventory_penalty_bps:number}[] = [];
    for (const capacity of [100,200]) {
      const f=fixture(); f.seed();
      const engine=new MakerLoop({
        ...f.cfg.makerEv, ...f.cfg.fees, executionMode:"PAPER", intervalMs:1000, orderTtlMs:5000,
        enableBidQuotes:true, enableAskQuotes:false, priceToleranceBps:8, marketScope:"PROFILE_KNOWN_ONLY",
        minExpectedEvBps:0.1, inventoryPenaltyCapacityShares:capacity, inventoryLambdaBps:50,
        maxNotionalPerOrderUsd:20, rebateShareAssumption:0, liquidityRewardBpsWhenScoring:0,
      },{
        sqlite:f.db, logger:{debug:()=>{},info:()=>{},warn:()=>{}} as any,
        belief:{estimate:async()=>({source:"authored paired policy fixture",probability:.515})} as any,
        quoteConstraints:()=>({minimumShares:"5",minimumNotionalUSDC:"5",shareIncrement:"0.01",
          feePerShareUSDC:"0",budgetUSDC:capacity/20,availableLiabilityUSDC:"20"}),
      });
      await (engine as any).tick();
      expect(f.sink.snapshot().orders).toHaveLength(1);
      rows.push(f.db.prepare("SELECT size,inventory_penalty_bps FROM shadow_orders").get() as typeof rows[number]);
    }
    expect(rows.map(row=>row.size)).toEqual([10,20]);
    expect(rows.map(row=>row.inventory_penalty_bps)).toEqual([5,5]);
  });

  it.each(["ev","market"] as const)("cancels a resting bid when the actual %s gate blocks its next evaluation", async which => {
    const f=fixture(); f.seed(); await f.maker().tick();
    expect(f.sink.snapshot().orders).toEqual([expect.objectContaining({status:"OPEN"})]);
    f.setTime(100);
    if(which==="ev") f.cfg.makerEv.minExpectedEvBps=100000;
    else f.db.prepare("UPDATE wallets SET market_filter_json=? WHERE id=1").run(JSON.stringify({version:1,excludeMarketIds:[market]}));
    await f.maker().tick();
    const s=f.sink.snapshot();
    expect(s.orders).toEqual([expect.objectContaining({status:"CANCELLED",last_update_ts:t+100})]);
    expect(s.decisions).toContainEqual(expect.objectContaining({decision:"SKIP",decision_reason:"operating_"+which+"_block"}));
    expect(s.pendingLiabilityNumerator).toBe("0");
  });

  it.each([80,96])("sizes a replacement by releasing its own reservation while retaining the other %i shares", async other => {
    const f=fixture(); f.seed();
    // Two equally sized resting rows make the test independent of SQLite scan order.
    f.plant("old-a",.10,other); f.plant("old-b",.10,other);
    f.setTime(50); await f.maker().tick();
    const s=f.sink.snapshot(), orders=s.orders as any[];
    const previous=orders.filter(o=>o.client_order_id==="old-a"||o.client_order_id==="old-b");
    expect(previous.map(o=>o.status).sort()).toEqual(["CANCELLED","OPEN"]);
    const sizing=f.logs.find(x=>x.message==="maker_budget_sizing" && x.fields.side==="BUY")?.fields.sizing;
    expect(sizing.audit.maximumLegalShares).toBe(String(100-other));
    if(other===80){
      const replacement=orders.find(o=>!previous.includes(o));
      expect(replacement).toBeDefined(); expect(replacement.status).toBe("OPEN");
      expect(replacement.size).toBeGreaterThanOrEqual(5/replacement.price);
      expect(s.decisions).toContainEqual(expect.objectContaining({decision:"SUBMIT",decision_group_id:replacement.decision_group_id}));
    } else {
      expect(orders).toHaveLength(2);
      expect(sizing.reason).toBe("NO_LEGAL_QUOTE_SIZE");
      expect(s.decisions).toContainEqual(expect.objectContaining({decision:"SKIP",decision_reason:"quote_size:NO_LEGAL_QUOTE_SIZE"}));
    }
  });
});
