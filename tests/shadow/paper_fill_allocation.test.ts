import {afterEach,describe,it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {PaperMakerExecution,type PaperMakerPolicy,type PaperBook,type PaperTrade} from '../../apps/worker/src/shadow/PaperMakerExecution';
const START=1800000000000;const opened:Database.Database[]=[];
afterEach(()=>{for(const db of opened.splice(0))db.close()});
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
describe('declared risk-adverse conserving paper maker execution, authored data only',()=>{
 it('allocates one SELL6 across two BUY10 orders once, FIFO, rather than manufacturing12',()=>{
  const f=fixture(),a=f.order(),b=f.order();f.at(200);expect(f.trade('one','6').allocatedShares).toBe('6.000000000');
  const s=f.engine.snapshot();expect(s.orders.map((o:any)=>[o.id,o.status,o.filled_size])).toEqual([[a,'PARTIAL',6],[b,'OPEN',0]]);
  expect(s.cashUSDC).toBe('97.000000000000000000');expect(s.shares).toEqual({'888':'6.000000000'});expect(s.reservedBuyUSDC).toBe('7.000000000000000000');
  expect(s.availableBuyUSDC).toBe('30.000000000000000000');expect(f.trade('one','6').duplicate).toBe(true);expect(f.engine.snapshot()).toEqual(s);
 });
 it('depletes one shared external queue and ignores snapshot/cancellation quantity as queue advancement',()=>{
  const f=fixture('5'),a=f.order(),b=f.order();f.at(200);f.engine.observeBook(f.book({bids:[{price:'0.50',size:'1'}]}));
  expect(f.trade('t1','6')).toMatchObject({aheadConsumedShares:'5.000000000',allocatedShares:'1.000000000'});
  f.at(300);f.trade('t2','12');const s=f.engine.snapshot();expect(s.orders.map((o:any)=>o.filled_size)).toEqual([10,3]);
  expect(s.allocations.map((a:any)=>a.order_id)).toEqual([a,a,b]);expect(s.cashUSDC).toBe('93.500000000000000000');
 });
 it('cannot fill before100ms activation, at cancellation or by backdating after cancel',()=>{
  const f=fixture(),a=f.order();f.at(99);expect(f.trade('early','10').allocatedShares).toBe('0.000000000');
  f.at(100);f.engine.cancel(a,f.clock());expect(f.trade('cancel-tie','10').allocatedShares).toBe('0.000000000');
  f.at(150);expect(f.trade('late-old','10','0.50','SELL',{venueUtc:START+100}).allocatedShares).toBe('0.000000000');expect(f.engine.snapshot().cashUSDC).toBe('100.000000000000000000');
 });
 it('activation tie100ms is eligible and partial cancel releases only the unfilled reservation',()=>{
  const f=fixture(),a=f.order();f.at(100);f.trade('partial','4');expect(f.engine.snapshot().reservedBuyUSDC).toBe('3.000000000000000000');
  f.at(101);f.engine.cancel(a,f.clock());const s=f.engine.snapshot();expect(s.reservedBuyUSDC).toBe('0.000000000000000000');expect(s.shares['888']).toBe('4.000000000');expect(s.cashUSDC).toBe('98.000000000000000000');
 });
 it('retains filled cash, shares, remaining orders and source identity through restart',()=>{
  const f=fixture('3');f.order();f.at(200);f.trade('original','5');const before=f.engine.snapshot();f.reopen();expect(f.engine.snapshot()).toEqual(before);
  expect(f.trade('original','5').duplicate).toBe(true);expect(()=>f.trade('original','6')).toThrow('trade_identity_conflict');
  f.at(300);f.trade('next','2');expect(f.engine.snapshot().shares['888']).toBe('4.000000000');expect((f.db.prepare('SELECT COUNT(*) n FROM accounting_events WHERE kind=\'OPENING\'').get() as any).n).toBe(1);
 });
 it('rolls back cursor, queue, cash, order, fill and accounting together on an injected posting failure',()=>{
  const f=fixture('2');f.order();const before=f.engine.snapshot();f.db.exec("CREATE TRIGGER authored_fail BEFORE INSERT ON accounting_events WHEN NEW.kind='FILL' BEGIN SELECT RAISE(ABORT,'authored failure'); END;");
  f.at(200);expect(()=>f.trade('crash','5')).toThrow('authored failure');expect(f.engine.snapshot()).toEqual(before);
  f.db.exec('DROP TRIGGER authored_fail');expect(f.trade('crash','5').allocatedShares).toBe('3.000000000');expect(f.engine.snapshot().trades).toHaveLength(1);
 });
 it('agrees with a separately written literal quantity/cash ledger across a conserving stream',()=>{
  const f=fixture('7');f.order(10);f.order(12);f.order(8);let ahead=7n,cash=10000n,held=0n;const remaining=[10n,12n,8n];
  for(const [i,q] of [3n,9n,2n,15n,20n].entries()){f.at(100+i*100);const result=f.trade('literal-'+i,q.toString());let budget=q;const take=budget<ahead?budget:ahead;budget-=take;ahead-=take;let allocated=0n;
   for(let n=0;n<remaining.length;n++){const fill=budget<remaining[n]!?budget:remaining[n]!;remaining[n]=remaining[n]!-fill;budget-=fill;allocated+=fill;cash-=fill*50n;held+=fill;}
   const s=f.engine.snapshot();expect(result.allocatedShares).toBe(allocated.toString()+'.000000000');expect(Number(s.cashUSDC)).toBe(Number(cash)/100);expect(Number(s.shares['888']??0)).toBe(Number(held));
   expect(s.orders.map((o:any)=>BigInt(o.size-o.filled_size))).toEqual(remaining);
  }
 });
 it('supports funded held-inventory sells and canonical partial-close basis without inventing profit',()=>{
  const f=fixture();f.order(10,.4);f.at(200);f.trade('buy','10','0.40');f.order(4,.6,'SELL');f.at(400);f.trade('sell','4','0.60','BUY');
  const s=f.engine.snapshot();expect(s.cashUSDC).toBe('98.400000000000000000');expect(s.shares['888']).toBe('6.000000000');
  expect(()=>f.order(7,.6,'SELL')).toThrow();const report=f.engine.terminalReport({valuationTs:f.clock().utc});expect(report.realizedVenueProfit).toBeNull();expect(report.accounting.complete).toBe(false);expect(report.accounting.netPnl).toBeNull();
 });
 it('rejects unsupported policy, crossing, unfunded inventory, excess order/exposure and unauthorized synthetic fills',()=>{
  const f=fixture();expect(()=>f.order(1,.5,'SELL')).toThrow();expect(()=>f.order(1,.61)).toThrow();expect(()=>f.order(41,.5)).toThrow();
  f.order(40,.5);f.order(40,.5);expect(()=>f.order(1,.5)).toThrow();expect(()=>f.db.prepare("INSERT INTO shadow_fills(ts,order_id,price,size,method) VALUES(?,1,.5,1,'synthetic_fill')").run(f.clock().utc)).toThrow();
  expect(()=>new PaperMakerExecution(f.db,{...f.policy,submitLatencyMs:0},f.clock)).toThrow('model_policy');
 });
 it('does not infer a fill from price touch or trade at another price/side, and expires at the receipt-time tie',()=>{
  const f=fixture();f.order();f.at(200);f.engine.observeBook(f.book());expect(f.engine.snapshot().allocations).toHaveLength(0);
  expect(f.trade('other-price','5','0.49').allocatedShares).toBe('0.000000000');expect(f.trade('other-side','5','0.50','BUY').allocatedShares).toBe('0.000000000');
  f.at(5000);f.engine.observeBook(f.book());expect(f.trade('ttl','10').allocatedShares).toBe('0.000000000');expect((f.engine.snapshot().orders[0] as any).status).toBe('CANCELLED');
 });
 it.each(['0','-1','NaN','0.0000000001'])('rejects invalid trade quantity %s atomically',size=>{const f=fixture();f.order();f.at(200);const old=f.engine.snapshot();expect(()=>f.trade('bad',size)).toThrow();expect(f.engine.snapshot()).toEqual(old)});
 it('cancelling an earlier own order does not advance external ahead for the next own order',()=>{
  const f=fixture('5'),a=f.order(),b=f.order();f.at(200);f.engine.cancel(a,f.clock());f.trade('still-behind','6');
  expect(f.engine.snapshot().orders.map((o:any)=>[o.id,o.status,o.filled_size])).toEqual([[a,'CANCELLED',0],[b,'PARTIAL',1]]);
 });
 it('requires funded inventory for every pending SELL and blocks inventory cap overflow',()=>{
  const f=fixture();f.order(10,.4);f.at(200);f.trade('held','10','0.40');f.order(8,.6,'SELL');expect(()=>f.order(3,.6,'SELL')).toThrow();
  expect(f.engine.snapshot().reservedSellShares).toEqual({'888':'8.000000000'});
  const capped=fixture();capped.order(200,.01);expect(()=>capped.order(1,.01)).toThrow();
 });
 it('keeps source time, grid, duplicate and terminal lifecycle refusals atomic',()=>{
  const f=fixture(),id=f.order();f.at(200);let prior=f.engine.snapshot();
  expect(()=>f.trade('future','5','0.50','SELL',{venueUtc:START+201})).toThrow();expect(()=>f.trade('clock','5','0.50','SELL',{at:{utc:START+201,mono:201}})).toThrow();
  expect(()=>f.trade('grid','5','0.501')).toThrow();expect(f.engine.snapshot()).toEqual(prior);
  f.trade('all','10');prior=f.engine.snapshot();expect(()=>f.db.prepare("UPDATE shadow_orders SET status='OPEN' WHERE id=?").run(id)).toThrow();expect(()=>f.db.prepare("UPDATE shadow_orders SET size=99 WHERE id=?").run(id)).toThrow();expect(f.engine.snapshot()).toEqual(prior);
  f.at(2000);expect(()=>f.trade('stale','5')).toThrow('stale_book');expect(f.engine.snapshot()).toEqual(prior);
 });
 it('matches an independent cost-basis ledger for partial sale and explicitly modeled terminal marks',()=>{
  const f=fixture();f.order(10,.4);f.at(200);f.trade('a','10','0.40');f.order(4,.6,'SELL');f.at(400);f.trade('b','4','0.60','BUY');
  // Literal ledger: cash100-4+2.4=98.4; remaining6basis.4; realized.8; mark.5=>unrealized.6.
  f.db.prepare('INSERT INTO latest_features(token_id,ts,mid) VALUES(?,?,?)').run('888',f.clock().utc,.5);
  const report=f.engine.terminalReport({valuationTs:f.clock().utc}).accounting;
  expect(report.complete).toBe(true);expect(report.cash).toBeCloseTo(98.4);expect(report.grossRealized).toBeCloseTo(.8);expect(report.unrealized).toBeCloseTo(.6);expect(report.netPnl).toBeCloseTo(1.4);
  expect(report.assurance.sourceVerified).toBe(false);expect(report.positions[0]).toMatchObject({shares:6,basis:.4});
  expect(f.engine.terminalReport({valuationTs:f.clock().utc+60001}).accounting.netPnl).toBeNull();
 });
 it('does not manufacture settlement or erase holdings at terminal reporting and reopening',()=>{
  const f=fixture();f.order();f.at(200);f.trade('open-position','3');const before=f.engine.snapshot();
  const report=f.engine.terminalReport({valuationTs:f.clock().utc});expect(report.snapshot).toEqual(before);expect(report.accounting.netPnl).toBeNull();
  f.reopen();expect(f.engine.snapshot()).toEqual(before);expect(f.engine.snapshot().shares['888']).toBe('3.000000000');
 });

 it('does not release unknown external ahead by cancelling the older own cohort',()=>{
  const f=fixture('5'),old=f.order(1);f.at(50);f.engine.observeBook(f.book({bids:[{price:'0.50',size:'1'}]}));f.order(2);f.engine.cancel(old,f.clock());
  f.at(200);expect(f.trade('unknown-cancel','2').allocatedShares).toBe('0.000000000');expect(f.engine.snapshot().reservedBuyUSDC).toBe('1.000000000000000000');
 });
 it('immediately releases a rejected activation rather than waiting for a print',()=>{
  const f=fixture();f.order();f.at(100);f.engine.observeBook(f.book({bids:[{price:'0.47',size:'1'}],asks:[{price:'0.48',size:'5'}]}));
  expect((f.engine.snapshot().orders[0] as any).status).toBe('REJECTED');expect(f.engine.snapshot().reservedBuyUSDC).toBe('0.000000000000000000');
 });

});
