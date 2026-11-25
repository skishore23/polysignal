import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PaperMakerExecution,type PaperSourceClockOrigin} from '../../apps/worker/src/shadow/PaperMakerExecution';
import {createPaperDatabase,FILL_POLICY} from '../../scripts/research/maker_fill_paper';
const START=1800000000000,opened:{dir:string;db:ReturnType<typeof createPaperDatabase>}[]=[];
afterEach(()=>{for(const x of opened.splice(0)){x.db.close();rmSync(x.dir,{recursive:true,force:true})}});
function fixture(){const dir=mkdtempSync(path.join(tmpdir(),'paper-origin-')),db=createPaperDatabase(path.join(dir,'paper.sqlite'));opened.push({dir,db});let at={utc:START,mono:10000};const e=new PaperMakerExecution(db,FILL_POLICY,()=>at);
 const origin:PaperSourceClockOrigin={fromAdmissionSha256:'a'.repeat(64),toAdmissionSha256:'b'.repeat(64),afterEpoch:634,firstEpoch:635,oldFinalReceipt:{utc:START+1000,mono:11000},newFirstReceipt:{utc:START+300000,mono:5},oldSummarySha256:'c'.repeat(64),newLedgerSha256:'d'.repeat(64)};
 const book=()=>e.observeBook({sourceId:'book-'+at.utc,market:'45',token:'111',tick:'0.01',lot:'0.01',minimumShares:'1',bids:[{price:'0.49',size:'1'}],asks:[{price:'0.61',size:'1'}],at,venueUtc:at.utc});
 const order=()=>Number(db.prepare("INSERT INTO shadow_orders(ts,wallet_id,token_id,market_id,side,kind,price,size,expected_cancel_ts,execution_mode,status,filled_size,last_update_ts) VALUES(?,1,'111','45','BUY','MAKER_BID',.5,2,?,'SHADOW','OPEN',0,?)").run(at.utc,at.utc+5000,at.utc).lastInsertRowid);
 return {db,e,origin,book,order,set:(v:typeof at)=>{at=v},clock:()=>at};}
describe('explicit closed-boundary raw source clock origins',()=>{
 it('preserves cash and raw times, clears old books, and keeps guards within the new origin',()=>{const f=fixture();f.book();const before=f.e.snapshot();expect(f.e.beginSourceClockOrigin(f.origin)).toEqual({duplicate:false});expect(f.e.snapshot()).toEqual(before);
  expect(f.db.prepare('SELECT last_utc,last_mono FROM paper_execution_account').get()).toEqual({last_utc:START+300000,last_mono:5});f.set({utc:START+300100,mono:105});expect(()=>f.order()).toThrow();f.book();f.order();f.set({utc:START+300200,mono:205});f.book();
  expect(f.e.processTrade({sourceId:'new',token:'111',side:'SELL',price:'0.50',size:'1',at:f.clock(),venueUtc:f.clock().utc}).allocatedShares).toBe('1.000000000');
  expect(f.e.beginSourceClockOrigin(f.origin)).toEqual({duplicate:true});expect(f.db.prepare('SELECT last_mono FROM paper_execution_account').get()).toEqual({last_mono:205});
  f.set({utc:START+300210,mono:200});expect(()=>f.e.processTrade({sourceId:'backward',token:'111',side:'SELL',price:'0.50',size:'1',at:f.clock(),venueUtc:f.clock().utc})).toThrow();
  expect(()=>f.db.prepare("UPDATE paper_execution_clock_origins SET payload='{}'").run()).toThrow('immutable_clock_origin');
 });
 it('refuses any open obligation, backward UTC, epoch gap, changed retry or invalid custody identifier atomically',()=>{const f=fixture();f.book();const id=f.order(),before=f.e.snapshot();expect(()=>f.e.beginSourceClockOrigin(f.origin)).toThrow('source_origin_open_orders');expect(f.e.snapshot()).toEqual(before);expect(f.db.prepare('SELECT COUNT(*) n FROM paper_execution_clock_origins').get()).toEqual({n:0});
  f.e.cancel(id,f.clock());expect(()=>f.e.beginSourceClockOrigin({...f.origin,newFirstReceipt:{utc:START+999,mono:1}})).toThrow('source_origin_chronology');expect(()=>f.e.beginSourceClockOrigin({...f.origin,firstEpoch:636})).toThrow('source_origin_epoch');expect(()=>f.e.beginSourceClockOrigin({...f.origin,newLedgerSha256:'missing'})).toThrow('source_origin_identity');
  f.e.beginSourceClockOrigin(f.origin);expect(()=>f.e.beginSourceClockOrigin({...f.origin,newFirstReceipt:{utc:START+300001,mono:6}})).toThrow('source_origin_conflict');
 });
});
