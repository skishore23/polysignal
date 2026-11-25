import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PaperMakerExecution} from '../../apps/worker/src/shadow/PaperMakerExecution';
import {applyOriginalPrint,createPaperDatabase,FILL_POLICY} from '../../scripts/research/maker_fill_paper';
const START=1800000000000,condition='0x'+'a'.repeat(64);const opened:{dir:string;db:ReturnType<typeof createPaperDatabase>}[]=[];
afterEach(()=>{for(const x of opened.splice(0)){x.db.close();rmSync(x.dir,{recursive:true,force:true})}});
function fixture(){const dir=mkdtempSync(path.join(tmpdir(),'paper-print-model-')),db=createPaperDatabase(path.join(dir,'paper.sqlite'));opened.push({dir,db});let ms=0;const clock=()=>({utc:START+ms,mono:ms});const execution=new PaperMakerExecution(db,FILL_POLICY,clock);
 const book=()=>execution.observeBook({sourceId:'book-'+ms,market:'45',token:'111',tick:'0.01',lot:'0.01',minimumShares:'1',bids:[{price:'0.49',size:'100'}],asks:[{price:'0.61',size:'100'}],at:clock(),venueUtc:clock().utc});book();
 db.prepare("INSERT INTO shadow_orders(ts,wallet_id,token_id,market_id,side,kind,price,size,expected_cancel_ts,execution_mode,status,filled_size,last_update_ts) VALUES(?,1,'111','45','BUY','MAKER_BID',.5,10,?,'SHADOW','OPEN',0,?)").run(clock().utc,clock().utc+5000,clock().utc);
 const apply=(venue:number,extra:any={})=>applyOriginalPrint(execution,{event_type:'last_trade_price',asset_id:'111',market:condition,timestamp:String(START+venue),side:'SELL',price:'0.50',size:'2',transaction_hash:'0x'+'1'.repeat(64),...extra},{token:'111',condition},clock());
 return {db,execution,apply,at:(v:number)=>{ms=v;book()}};}
describe('public observation versus strict paper-print execution applicability',()=>{
 it('refuses the actual1227ms stale-clock pattern without advancing queue, money or accepted watermark',()=>{const f=fixture();f.at(2000);const before=f.execution.snapshot();const result=f.apply(773);expect(result).toMatchObject({modelRefusal:true,reason:'STALE_PUBLIC_PRINT',ageMs:1227});expect(f.execution.snapshot()).toEqual(before)});
 it('does not soften future or malformed timestamp errors',()=>{const f=fixture();f.at(2000);const before=f.execution.snapshot();expect(()=>f.apply(2001)).toThrow('trade_clock');expect(()=>f.apply(0,{timestamp:'not-a-time'})).toThrow('trade_clock');expect(f.execution.snapshot()).toEqual(before)});
 it('retains normal fills and strict watermark/amount guards after a refused old observation',()=>{const f=fixture();f.at(2000);f.apply(773);expect(f.apply(1800)).toMatchObject({allocatedShares:'2.000000000'});f.at(2100);expect(()=>f.apply(1799,{transaction_hash:'0x'+'2'.repeat(64)})).toThrow('backdated_trade');expect(()=>f.apply(100,{size:'-1'})).toThrow();expect(f.execution.snapshot().cashUSDC).toBe('99.000000000000000000')});
});
