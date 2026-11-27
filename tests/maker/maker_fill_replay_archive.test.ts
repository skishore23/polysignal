import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {spawnSync} from 'node:child_process';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type WebSocket from 'ws';
import Database from 'better-sqlite3';
import { MakerLoop } from '../../apps/worker/src/maker/MakerLoop';
import { OperatingSourceCapture, verifyOperatingCaptureArchive } from '../../scripts/research/maker_operating_capture';
import { currentSlotMetadataUrl } from '../../scripts/research/maker_startup_capture';
import { PaperMakerExecution, type PaperBook } from '../../apps/worker/src/shadow/PaperMakerExecution';
import { createPaperDatabase, replayPaperEpoch } from '../../scripts/research/maker_fill_paper';

const START=1800000000000, CONDITION='0x'+'a'.repeat(64);
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const dirs:string[]=[];const controls:string[]=[];const dbs:ReturnType<typeof createPaperDatabase>[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();vi.restoreAllMocks();vi.useRealTimers();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});for(const file of controls.splice(0))rmSync(file,{force:true})});
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

 it('publishes identical full authored replay semantics with preserved V4 runner/core and prospective bounded-memory code',async()=>{const f=await archive(),nonce=randomUUID().replaceAll('-',''),before='/Users/kishore/Emergent/results/polysignal_pivot_v1/coordinator40/memory-poll-hash-repair/before',coreName='.authored-memory-before-'+nonce,core=path.resolve('apps/worker/src/shadow/'+coreName+'.ts'),runner=path.resolve('scripts/research/.authored-memory-before-'+nonce+'.ts');controls.push(core,runner);const oldCore=readFileSync(before+'/apps/worker/src/shadow/PaperMakerExecution.ts');expect(hash(oldCore)).toBe('d78667eaa4c11dd262208a3698d59445b8a3171f24b9be95ea95fad80c755ce1');writeFileSync(core,oldCore);const old=readFileSync(before+'/scripts/research/maker_fill_paper.ts','utf8');expect(hash(old)).toBe('83601e8d45db5ecc93dd30b07b3706d7c1a82d3528a576ebb6a42fc7e385e14f');writeFileSync(runner,old.replace("from '../../apps/worker/src/shadow/PaperMakerExecution'", "from '../../apps/worker/src/shadow/"+coreName+"'"));
  const run=(module:string,name:string)=>{const output=path.join(f.root,name+'.json'),r=spawnSync(process.execPath,['--import','tsx','tests/maker/fixtures/maker_fill_memory_probe.ts','replay-file',module,f.epoch,path.join(f.root,name+'.sqlite'),output],{encoding:'utf8',timeout:30000});expect(r.status,r.stderr).toBe(0);return JSON.parse(readFileSync(output,'utf8'))};const baseline=run(runner,'v4-control'),candidate=run(path.resolve('scripts/research/maker_fill_paper.ts'),'v5-candidate');expect(candidate).toEqual(baseline);expect(hash(readFileSync(path.join(f.root,'v5-candidate.json')))).toBe(hash(readFileSync(path.join(f.root,'v4-control.json'))));expect(candidate.fills.length).toBeGreaterThan(0);expect(candidate.terminal.snapshot.reservedBuyUSDC).toBe('0.000000000000000000');
 });

});

describe('ENG035 isolated first-decision observation',()=>{
  it('compares one selected commit and the full epoch with an unchanged ordinary application on identical fork images',async()=>{
    const source=path.resolve('scripts/research/.eng035-unmodified-ordinary.ts');
    expect(hash(readFileSync(source))).toBe('5646ca465f79a62704d2221edaf3489ace0a69060fa64bf3771f675523d125a7');
    const ordinary=await import('../../scripts/research/.eng035-unmodified-ordinary');
    const {FirstDecisionRecorder,checkpointDatabaseDigest,checkpointWire}=await import('../../scripts/research/maker_decision_checkpoint');
    const {copyFileSync}=await import('node:fs');
    const f=await archive(),genesis=path.join(f.root,'original-genesis.sqlite');
    // Archive construction uses authored clocks. The decision observation must
    // exercise real native timers, not the fixture's interval substitution.
    vi.useRealTimers();
    ordinary.createPaperDatabase(genesis).close();
    const onFile=path.join(f.root,'observed.sqlite'),offFile=path.join(f.root,'ordinary.sqlite');
    copyFileSync(genesis,onFile);copyFileSync(genesis,offFile);
    const recorder=new FirstDecisionRecorder(16*1024*1024);
    const on=createPaperDatabase(onFile,recorder);
    // The unchanged original factory establishes the identical persistent
    // schema. Reopen only to attach SQLite's native, observational verbose API;
    // restore its sole connection-local initialization (foreign_keys=ON).
    ordinary.createPaperDatabase(offFile).close();
    const referenceEffects:{kind:string;data:unknown}[]=[];
    let inspecting=false,recording=false;
    const off=new Database(offFile,{verbose(sql){
      if(recording&&!inspecting)referenceEffects.push({kind:'SQLITE_TRACE',data:checkpointWire(sql)});
    }});
    off.pragma('foreign_keys = ON');
    const originalPrepare=off.prepare,originalExec=off.exec;
    const observe=<T,>(kind:string,sql:string,args:unknown[],call:()=>T):T=>{
      if(inspecting||!recording)return call();
      referenceEffects.push({kind:'WRITE_BEGIN',data:checkpointWire({kind,sql,args})});
      try{const value=call();referenceEffects.push({kind:'WRITE_RETURN',data:checkpointWire(kind==='exec'?null:value)});return value}
      catch(error){referenceEffects.push({kind:'WRITE_THROW',data:checkpointWire(error)});throw error}
    };
    off.prepare=function(this:Database.Database,sql:string){const statement=originalPrepare.call(this,sql),run=statement.run;
      statement.run=function(this:Database.Statement,...args:unknown[]){return observe('run',statement.source,args,()=>Reflect.apply(run,this,args))};return statement} as typeof off.prepare;
    off.exec=function(this:Database.Database,sql:string){return observe('exec',sql,[],()=>originalExec.call(this,sql))};
    dbs.push(on,off);
    expect(checkpointDatabaseDigest(on)).toEqual(checkpointDatabaseDigest(off));
    const log=(rows:unknown[])=>Object.fromEntries(['info','warn','error','debug','trace','fatal'].map(k=>[k,(...args:unknown[])=>rows.push([k,structuredClone(args)])]));
    const logsOn:unknown[]=[],logsOff:unknown[]=[];
    const captured=await replayPaperEpoch(f.epoch,on,f.config,log(logsOn),undefined,recorder),packet=recorder.result();
    expect(packet.status).toBe('REQUIRES_INDEPENDENT_PARITY_AND_CUSTODY');
    expect(packet.disposition).toBe('COMMITTED');expect(packet.verifiedComplete).toBe(false);
    expect(packet.selectedSample!.current).toBe(true);
    expect(packet.orderedTrace.filter(r=>r.kind==='TICK_ENTER')).toHaveLength(1);
    expect(packet.orderedTrace.some(r=>r.kind==='SQLITE_TRACE')).toBe(true);
    expect(packet.orderedTrace.some(r=>r.kind==='WRITE_BEGIN')).toBe(true);
    type OrdinarySessionView={
      clock:()=>{utc:number;mono:number};seen:Set<string>;lastTick:number;terms:Map<string,unknown>;
      gate:{getLoadDiagnostics:()=>unknown};
    };
    const sessionState=(view:OrdinarySessionView)=>({
      seen:[...view.seen],lastTick:view.lastTick,terms:[...view.terms],regime:view.gate.getLoadDiagnostics(),
    });
    let referenceSession:OrdinarySessionView|undefined;
    let originalPrestateChecked=false,originalTickChecked=false,referenceCommitted=false;
    let atEntry:{utc:number;mono:number}|undefined,sessionAtEntry:ReturnType<typeof sessionState>|undefined;
    let databaseAtEntry:ReturnType<typeof checkpointDatabaseDigest>|undefined;
    let precedingCommittedRng:number=ordinary.FILL_PROTOCOL.seed;
    const sample=ordinary.PaperFillSession.prototype.sample;
    const loopPrototype=MakerLoop.prototype as unknown as {tick(...args:unknown[]):Promise<void>};
    const tick=loopPrototype.tick;
    ordinary.PaperFillSession.prototype.sample=function(this:InstanceType<typeof ordinary.PaperFillSession>,d){
      referenceSession=this as unknown as OrdinarySessionView;
      const at=referenceSession.clock();
      if(!originalPrestateChecked&&d.missing.length===0&&at.mono-referenceSession.lastTick>=1000){
        inspecting=true;
        try{
          const preTTL={at,session:sessionState(referenceSession),missing:d.missing,identity:d.identity,database:checkpointDatabaseDigest(off)};
          expect(checkpointWire(preTTL)).toEqual(packet.snapshots.preTTL);originalPrestateChecked=true;
        }finally{inspecting=false}
      }
      return Reflect.apply(sample,this,[d]);
    };
    loopPrototype.tick=function(this:MakerLoop,...args:unknown[]){
      if(!originalTickChecked){
        inspecting=true;
        try{
          if(!referenceSession)throw Error('ordinary tick outside observed PaperFillSession.sample');
          atEntry={...referenceSession.clock()};
          sessionAtEntry=structuredClone(sessionState(referenceSession));
          databaseAtEntry=checkpointDatabaseDigest(off);
          originalTickChecked=true;
        }finally{inspecting=false}
      }
      return Reflect.apply(tick,this,args);
    };
    let control:Awaited<ReturnType<typeof ordinary.replayPaperEpoch>>;
    try{
      // Only the application belongs to this stream. The unchanged factory and diagnostic reads are outside it.
      referenceEffects.length=0;recording=true;
      control=await ordinary.replayPaperEpoch(f.epoch,off,f.config,log(logsOff),{afterCommit(state){
        if(referenceCommitted)return;
        if(!originalTickChecked){precedingCommittedRng=state.randomState;return;}
        // Original sample() uses a forced transaction commit. Identify its first tick independently
        // of the candidate's reported ordinal; the original committed ordinal is also its entry ordinal.
        recording=false;
        if(!referenceSession||!atEntry||!sessionAtEntry||!databaseAtEntry)throw Error('missing ordinary first tick state');
        expect(referenceEffects).toEqual(packet.applicationNativeEffects);
        expect(referenceEffects.length).toBeGreaterThan(0);
        expect(packet.selectedSample!.ordinal).toBe(state.ordinal);
        expect(packet.selectedSample!.at).toEqual(atEntry);
        expect(state.at).toEqual(atEntry);
        // The unchanged replay initializes its RNG from this seed, and the sole maker
        // decision-group draw is inside tick. No earlier tick ran. Check prior committed RNG too.
        expect(precedingCommittedRng).toBe(ordinary.FILL_PROTOCOL.seed);
        const entry={at:atEntry,replayPosition:{ordinal:state.ordinal,randomState:ordinary.FILL_PROTOCOL.seed},
          session:sessionAtEntry,database:databaseAtEntry};
        expect(checkpointWire(entry)).toEqual(packet.snapshots.tickEntry);
        const complete={database:checkpointDatabaseDigest(off),session:sessionState(referenceSession),
          cursor:off.prepare('SELECT * FROM paper_replay_cursor WHERE epoch=?').get(f.epoch)};
        expect(checkpointWire(complete)).toEqual(packet.snapshots.postEnclosingTransaction);
        expect(packet.orderedTrace.at(-1)).toEqual({kind:'COMMITTED',data:checkpointWire(state)});
        referenceCommitted=true;
      }});
    }finally{
      recording=false;ordinary.PaperFillSession.prototype.sample=sample;loopPrototype.tick=tick;
    }
    expect(originalPrestateChecked).toBe(true);expect(originalTickChecked).toBe(true);
    expect(referenceCommitted).toBe(true);expect(logsOn).toEqual(logsOff);
    const {resources:_c,...semanticControl}=control,{resources:_o,...semanticObserved}=captured;
    expect(semanticControl).toEqual(semanticObserved);
    expect(checkpointDatabaseDigest(off)).toEqual(checkpointDatabaseDigest(on));
  });
  it('leaves an incomplete, non-reward packet when observation exhausts its budget',async()=>{
    const {FirstDecisionRecorder}=await import('../../scripts/research/maker_decision_checkpoint');
    const f=await archive();vi.useRealTimers();const recorder=new FirstDecisionRecorder(1),db=createPaperDatabase(path.join(f.root,'budget.sqlite'),recorder);dbs.push(db);
    const outcome=await replayPaperEpoch(f.epoch,db,f.config,logger,undefined,recorder);
    expect(outcome.fills.length).toBeGreaterThan(0);expect(recorder.result()).toMatchObject({status:'INCOMPLETE',verifiedComplete:false,newIndependentEconomicLabels:0});
  });
});
