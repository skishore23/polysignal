import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { PaperMakerExecution, type PaperBook } from '../../apps/worker/src/shadow/PaperMakerExecution';
const START=1_800_000_000_000, dbs:Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close()});
function fixture(){
 const db=new Database(':memory:');dbs.push(db);db.exec(readFileSync('tests/maker/fixtures/startup-canonical-schema.sql','utf8'));
 db.exec(readFileSync('packages/storage/migrations/0048_accounting_events.sql','utf8'));db.exec(readFileSync('packages/storage/migrations/0049_accounting_reports.sql','utf8'));
 let ms=0;const clock=()=>({utc:START+ms,mono:ms});
 const e=new PaperMakerExecution(db,{accountKey:'wallet:7',walletId:7,openingCash:'100',perOrder:'20',maxExposure:'40',maxInventoryShares:'200',submitLatencyMs:100,cancelLatencyMs:0,feeModel:'paper-maker-zero-fee-v1'},clock);
 const book=(venue=ms,extra:Partial<PaperBook>={})=>e.observeBook({sourceId:'book-'+ms,token:'888',market:'45',tick:'0.01',lot:'0.01',minimumShares:'1',bids:[{price:'0.49',size:'100'}],asks:[{price:'0.61',size:'100'}],at:clock(),venueUtc:START+venue,...extra});
 book();
 const order=()=>Number(db.prepare("INSERT INTO shadow_orders(ts,wallet_id,token_id,market_id,side,kind,price,size,expected_cancel_ts,execution_mode,status,filled_size,last_update_ts) VALUES(?,7,'888','45','BUY','MAKER_BID',.5,10,?,'SHADOW','OPEN',0,?)").run(clock().utc,clock().utc+5000,clock().utc).lastInsertRowid);
 const trade=(id:string,venue:number)=>e.processTrade({sourceId:id,token:'888',side:'SELL',price:'0.50',size:'6',at:clock(),venueUtc:START+venue});
 return {db,e,clock,book,order,trade,at:(n:number)=>{ms=n}};
}
describe('separate causal roles of market book, activation and public-print clocks',()=>{
 it('records a fresh older-than-current-book print before any orders without inventing a fill',()=>{
  const f=fixture();f.at(300);f.book(246);f.at(330);expect(f.trade('no-order',243).allocatedShares).toBe('0.000000000');
  expect(f.e.snapshot().cashUSDC).toBe('100.000000000000000000');expect(f.e.snapshot().trades).toHaveLength(1);
 });
 it('uses the proved activation prefix when a later book precedes delivery of an eligible print',()=>{
  const f=fixture();f.order();f.at(132);f.book(130);f.at(137);expect(f.trade('eligible',127).allocatedShares).toBe('6.000000000');
  expect(f.e.snapshot().cashUSDC).toBe('97.000000000000000000');expect(f.e.snapshot().shares).toEqual({'888':'6.000000000'});
 });
 it('does not backdate activation or revive a cancelled order',()=>{
  const f=fixture(),id=f.order();f.at(132);f.book(130);f.at(137);expect(f.trade('before-entry',99).allocatedShares).toBe('0.000000000');
  f.e.cancel(id,f.clock());f.at(150);expect(f.trade('cancelled',140).allocatedShares).toBe('0.000000000');
 });
 it('keeps future, stale and out-of-order print guards, without confusing book time with print time',()=>{
  const f=fixture();f.order();f.at(132);f.book(130);f.at(137);expect(()=>f.trade('future',138)).toThrow('trade_clock');
  expect(f.trade('first',127).allocatedShares).toBe('6.000000000');f.at(150);expect(()=>f.trade('older',126)).toThrow('backdated_trade');
  f.at(1200);f.book(1190);expect(()=>f.trade('stale',150)).toThrow('trade_clock');
 });
 it('cannot repair a stale activation proof with a fresh postactivation book',()=>{
  const f=fixture();f.at(1000);f.order();f.at(1101);f.book(1100);f.at(1110);expect(f.trade('failed-proof',1107).allocatedShares).toBe('0.000000000');
  expect(f.e.snapshot().orders).toMatchObject([{status:'REJECTED'}]);
 });
});
