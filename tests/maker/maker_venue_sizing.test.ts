import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MakerLoop } from "../../apps/worker/src/maker/MakerLoop";

const schema = readFileSync(new URL("./fixtures/startup-canonical-schema.sql", import.meta.url), "utf8");
const terms = { minimumShares: "5", minimumNotionalUSDC: "5", shareIncrement: "0.01" };
type Options = { bid: number; target?: number; inventoryLimit?: number; minShares?: string;
  callback?: "absent" | "unmatched"; askEnabled?: boolean };
type OrderRow = { side: string; price: number; size: number; inventory_i_after: number; decision_group_id: string };
type DecisionRow = { kind: string; decision: string; decision_reason: string; size: number; decision_group_id: string };

async function tick(o: Options) {
  const db = new Database(":memory:");
  try {
    db.exec(schema);
    const now = Date.now();
    const market = "btc-5m", token = "original-up";
    db.prepare("INSERT INTO markets(id,question,slug,active,volume,liquidity,updated_at,created_at,minimum_tick_size) VALUES (?,?,?,1,1000,1000,?,?,.01)")
      .run(market, "BTC up in 5 minutes?", "btc-updown-5m-fixture", now, now);
    db.prepare("INSERT INTO tokens(id,market_id,outcome,updated_at,fee_rate_bps) VALUES (?,?, 'Up',?,1000)").run(token,market,now);
    db.prepare("INSERT INTO wallets(id,name,starting_balance,created_at,maker_enabled,auto_trade_enabled,maker_inventory_max_abs) VALUES (1,'fixture',10,?,1,0,?)")
      .run(now,o.inventoryLimit ?? 50);
    db.prepare(`INSERT INTO latest_features(token_id,market_id,ts,mid,spread,best_bid,best_ask,bid_depth_top,ask_depth_top,obi,vol30m,microprice_minus_mid)
      VALUES (?,?,?,?,.02,?,?,100,100,0,.01,0)`).run(token,market,now,o.bid+.01,o.bid,o.bid+.02);
    const event = db.prepare("INSERT INTO clob_events(recv_ts_ms,conn_id,token_id,msg_type,payload_json) VALUES (?,'fixture',?,'trade','{}')");
    event.run(now-100,token); event.run(now-200,token);

    const engine = new MakerLoop({
      intervalMs:10000, enableBidQuotes:true, enableAskQuotes:o.askEnabled ?? false, quoteSize:o.target ?? 10,
      maxNotionalPerOrderUsd:6, maxInventoryAbs:50, minExpectedEvBps:0.1, inventoryLambdaBps:0,
      quoteHalfSpreadBps:8, maxSpread:.03, minDepth:10, slippageBps:1, adverseSelectionBps:1, queueLossBps:1,
      rebateBps:0, rebateShareAssumption:0, liquidityRewardBpsWhenScoring:0, orderTtlMs:5000, priceToleranceBps:10,
      executionMode:"PAPER", marketScope:"PROFILE_KNOWN_ONLY", tradeFlowGate:{enabled:true,lookbackSec:600,minTradeEvents:2,
        mode:"PASSIVE_DECAY",staleCancelAgeSec:45},
    }, {
      sqlite:db, logger:{debug:()=>{}, info:()=>{}, warn:()=>{}} as any,
      belief:{estimate:async()=>({source:"controlled fixture",probability:o.bid+.012})} as any,
      quoteConstraints:o.callback === "absent" ? undefined : (t,m) => t===token && m===market && o.callback!=="unmatched"
        ? {...terms,minimumShares:o.minShares ?? terms.minimumShares} : null,
    });
    await (engine as any).tick();
    const orders = db.prepare("SELECT side,price,size,inventory_i_after,decision_group_id FROM shadow_orders ORDER BY id").all() as OrderRow[];
    const decisions = db.prepare("SELECT kind,decision,decision_reason,size,decision_group_id FROM decision_log ORDER BY id").all() as DecisionRow[];
    for (const order of orders) expect(decisions).toContainEqual(expect.objectContaining({
      decision:"SUBMIT", size:order.size, decision_group_id:order.decision_group_id
    }));
    return { orders, decisions };
  } finally { db.close(); }
}

describe("actual MakerLoop venue-constrained paper sizing", () => {
  it("skips the 10-share target at .49 for the $5 venue minimum, while an independently eligible ask survives", async () => {
    const r = await tick({bid:.49,askEnabled:true});
    expect(r.orders.filter(x=>x.side==="BUY")).toEqual([]);
    expect(r.decisions).toContainEqual(expect.objectContaining({kind:"MAKER_BID",decision:"SKIP",decision_reason:"quote_size:NO_LEGAL_QUOTE_SIZE"}));
    expect(r.orders).toContainEqual(expect.objectContaining({side:"SELL",size:10}));
  });
  it("submits the original 10 shares exactly at the five-dollar boundary", async () => {
    const r = await tick({bid:.50});
    expect(r.orders).toEqual([expect.objectContaining({side:"BUY",price:.50,size:10,inventory_i_after:10})]);
  });
  it("uses the actual floored quantity for order, decision and inventory after", async () => {
    const r = await tick({bid:.49,target:20});
    expect(r.orders).toEqual([expect.objectContaining({price:.49,size:12.24,inventory_i_after:12.24})]);
    const byRoom = await tick({bid:.49,target:20,inventoryLimit:10.219});
    expect(byRoom.orders).toEqual([expect.objectContaining({price:.49,size:10.21,inventory_i_after:10.21})]);
  });
  it("skips infeasible share or inventory constraints and unmatched source identity", async () => {
    for (const [input,reason] of [
      [{bid:.50,minShares:"10.01"},"NO_LEGAL_QUOTE_SIZE"],
      [{bid:.49,target:20,inventoryLimit:10.2},"NO_LEGAL_QUOTE_SIZE"],
      [{bid:.50,callback:"unmatched"},"INVALID_QUOTE_SIZING_INPUT"],
    ] as const) {
      const r = await tick(input);
      expect(r.orders).toEqual([]);
      expect(r.decisions).toContainEqual(expect.objectContaining({kind:"MAKER_BID",decision:"SKIP",decision_reason:"quote_size:"+reason}));
    }
  });
  it("preserves original sizing and original sub-minimum behavior without the optional callback", async () => {
    const unbounded = await tick({bid:.49,target:20,callback:"absent"});
    expect(unbounded.orders).toEqual([expect.objectContaining({price:.49,size:6/.49})]);
    const small = await tick({bid:.49,callback:"absent"});
    expect(small.orders).toEqual([expect.objectContaining({price:.49,size:10})]);
  });
});
