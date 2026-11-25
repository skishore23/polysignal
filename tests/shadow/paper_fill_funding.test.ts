import {afterEach,describe,it,expect,vi} from 'vitest';
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {PaperMakerExecution,type PaperMakerPolicy,type PaperBook,type PaperTrade} from '../../apps/worker/src/shadow/PaperMakerExecution';
const START=1800000000000;const opened:Database.Database[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const db of opened.splice(0))db.close()});
function fixture(ahead='0'){
 const db=new Database(':memory:');opened.push(db);db.exec(readFileSync('tests/maker/fixtures/startup-canonical-schema.sql','utf8'));
 db.exec(readFileSync('packages/storage/migrations/0048_accounting_events.sql','utf8'));db.exec(readFileSync('packages/storage/migrations/0049_accounting_reports.sql','utf8'));
 let ms=0;const clock=()=>({utc:START+ms,mono:ms});const policy:PaperMakerPolicy={accountKey:'wallet:7',walletId:7,openingCash:'100',perOrder:'20',maxExposure:'40',maxInventoryShares:'200',submitLatencyMs:100,cancelLatencyMs:0,feeModel:'paper-maker-zero-fee-v1'};
 let engine=new PaperMakerExecution(db,policy,clock);
 const book=(extra:Partial<PaperBook>={}):PaperBook=>({sourceId:'book-'+ms,market:'45',token:'888',tick:'0.01',lot:'0.01',minimumShares:'1',at:clock(),venueUtc:START+ms,bids:ahead==='0'?[{price:'0.49',size:'100'}]:[{price:'0.50',size:ahead}],asks:[{price:'0.61',size:'100'}],...extra});
 engine.observeBook(book());
 const order=(size=10,price=.5,side='BUY')=>Number(db.prepare(`INSERT INTO shadow_orders(ts,wallet_id,token_id,market_id,side,kind,price,size,expected_cancel_ts,execution_mode,status,filled_size,last_update_ts) VALUES(?,7,'888','45',?,?,?,?,?,'SHADOW','OPEN',0,?)`).run(clock().utc,side,side==='BUY'?'MAKER_BID':'MAKER_ASK',price,size,clock().utc+5000,clock().utc).lastInsertRowid);
 const trade=(sourceId:string,size:string,price='0.50',side:'BUY'|'SELL'='SELL',extra:Partial<PaperTrade>={})=>engine.processTrade({sourceId,token:'888',side,price,size,at:clock(),venueUtc:clock().utc,...extra});
 return {db,clock,policy,book,order,trade,get engine(){return engine},at:(n:number)=>{ms=n},reopen:()=>{engine=new PaperMakerExecution(db,policy,clock);engine.observeBook(book())}};
}

// The compatibility call makes the historical-read regression executable against
// the unmodified baseline too; missing new API is not the failure being measured.
const funding=(f:ReturnType<typeof fixture>)=>(f.engine as any).fundingSnapshot?.()??fields(f.engine.snapshot());
const fields=(s:any)=>Object.fromEntries(['cashUSDC','shares','reservedBuyUSDC','reservedSellShares','availableBuyUSDC'].map(k=>[k,s[k]]));
describe('current quote funding without cumulative audit allocations',()=>{
 it('returns current constraints without reading historical execution tables',()=>{
  const f=fixture();f.order();f.at(200);f.trade('some-history','4');
  const expected=fields(f.engine.snapshot());const prepare=f.db.prepare.bind(f.db);const calls:string[]=[];
  vi.spyOn(f.db,'prepare').mockImplementation(((sql:string)=>{calls.push(sql);if(/SELECT \* FROM (shadow_orders|paper_execution_(settlements|queues|trades|allocations))\b/i.test(sql))throw Error('authored forbidden history materialization');return prepare(sql);}) as any);
  expect(funding(f)).toEqual(expected);expect(calls.length).toBeGreaterThan(0);
 });
 it('preserves exact funded partials, reservations and cancellation release',()=>{
  const f=fixture();const a=f.order(),b=f.order();f.at(200);f.trade('partial','6');
  expect(funding(f)).toEqual({cashUSDC:'97.000000000000000000',shares:{'888':'6.000000000'},reservedBuyUSDC:'7.000000000000000000',reservedSellShares:{},availableBuyUSDC:'30.000000000000000000'});
  f.engine.cancel(b,f.clock());expect(funding(f).reservedBuyUSDC).toBe('2.000000000000000000');expect(funding(f).availableBuyUSDC).toBe('35.000000000000000000');
  f.engine.cancel(a,f.clock());expect(funding(f).availableBuyUSDC).toBe('37.000000000000000000');expect(funding(f)).toEqual(fields(f.engine.snapshot()));
 });
 it('preserves held SELL reservations, partial fills and failed over-reservation',()=>{
  const f=fixture();f.order(10,.4);f.at(200);f.trade('buy','10','0.40');const ask=f.order(8,.6,'SELL');
  expect(funding(f).reservedSellShares).toEqual({'888':'8.000000000'});expect(()=>f.order(3,.6,'SELL')).toThrow();
  f.at(400);f.trade('sell','4','0.60','BUY');expect(funding(f).shares).toEqual({'888':'6.000000000'});expect(funding(f).reservedSellShares).toEqual({'888':'4.000000000'});
  f.engine.cancel(ask,f.clock());expect(funding(f).reservedSellShares).toEqual({});expect(funding(f)).toEqual(fields(f.engine.snapshot()));
 });
 it('retains loss-adjusted exposure rather than cash minus reservations alone',()=>{
  const f=fixture();f.order(10,.5);f.at(200);f.trade('buy','10');f.engine.observeBook(f.book({bids:[{price:'0.30',size:'100'}]}));f.order(10,.4,'SELL');f.at(400);f.trade('loss','10','0.40','BUY');
  expect(funding(f).cashUSDC).toBe('99.000000000000000000');expect(funding(f).availableBuyUSDC).toBe('39.000000000000000000');expect(funding(f)).toEqual(fields(f.engine.snapshot()));
 });
 it('does not expand the forty-USDC cap after realized gains',()=>{
  const f=fixture();f.order(10,.4);f.at(200);f.trade('buy','10','0.40');f.order(10,.6,'SELL');f.at(400);f.trade('gain','10','0.60','BUY');
  expect(funding(f).cashUSDC).toBe('102.000000000000000000');expect(funding(f).availableBuyUSDC).toBe('40.000000000000000000');
 });
 it('reads current transaction state and rollback without retaining a mutable funding cache',()=>{
  const f=fixture();const before=funding(f);expect(()=>f.db.transaction(()=>{f.order();expect(funding(f).reservedBuyUSDC).toBe('5.000000000000000000');throw Error('authored rollback');})()).toThrow('authored rollback');expect(funding(f)).toEqual(before);
  f.order();f.at(200);f.trade('fill','6');const after=funding(f);f.reopen();expect(funding(f)).toEqual(after);after.shares['888']='199';expect(funding(f).shares['888']).toBe('6.000000000');
 });
 it('preserves full snapshot key order and all complete audit sections',()=>{
  const f=fixture();f.order();f.at(200);f.trade('full','4');const full=f.engine.snapshot();
  expect(Object.keys(full)).toEqual(['cashUSDC','shares','reservedBuyUSDC','reservedSellShares','availableBuyUSDC','settlements','orders','queues','trades','allocations','finality','actualPaidFees','actualRevenue','forcedFills','syntheticRebalance']);
  expect(fields(full)).toEqual(funding(f));expect(full.orders).toHaveLength(1);expect(full.trades).toHaveLength(1);expect(full.allocations).toHaveLength(1);expect(full.finality).toBe('SIMULATED');
 });
});
