import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PaperMakerExecution,type PaperBinarySettlement} from '../../apps/worker/src/shadow/PaperMakerExecution';
import {createPaperDatabase,FILL_POLICY} from '../../scripts/research/maker_fill_paper';
const START=1800000000000,opened:{dir:string;db:ReturnType<typeof createPaperDatabase>}[]=[];
afterEach(()=>{for(const x of opened.splice(0)){x.db.close();rmSync(x.dir,{recursive:true,force:true})}});
function fixture(quantity='2'){const dir=mkdtempSync(path.join(tmpdir(),'paper-settlement-')),db=createPaperDatabase(path.join(dir,'paper.sqlite'));opened.push({dir,db});let ms=0;const clock=()=>({utc:START+ms,mono:ms}),e=new PaperMakerExecution(db,FILL_POLICY,clock);
 const book=()=>e.observeBook({sourceId:'book-'+ms,market:'45',token:'111',tick:'0.01',lot:'0.01',minimumShares:'1',bids:[{price:'0.49',size:'1'}],asks:[{price:'0.61',size:'1'}],at:clock(),venueUtc:clock().utc});book();
 db.prepare("INSERT INTO shadow_orders(ts,wallet_id,token_id,market_id,side,kind,price,size,expected_cancel_ts,execution_mode,status,filled_size,last_update_ts) VALUES(?,1,'111','45','BUY','MAKER_BID',.5,2,?,'SHADOW','OPEN',0,?)").run(clock().utc,clock().utc+5000,clock().utc);ms=100;book();e.processTrade({sourceId:'fill',token:'111',side:'SELL',price:'0.50',size:quantity,at:clock(),venueUtc:clock().utc});
 const input=():PaperBinarySettlement=>({token:'111',market:'45',condition:'0x'+'a'.repeat(64),payout:1,at:clock(),observedReceiptUTC:START+100,registrySha256:'b'.repeat(64),sourceResultSha256:'c'.repeat(64),sourceReviewSha256:'d'.repeat(64),costScenario:'paper-zero-redemption-cost-v1'});
 return {db,e,input,clock,at:(n:number)=>{ms=n},cancel:()=>{for(const r of e.snapshot().orders as any[])if(['OPEN','PARTIAL'].includes(r.status))e.cancel(r.id,clock())}};
}
describe('observed binary payout model settlement, never real redemption',()=>{
 it.each([0,1] as const)('settles the whole exact holding at payout%s once, survives reopening, and leaves original fills unchanged',payout=>{const f=fixture(),fills=f.db.prepare('SELECT * FROM shadow_fills').all();f.at(200);const input={...f.input(),payout};expect(f.e.settleBinaryHolding(input)).toEqual({duplicate:false});expect(f.e.snapshot().shares).toEqual({'111':'0.000000000'});expect(f.e.snapshot().cashUSDC).toBe(payout?'101.000000000000000000':'99.000000000000000000');expect(f.e.settleBinaryHolding(input)).toEqual({duplicate:true});
  const reopened=new PaperMakerExecution(f.db,FILL_POLICY,f.clock);expect(reopened.snapshot()).toEqual(f.e.snapshot());expect(f.db.prepare('SELECT * FROM shadow_fills').all()).toEqual(fills);expect(f.db.prepare("SELECT COUNT(*) n FROM accounting_events WHERE kind='SETTLEMENT'").get()).toEqual({n:1});expect(f.e.terminalReport({valuationTs:f.clock().utc}).accounting.complete).toBe(true);expect(()=>reopened.settleBinaryHolding({...input,payout:payout?0:1})).toThrow('settlement_conflict');
  expect(()=>f.db.prepare("UPDATE paper_execution_settlements SET quantity='0'").run()).toThrow('immutable_settlement');expect(f.e.terminalReport({valuationTs:START+100}).accounting.complete).toBe(false);
 });
 it('requires closed obligations, observed-time provenance, matching market and microcollateral precision',()=>{const f=fixture('1');f.at(200);expect(()=>f.e.settleBinaryHolding(f.input())).toThrow('settlement_open_orders');f.cancel();expect(()=>f.e.settleBinaryHolding({...f.input(),observedReceiptUTC:START+201})).toThrow('settlement_receipt');expect(()=>f.e.settleBinaryHolding({...f.input(),market:'wrong'})).toThrow('settlement_market');expect(()=>f.e.settleBinaryHolding({...f.input(),payout:.5 as any})).toThrow('settlement_identity');
  const dust=fixture('0.000000001');dust.cancel();expect(()=>dust.e.settleBinaryHolding(dust.input())).toThrow('settlement_quantity_precision');expect(dust.e.snapshot().shares['111']).toBe('0.000000001');expect(dust.e.snapshot().settlements).toHaveLength(0);
 });
 it('rolls cash, position, receipt and canonical posting back together when canonical SQL posting fails',()=>{const f=fixture();f.at(200);const before=f.e.snapshot();f.db.exec("CREATE TRIGGER authored_settlement_fail BEFORE INSERT ON accounting_events WHEN NEW.kind='SETTLEMENT' BEGIN SELECT RAISE(ABORT,'authored settlement posting'); END");expect(()=>f.e.settleBinaryHolding(f.input())).toThrow('authored settlement posting');expect(f.e.snapshot()).toEqual(before);expect(f.db.prepare("SELECT COUNT(*) n FROM accounting_events WHERE kind='SETTLEMENT'").get()).toEqual({n:0});f.db.exec('DROP TRIGGER authored_settlement_fail');f.e.settleBinaryHolding(f.input());expect(f.e.snapshot().cashUSDC).toBe('101.000000000000000000');
 });
});
