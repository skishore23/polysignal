import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type WebSocket from 'ws';
import { OperatingSourceCapture, verifyOperatingCaptureArchive } from '../../scripts/research/maker_operating_capture';
import { currentSlotMetadataUrl } from '../../scripts/research/maker_startup_capture';
import { PaperMakerExecution, type PaperBook } from '../../apps/worker/src/shadow/PaperMakerExecution';
import { createPaperDatabase, replayPaperEpoch } from '../../scripts/research/maker_fill_paper';

const START=1800000000000, CONDITION='0x'+'a'.repeat(64);
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const dirs:string[]=[];const dbs:ReturnType<typeof createPaperDatabase>[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();vi.restoreAllMocks();vi.useRealTimers();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})});
class Socket extends EventEmitter {
 send(_raw:string,_options:unknown,cb:(e?:Error)=>void){cb()}
 pong(_raw:Buffer){}
 terminate(){this.emit('close')}
 message(raw:unknown){this.emit('message',Buffer.from(typeof raw==='string'?raw:JSON.stringify(raw)),false)}
}
const logger:any=Object.fromEntries(['info','warn','error','debug','trace','fatal'].map(k=>[k,()=>{}]));
async function flush(){for(let n=0;n<40;n++)await Promise.resolve()}
async function archive(options:{mixedTradeBeforeBookAt?:number; invalidDeltaAt?:number; staleFullAt?:number; validStaleThenDelta?:boolean; stalePrintAt?:number}={}){
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});vi.setSystemTime(START);
 mkdirSync(path.resolve('reports/evidence'),{recursive:true});const root=mkdtempSync(path.resolve('reports/evidence/authored-fill-archive-'));dirs.push(root);const epoch=path.join(root,'epoch-000001');mkdirSync(epoch);
 const at=()=>({utc:Date.now(),mono:Date.now()-START});const token='111';
 const gamma={version:'v2',id:'123',conditionId:CONDITION,slug:'btc-updown-5m-'+START/1000,question:'Bitcoin Up or Down, five minutes',description:'Authored offline engineering rules',eventStartTime:new Date(START).toISOString(),endDate:new Date(START+300000).toISOString(),active:true,closed:false,archived:false,acceptingOrders:true,enableOrderBook:true,negRisk:false,outcomes:'["Up","Down"]',clobTokenIds:'["999","888"]',positionIds:['111','222'],orderPriceMinTickSize:.01,orderMinSize:.1,volume:'100',liquidity:'100',feesEnabled:true,feeSchedule:{rate:.25,exponent:1,takerOnly:true,rebateRate:0}};
 const book=(second=0)=>({version:'v2',market:CONDITION,asset_id:token,timestamp:String(Date.now()),hash:'authored-book-'+Date.now(),bids:[{price:second%3===0?'0.48':'0.49',size:'900'}],asks:[{price:'0.51',size:'100'}],tick_size:'0.01',min_order_size:'0.1',neg_risk:false});
 const bodies=[gamma,{t:[{t:'111',o:'Up'},{t:'222',o:'Down'}],mos:.1,mts:.01,mbf:0,tbf:10,fd:{r:.25,e:1,to:true},oas:0},book(),{base_fee:2500}];let reads=0;
 const socket=new Socket();
 const capture=new OperatingSourceCapture({metadataUrl:currentSlotMetadataUrl(START),expiresUtcMs:START+300000,freeDiskReserveBytes:0},at,path.join(epoch,'source'),{
  freeDiskBytes:()=>1n<<40n,
  request:((_url:any,_options:any,callback:(r:IncomingMessage)=>void)=>{
   const body=JSON.stringify(bodies[reads++]);const request=new EventEmitter() as any;request.destroy=()=>{};
   request.end=()=>queueMicrotask(()=>{const response=new Readable({read(){}}) as any;response.statusCode=200;response.headers={'content-type':'application/json'};response.rawHeaders=[];response.complete=false;callback(response);response.push(Buffer.from(body));response.complete=true;response.push(null)});return request as ClientRequest;
  }) as any,
  socket:()=>socket as unknown as WebSocket,
 });
 await capture.readMetadata();capture.bindMarket({condition:CONDITION,token,protocolVersion:'v2'});await capture.readMarket();await capture.readBook();await capture.readFee();
 let frames=0,samples=0;const proofHeads:string[]=[];
 const pending=capture.stream({onMessage(){frames++},onSample(clock){samples++;const row={number:samples,at:clock,processedFrames:frames,proofHeadSha256:capture.proofHeadSha256()};appendFileSync(path.join(epoch,'samples.ndjson'),JSON.stringify(row)+'\n')},shouldStop:()=>false});socket.emit('open');
 for(let second=1;second<=27;second++){
  await vi.advanceTimersByTimeAsync(800);
  if(options.validStaleThenDelta&&second===17){socket.message({event_type:'price_change',market:CONDITION,timestamp:String(Date.now()),price_changes:[{asset_id:token,side:'SELL',price:'0.51',size:'120',best_bid:'0.49',best_ask:'0.51',hash:'authored-fresh-depth'}]})}
  else if(!(options.validStaleThenDelta&&second===15)){
   const full={...book(second),event_type:'book'};
   if(options.validStaleThenDelta&&second===16){full.timestamp=String(START+14799);full.bids.push({price:'0.48',size:'700'})}
   socket.message(full);
  }
  await flush();
  if(options.invalidDeltaAt===second){socket.message({event_type:'price_change',market:CONDITION,timestamp:String(Date.now()),price_changes:[{asset_id:token,side:'SELL',price:'0.49',size:'100',best_bid:'0.49',best_ask:'0.51',hash:'authored-conflicting-bbo'}]});await flush()}
  if(options.staleFullAt===second){socket.message({...book(second),event_type:'book',timestamp:String(Date.now()-1),bids:[{price:'0.47',size:'900'}]});await flush()}
  if(second===2){socket.emit('ping',Buffer.from('authored-ping'));socket.emit('pong',Buffer.from('authored-pong'));socket.message('PONG')}
  if(second===13||second>=15){const print={event_type:'last_trade_price',market:CONDITION,asset_id:token,timestamp:String(Date.now()-(options.stalePrintAt===second?1227:0)),price:'0.50',size:second===13?'5':'100',side:second===13?'BUY':'SELL',fee_rate_bps:'2500',transaction_hash:'0x'+second.toString(16).padStart(64,'0')};socket.message(options.mixedTradeBeforeBookAt===second?[print,{...book(second),event_type:'book'}]:print);await flush()}
  proofHeads.push(capture.proofHeadSha256());await vi.advanceTimersByTimeAsync(200);await flush();
 }
 capture.stop('authored_complete');await pending;await capture.settleCallbacks();const ledger=capture.ledger();
 writeFileSync(path.join(epoch,'epoch-summary.json'),JSON.stringify({reconciled:true,cleanupFailure:null,source:ledger}));
 expect(reads).toBe(4);expect(samples).toBe(27);expect(ledger.wsMessages).toBe(frames+3);expect((await verifyOperatingCaptureArchive(path.join(epoch,'source'),ledger)).messages).toBe(ledger.wsMessages);
 vi.useRealTimers();vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 const config=JSON.parse(readFileSync('configs/worker.json','utf8'));return {root,epoch,ledger,frames,samples,proofHeads,config};
}
function database(root:string,name:string){const db=createPaperDatabase(path.join(root,name+'.sqlite'));dbs.push(db);return db}
function state(db:ReturnType<typeof createPaperDatabase>){return Object.fromEntries(['shadow_orders','shadow_fills','accounting_events','paper_execution_account','paper_execution_positions','paper_execution_queues','paper_execution_orders','paper_execution_trades','paper_execution_allocations','paper_replay_cursor','paper_replay_print_refusals'].map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]))}

describe('actual archive-to-MakerLoop paper replay, all transports authored offline',()=>{
 it('verifies transport controls separately, then actually quotes, fills and reconciles the model account',async()=>{
  const f=await archive(),db=database(f.root,'clean');const out=await replayPaperEpoch(f.epoch,db,f.config,logger);
  expect(out.sourceBoundary).toBeNull();expect(out.wireFrameCount).toBe(f.frames+3);expect(out.frameCount).toBe(f.frames);expect(out.samplesApplied).toBe(27);expect(out.withheldSamples).toBe(0);
  expect(out.terminal.snapshot.orders.length).toBeGreaterThan(0);expect(out.fills.length).toBeGreaterThan(0);expect(out.terminal.snapshot.cashUSDC).not.toBe('100.000000000000000000');
  expect(out.terminal.snapshot.orders.every((o:any)=>!['OPEN','PARTIAL'].includes(o.status))).toBe(true);expect(out.terminal.snapshot.reservedBuyUSDC).toBe('0.000000000000000000');
  expect(out.accountingEvents.some((e:any)=>e.kind==='FILL'&&e.finality==='SIMULATED')).toBe(true);expect(out.actualRevenue).toBeNull();
 });
 it('rejects a fabricated sample head before creating any model order',async()=>{
  const f=await archive(),file=path.join(f.epoch,'samples.ndjson');const rows=readFileSync(file,'utf8').trim().split('\n').map(x=>JSON.parse(x));rows[12].proofHeadSha256='f'.repeat(64);writeFileSync(file,rows.map(x=>JSON.stringify(x)+'\n').join(''));
  const db=database(f.root,'invalid-head');await expect(replayPaperEpoch(f.epoch,db,f.config,logger)).rejects.toThrow('sample_proof_head_missing');expect((db.prepare('SELECT COUNT(*) n FROM shadow_orders').get() as any).n).toBe(0);
 });
 it('withholds a sample whose real retained head contains later unapplied data',async()=>{
  const f=await archive(),file=path.join(f.epoch,'samples.ndjson');const rows=readFileSync(file,'utf8').trim().split('\n').map(x=>JSON.parse(x));rows[12].proofHeadSha256=rows[13].proofHeadSha256;writeFileSync(file,rows.map(x=>JSON.stringify(x)+'\n').join(''));
  const db=database(f.root,'ahead-head'),out=await replayPaperEpoch(f.epoch,db,f.config,logger);expect(out.withheldSamples).toBe(1);expect(out.sourceBoundary).toBeNull();expect(out.terminal.snapshot.orders.every((o:any)=>o.ts!==START+13000)).toBe(true);
 });
 it('warm-resumes after a committed fill with identical cash, shares, decisions and PRNG cursor',async()=>{
  const f=await archive(),clean=database(f.root,'control'),interrupted=database(f.root,'interrupted');await replayPaperEpoch(f.epoch,clean,f.config,logger);let stopped=false;
  await expect(replayPaperEpoch(f.epoch,interrupted,f.config,logger,{afterCommit(){if(!stopped&&(interrupted.prepare('SELECT COUNT(*) n FROM shadow_fills').get() as any).n>0){stopped=true;throw Error('authored process interruption')}}})).rejects.toThrow('authored process interruption');
  expect(stopped).toBe(true);const cursorBefore=interrupted.prepare('SELECT * FROM paper_replay_cursor').get();expect(cursorBefore).toBeTruthy();
  await replayPaperEpoch(f.epoch,interrupted,f.config,logger);expect(state(interrupted)).toEqual(state(clean));
 });
 it('rolls back a failed accounting transaction and resumes the same archive without duplicated allocations',async()=>{
  const f=await archive(),control=database(f.root,'tx-control'),broken=database(f.root,'tx-broken');await replayPaperEpoch(f.epoch,control,f.config,logger);
  broken.exec("CREATE TRIGGER authored_transaction_failure BEFORE INSERT ON accounting_events WHEN NEW.kind='FILL' BEGIN SELECT RAISE(ABORT,'authored posting failure'); END;");
  await expect(replayPaperEpoch(f.epoch,broken,f.config,logger)).rejects.toThrow('authored posting failure');
  expect((broken.prepare('SELECT COUNT(*) n FROM shadow_fills').get() as any).n).toBe(0);expect((broken.prepare('SELECT cash FROM paper_execution_account').get() as any).cash).toBe('100000000000000000000');
  broken.exec('DROP TRIGGER authored_transaction_failure');await replayPaperEpoch(f.epoch,broken,f.config,logger);expect(state(broken)).toEqual(state(control));
 });
 it('cancels at an authored trade-before-later-book boundary instead of using the later book for that print',async()=>{
  const f=await archive({mixedTradeBeforeBookAt:15}),db=database(f.root,'later-book-boundary'),out=await replayPaperEpoch(f.epoch,db,f.config,logger);
  expect(out.sourceBoundary).toBe('MODEL_INAPPLICABLE_LATER_BOOK_IN_TRADE_FRAME');expect(out.samplesApplied).toBeLessThan(27);
  expect(out.terminal.snapshot.orders.length).toBeGreaterThan(0);expect(out.terminal.snapshot.orders.every((o:any)=>!['OPEN','PARTIAL'].includes(o.status))).toBe(true);
  expect(out.fills).toHaveLength(0);expect(out.terminal.snapshot.cashUSDC).toBe('100.000000000000000000');expect(out.terminal.snapshot.reservedBuyUSDC).toBe('0.000000000000000000');
 });

 it.each(['delta_bbo_mismatch','backdated_full_snapshot'] as const)('cancels and withholds through %s until a valid full reanchor',async kind=>{
  const f=await archive(kind==='delta_bbo_mismatch'?{invalidDeltaAt:16}:{staleFullAt:16}),db=database(f.root,'invalid-chain-'+kind);
  const gap:{at:number;active:number;cash:string;shares:unknown}[]=[];
  const out=await replayPaperEpoch(f.epoch,db,f.config,logger,{afterCommit({at}){if(at.utc===START+15800)gap.push({at:at.utc,active:(db.prepare("SELECT COUNT(*) n FROM shadow_orders WHERE status IN ('OPEN','PARTIAL')").get() as any).n,cash:(db.prepare('SELECT cash FROM paper_execution_account').get() as any).cash,shares:db.prepare('SELECT * FROM paper_execution_positions').all()})}});
  expect(out.sourceBoundary).toBeNull();expect(gap.length).toBeGreaterThan(1);expect(gap.at(-1)!.active).toBe(0);
  expect(gap.every(g=>g.cash===gap[0]!.cash&&JSON.stringify(g.shares)===JSON.stringify(gap[0]!.shares))).toBe(true);
  expect(out.invalidSourceFrames).toBeGreaterThan(0);
  expect(out.terminal.snapshot.orders.every((o:any)=>o.ts!==START+16000)).toBe(true);
  expect(out.fills.some((f:any)=>f.ts===START+15800)).toBe(false);
  expect(out.terminal.snapshot.orders.some((o:any)=>o.ts>=START+17000)).toBe(true);expect(out.fills.some((f:any)=>f.ts>=START+17800)).toBe(true);
  expect(out.terminal.snapshot.reservedBuyUSDC).toBe('0.000000000000000000');
 });

 it('retains valid-but-stale full depth for a later fresh delta even when BBO never changes',async()=>{
  const f=await archive({validStaleThenDelta:true}),db=database(f.root,'stale-valid-depth');const books:PaperBook[]=[];
  const original=PaperMakerExecution.prototype.observeBook;
  vi.spyOn(PaperMakerExecution.prototype,'observeBook').mockImplementation(function(this:PaperMakerExecution,b:PaperBook){books.push(structuredClone(b));return original.call(this,b)});
  const out=await replayPaperEpoch(f.epoch,db,f.config,logger);expect(out.sourceBoundary).toBeNull();
  expect(out.terminal.snapshot.orders.every((o:any)=>o.ts!==START+16000)).toBe(true);
  // Freshness returns through a DELTA, not a full snapshot. Same BBO would not
  // expose the missing second level through a best-price-only comparison.
  const fresh=books.filter(b=>b.at.utc===START+16800);
  expect(fresh.length).toBeGreaterThan(0);expect(fresh.every(b=>b.bids.some(l=>l.price==='0.48'&&l.size==='700'))).toBe(true);
  expect(fresh.every(b=>b.asks.some(l=>l.price==='0.51'&&l.size==='120'))).toBe(true);
  expect(out.terminal.snapshot.orders.some((o:any)=>o.ts===START+17000)).toBe(true);
 });

 it('retains a stale public print as a refusal without applying it, then processes later eligible prints',async()=>{
  const f=await archive({stalePrintAt:16}),db=database(f.root,'stale-print');const out=await replayPaperEpoch(f.epoch,db,f.config,logger);
  expect(out.sourceBoundary).toBeNull();expect(out.printRefusals).toHaveLength(1);const refusal=JSON.parse((out.printRefusals[0] as any).payload_json);
  expect(refusal).toMatchObject({modelRefusal:true,reason:'STALE_PUBLIC_PRINT',ageMs:1227,venueUtc:START+14573,at:{utc:START+15800}});expect(refusal.sourceFrameSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(out.fills.some((x:any)=>x.ts===START+15800)).toBe(false);expect(out.fills.some((x:any)=>x.ts>=START+16800)).toBe(true);
 });
 it('commits the refusal with the source cursor and atomically retries after refusal-storage failure',async()=>{
  const f=await archive({stalePrintAt:16}),control=database(f.root,'stale-control'),broken=database(f.root,'stale-broken');await replayPaperEpoch(f.epoch,control,f.config,logger);
  // Session installs its dedicated schema; no economic effect is performed here.
  broken.exec('CREATE TABLE paper_replay_print_refusals(epoch TEXT NOT NULL,source_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(epoch,source_id))');
  broken.exec("CREATE TRIGGER authored_refusal_failure BEFORE INSERT ON paper_replay_print_refusals BEGIN SELECT RAISE(ABORT,'authored refusal storage failure'); END;");
  await expect(replayPaperEpoch(f.epoch,broken,f.config,logger)).rejects.toThrow('authored refusal storage failure');
  expect((broken.prepare('SELECT COUNT(*) n FROM paper_replay_print_refusals').get() as any).n).toBe(0);const cursor=broken.prepare('SELECT * FROM paper_replay_cursor').get() as any;expect(cursor).toBeTruthy();
  broken.exec('DROP TRIGGER authored_refusal_failure');await replayPaperEpoch(f.epoch,broken,f.config,logger);expect(state(broken)).toEqual(state(control));
 });

});
