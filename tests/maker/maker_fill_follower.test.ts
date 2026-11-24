import {afterEach,describe,it,expect,vi} from 'vitest';
import Database from 'better-sqlite3';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {closeSync,existsSync,mkdirSync,mkdtempSync,openSync,readFileSync,readdirSync,rmSync,writeFileSync,symlinkSync,linkSync,renameSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type WebSocket from 'ws';
import {PaperMakerExecution} from '../../apps/worker/src/shadow/PaperMakerExecution';
import {RegimeGate} from '../../apps/worker/src/regime/RegimeGate';
import {OperatingSourceCapture} from '../../scripts/research/maker_operating_capture';
import {currentSlotMetadataUrl} from '../../scripts/research/maker_startup_capture';
import {createPaperDatabase,FILL_POLICY,FILL_PROTOCOL,FOLLOWER_PROTOCOL,runPaperFollower,verifyFollowerKernelLock,type FollowerAdmission} from '../../scripts/research/maker_fill_paper';
const START=1800000000000;const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const json=(v:unknown)=>JSON.stringify(v,null,2)+'\n';const dirs:string[]=[];const fds:number[]=[];
const oldFD=process.env.PAPER_FILL_LOCK_FD,oldLock=process.env.PAPER_FILL_LOCK_PATH;
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const fd of fds.splice(0))closeSync(fd);for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});if(oldFD===undefined)delete process.env.PAPER_FILL_LOCK_FD;else process.env.PAPER_FILL_LOCK_FD=oldFD;if(oldLock===undefined)delete process.env.PAPER_FILL_LOCK_PATH;else process.env.PAPER_FILL_LOCK_PATH=oldLock;});
class Socket extends EventEmitter{send(_s:any,_o:any,cb:any){cb()}pong(){}terminate(){this.emit('close')}message(v:any){this.emit('message',Buffer.from(JSON.stringify(v)),false)}}
type CaptureKind='valid'|'empty'|'missingActivity'|'emptyBook'|'emptyBookBadFee'|'emptyBookMalformedSide'|'emptyBookBadLevel'|'emptyBookWrongIdentity'|'emptyBookOffGrid';
async function capture(root:string,kind:CaptureKind='valid'){
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});vi.setSystemTime(START);
 const epoch=path.join(root,'epoch-000002');mkdirSync(epoch);const clock=()=>({utc:Date.now(),mono:Date.now()-START}),condition='0x'+'a'.repeat(64);
 const gamma={version:'v2',id:'123',conditionId:condition,slug:'btc-updown-5m-'+START/1000,question:'BTC Up or Down',description:'Authored follower rules',eventStartTime:new Date(START).toISOString(),endDate:new Date(START+300000).toISOString(),active:true,closed:false,archived:false,acceptingOrders:true,enableOrderBook:true,negRisk:false,outcomes:'["Up","Down"]',clobTokenIds:'["999","888"]',positionIds:['111','222'],orderPriceMinTickSize:.01,orderMinSize:.1,volume:kind==='missingActivity'?null:'100',liquidity:kind==='missingActivity'?null:'100',feesEnabled:true,feeSchedule:{rate:.25,exponent:1,takerOnly:true,rebateRate:0}};
 const book={version:'v2',market:condition,asset_id:'111',timestamp:String(START),hash:'authored-follower-book',bids:[{price:'0.49',size:'900'}],asks:[{price:'0.51',size:'100'}],tick_size:'0.01',min_order_size:'0.1',neg_risk:false};
 if(kind.startsWith('emptyBook'))book.asks=[];if(kind==='emptyBookMalformedSide')(book as any).bids=null;
 if(kind==='emptyBookBadLevel')book.bids[0]!.size='-1';if(kind==='emptyBookWrongIdentity')book.asset_id='999';if(kind==='emptyBookOffGrid')book.bids[0]!.price='0.491';
 const bodies=[gamma,{t:[{t:'111',o:'Up'},{t:'222',o:'Down'}],mos:.1,mts:.01,mbf:0,tbf:10,fd:{r:.25,e:1,to:true},oas:0},book,{base_fee:kind==='emptyBookBadFee'?true:2500}];let n=0;const socket=new Socket();
 const c=new OperatingSourceCapture({metadataUrl:currentSlotMetadataUrl(START),expiresUtcMs:START+300000,freeDiskReserveBytes:0},clock,path.join(epoch,'source'),{freeDiskBytes:()=>1n<<40n,socket:()=>socket as unknown as WebSocket,request:((_u:any,_o:any,cb:any)=>{const body=json(bodies[n++]),req=new EventEmitter() as any;req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{const res=new Readable({read(){}}) as any;res.statusCode=200;res.headers={'content-type':'application/json'};res.rawHeaders=[];res.complete=false;cb(res);res.push(Buffer.from(body));res.complete=true;res.push(null)});return req}) as any});
 await c.readMetadata();c.bindMarket({condition,token:'111',protocolVersion:'v2'});await c.readMarket();await c.readBook();await c.readFee();
 if(kind!=='empty'&&!kind.startsWith('emptyBook')){const pending=c.stream({onMessage(){},onSample(){},shouldStop:()=>false});socket.emit('open');socket.message({...book,event_type:'book'});for(let i=0;i<30;i++)await Promise.resolve();c.stop('authored_closed');await pending;}else c.stop('authored_empty');
 await c.settleCallbacks();writeFileSync(path.join(epoch,'samples.ndjson'),'');writeFileSync(path.join(epoch,'epoch-summary.json'),json({reconciled:true,cleanupFailure:null,source:c.ledger()}));vi.useRealTimers();return epoch;
}
async function fixture(kind:CaptureKind='valid'){
 mkdirSync(path.resolve('reports/evidence'),{recursive:true});const root=mkdtempSync(path.resolve('reports/evidence/follower-authored-'));dirs.push(root);const source=path.join(root,'source');mkdirSync(source);await capture(source,kind);
 const seedFile=path.join(root,'seed.sqlite'),seed=createPaperDatabase(seedFile);let ms=0;const clock=()=>({utc:START-300000+ms,mono:ms});
 const e=new PaperMakerExecution(seed,FILL_POLICY,clock);e.observeBook({sourceId:'author-seed-book',token:'777',market:'77',tick:'0.01',lot:'0.01',minimumShares:'1',bids:[{price:'0.49',size:'10'}],asks:[{price:'0.60',size:'10'}],at:clock(),venueUtc:clock().utc});
 seed.prepare("INSERT INTO shadow_orders(ts,wallet_id,token_id,market_id,side,kind,price,size,expected_cancel_ts,execution_mode,status,filled_size,last_update_ts) VALUES(?,1,'777','77','BUY','MAKER_BID',.5,4,?,'SHADOW','OPEN',0,?)").run(clock().utc,clock().utc+5000,clock().utc);ms=100;e.processTrade({sourceId:'authored-seed-trade',token:'777',side:'SELL',price:'0.50',size:'4',at:clock(),venueUtc:clock().utc});
 const terminal=e.terminalReport({valuationTs:clock().utc});const resultFile=path.join(root,'seed-result.json');writeFileSync(resultFile,json({schema:'CONSERVING_PAPER_EPOCH_RESULT_V1',epoch:path.join(source,'epoch-000001'),terminal,resources:{authored:true}}));seed.close();
 const pin=(file:string)=>({path:file,sha256:hash(readFileSync(file))});const carryReview=path.join(root,'seed-review.json');writeFileSync(carryReview,json({decision:'APPROVE_PAPER_FOLLOWER_CARRY_FROM_CLOSED_ACCOUNT',databaseClosed:true,lastEpoch:1,paperProtocolSha256:hash(JSON.stringify(FILL_PROTOCOL)),database:pin(seedFile),result:pin(resultFile),scope:'authored offline fixture only'}));
 const sourceAdmission=path.join(root,'source-admission.json');writeFileSync(sourceAdmission,json({scope:'authored offline fixture only'}));
 const output=path.join(root,'account'),reviewFile=path.join(root,'review.json'),admissionFile=path.join(root,'admission.json');
 const a:FollowerAdmission={schema:'CONSERVING_PAPER_FOLLOWER_ADMISSION_V2',inputMode:'AUTHORED_OFFLINE_FIXTURE',protocolSha256:hash(JSON.stringify(FOLLOWER_PROTOCOL)),codeSha256:Object.fromEntries(['scripts/research/maker_fill_paper.ts','apps/worker/src/shadow/PaperMakerExecution.ts'].map(p=>[path.resolve(p),hash(readFileSync(p))])),sourceRoot:source,firstEpoch:2,sourceAdmission:pin(sourceAdmission),carryFrom:{database:pin(seedFile),result:pin(resultFile),review:pin(carryReview),lastEpoch:1},outputDirectory:output,reviewFile,reviewSha256:''};
 const persist=()=>{writeFileSync(reviewFile,json({decision:'APPROVE_CONSERVING_CAPTURE_FOLLOWER_PAPER_OPERATION',...a}));a.reviewSha256=hash(readFileSync(reviewFile));writeFileSync(admissionFile,json(a));};persist();
 const lock=path.resolve('reports/evidence/maker-fill-paper-account.lock');const fd=openSync(lock,'a+');fds.push(fd);process.env.PAPER_FILL_LOCK_FD=String(fd);process.env.PAPER_FILL_LOCK_PATH=lock;
 return {root,source,output,a,admissionFile,persist,seedFile};
}
describe('prospective follower V2 custody and account driver, authored sources only',()=>{
 it('requires an actual matching fd inode and canonical output before copying any bank',async()=>{
  const f=await fixture();const wrong=openSync(path.join(f.root,'other.lock'),'a+');fds.push(wrong);process.env.PAPER_FILL_LOCK_FD=String(wrong);
  await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow('kernel_lock_identity');expect(existsSync(path.join(f.output,'paper.sqlite'))).toBe(false);
 });
 it('rejects symlink output aliases and a missing carry rather than creating fresh100',async()=>{
  const f=await fixture(),actual=path.join(f.root,'actual');mkdirSync(actual);const alias=path.join(f.root,'alias');symlinkSync(actual,alias);expect(()=>verifyFollowerKernelLock(path.join(alias,'account'))).toThrow('output_alias');
  (f.a as any).carryFrom=null;f.persist();await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow('carry_lineage');expect(existsSync(path.join(f.output,'paper.sqlite'))).toBe(false);
 });
 it.each(['empty','missingActivity'] as const)('retains the carried98/4shares and writes immutable %s skip before any ordinary session',async kind=>{
  const f=await fixture(kind),gate=vi.spyOn(RegimeGate.prototype,'getLoadDiagnostics');const state=await runPaperFollower(f.admissionFile,{maxCycles:2,wait:async()=>{}});
  expect(gate).not.toHaveBeenCalled();expect(state.status).toBe('WAITING_CLOSED_SOURCE');expect(state.cashUSDC).toBe('98.000000000000000000');expect(state.heldShares).toEqual({'777':'4.000000000'});expect(state.modelNetPnlUSDC).toBeNull();expect(state.lastModeledEpoch).toBe(1);expect(state.lastClosedEpoch).toBe(2);
  const receipt=JSON.parse(readFileSync(path.join(f.output,'epoch-000002.json'),'utf8'));expect(receipt.disposition).toBe('SKIP_MODEL_SOURCE_INELIGIBLE');expect(receipt.reward).toBeNull();expect(receipt.modelNetPnlUSDC).toBeNull();const before=hash(readFileSync(path.join(f.output,'epoch-000002.json')));
  await runPaperFollower(f.admissionFile,{maxCycles:1});expect(hash(readFileSync(path.join(f.output,'epoch-000002.json')))).toBe(before);
 });
 it('publishes once, reconciles a post-publication crash, and preserves exact existing economic result bytes',async()=>{
  const f=await fixture();await expect(runPaperFollower(f.admissionFile,{maxCycles:1,afterReportPublished(){throw Error('authored publication crash')}})).rejects.toThrow('authored publication crash');
  const file=path.join(f.output,'epoch-000002.json'),original=readFileSync(file);expect(existsSync(file)).toBe(true);
  const state=await runPaperFollower(f.admissionFile,{maxCycles:2,wait:async()=>{}});expect(readFileSync(file).equals(original)).toBe(true);expect(state.cashUSDC).toBe('98.000000000000000000');expect(state.lastModeledEpoch).toBe(2);expect(state.lastResultPath).toBe(file);expect(state.status).toBe('WAITING_CLOSED_SOURCE');
 });
 it('refuses changed existing economics without overwriting the retained report',async()=>{
  const f=await fixture();await expect(runPaperFollower(f.admissionFile,{maxCycles:1,afterReportPublished(){throw Error('authored crash')}})).rejects.toThrow();const file=path.join(f.output,'epoch-000002.json'),r=JSON.parse(readFileSync(file,'utf8'));r.terminal.snapshot.cashUSDC='999';writeFileSync(file,json(r));const changed=readFileSync(file);
  await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow('existing_epoch_projection_conflict');expect(readFileSync(file).equals(changed)).toBe(true);
 });
 it('checkpoints unknown runtime errors with exact funds, holdings and committed cursor, not a source skip',async()=>{
  const f=await fixture();await expect(runPaperFollower(f.admissionFile,{maxCycles:1,beforeReplay(){throw Error('authored core fault')}})).rejects.toThrow('authored core fault');
  const s=JSON.parse(readFileSync(path.join(f.output,'state.json'),'utf8'));expect(s.status).toBe('CHECKPOINTED_FAILURE');expect(s.cashUSDC).toBe('98.000000000000000000');expect(s.heldShares['777']).toBe('4.000000000');expect(s.reservedBuyUSDC).toBe('0.000000000000000000');expect(s.modelNetPnlUSDC).toBeNull();expect(Array.isArray(s.committedCursors)).toBe(true);expect(existsSync(path.join(f.output,'epoch-000002.json'))).toBe(false);
  expect(readdirSync(f.output).filter(f=>f.startsWith('failure-'))).toHaveLength(1);
 });
 it('rejects a changed seed or mismatched successor epoch before opening a model account',async()=>{
  const f=await fixture();f.a.firstEpoch=3;f.persist();await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow('carry_lineage');expect(existsSync(path.join(f.output,'paper.sqlite'))).toBe(false);
 });
 it('does not process a later closed capture while the next expected epoch is absent',async()=>{
  const f=await fixture();renameSync(path.join(f.source,'epoch-000002'),path.join(f.source,'epoch-000003'));
  const state=await runPaperFollower(f.admissionFile,{maxCycles:1});expect(state.status).toBe('WAITING_CLOSED_SOURCE');expect(state.lastClosedEpoch).toBe(1);expect(state.cashUSDC).toBe('98.000000000000000000');expect(existsSync(path.join(f.output,'epoch-000003.json'))).toBe(false);
 });
 it('rejects a changed seed and nonclosed journal before copying the bank',async()=>{
  const f=await fixture();writeFileSync(f.seedFile+'-wal','not-closed');await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow('seed_database_not_closed');expect(existsSync(path.join(f.output,'paper.sqlite'))).toBe(false);rmSync(f.seedFile+'-wal');
  writeFileSync(f.seedFile,Buffer.concat([readFileSync(f.seedFile),Buffer.from('changed')]));await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow('file_pin_changed');expect(existsSync(path.join(f.output,'paper.sqlite'))).toBe(false);
 });
 it('never opens a hardlinked source seed as the mutable account',async()=>{
  const f=await fixture();mkdirSync(f.output);linkSync(f.seedFile,path.join(f.output,'paper.sqlite'));const before=hash(readFileSync(f.seedFile));
  await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow('carried_database_identity');expect(hash(readFileSync(f.seedFile))).toBe(before);
 });
 it('does not reinterpret an unreviewed carry as independent closure',async()=>{
  const f=await fixture(),pin=f.a.carryFrom.review;const r=JSON.parse(readFileSync(pin.path,'utf8'));r.databaseClosed=false;writeFileSync(pin.path,json(r));pin.sha256=hash(readFileSync(pin.path));f.persist();
  await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow('follower_carry_review');expect(existsSync(path.join(f.output,'paper.sqlite'))).toBe(false);
 });
 it('rejects a symlink published report rather than accepting an alias of retained evidence',async()=>{
  const f=await fixture();await expect(runPaperFollower(f.admissionFile,{maxCycles:1,afterReportPublished(){throw Error('author-crash')}})).rejects.toThrow();
  const file=path.join(f.output,'epoch-000002.json'),copy=path.join(f.root,'outside-report.json');writeFileSync(copy,readFileSync(file));rmSync(file);symlinkSync(copy,file);
  await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow('published_file_identity');
 });

 it('requires code pins for both the driver and execution core',async()=>{
  const f=await fixture();delete f.a.codeSha256[path.resolve('apps/worker/src/shadow/PaperMakerExecution.ts')];f.persist();await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow('required_code_pin');expect(existsSync(path.join(f.output,'paper.sqlite'))).toBe(false);
 });
 it('binds the carried result to the precise last capture epoch',async()=>{
  const f=await fixture(),r=JSON.parse(readFileSync(f.a.carryFrom.result.path,'utf8'));r.epoch=path.join(f.source,'epoch-000099');writeFileSync(f.a.carryFrom.result.path,json(r));f.a.carryFrom.result.sha256=hash(readFileSync(f.a.carryFrom.result.path));const cr=JSON.parse(readFileSync(f.a.carryFrom.review.path,'utf8'));cr.result=f.a.carryFrom.result;writeFileSync(f.a.carryFrom.review.path,json(cr));f.a.carryFrom.review.sha256=hash(readFileSync(f.a.carryFrom.review.path));f.persist();
  await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow('carry_result_lineage');expect(existsSync(path.join(f.output,'paper.sqlite'))).toBe(false);
 });

 it('closes the account and persists exact funds when the seed result fails startup reconciliation',async()=>{
  const f=await fixture(),result=JSON.parse(readFileSync(f.a.carryFrom.result.path,'utf8'));result.terminal.snapshot.cashUSDC='999.000000000000000000';writeFileSync(f.a.carryFrom.result.path,json(result));f.a.carryFrom.result.sha256=hash(readFileSync(f.a.carryFrom.result.path));
  const review=JSON.parse(readFileSync(f.a.carryFrom.review.path,'utf8'));review.result=f.a.carryFrom.result;writeFileSync(f.a.carryFrom.review.path,json(review));f.a.carryFrom.review.sha256=hash(readFileSync(f.a.carryFrom.review.path));f.persist();
  const opened=new Set<Database.Database>(),prepare=Database.prototype.prepare;
  vi.spyOn(Database.prototype,'prepare').mockImplementation(function(this:Database.Database,sql:string){opened.add(this);return prepare.call(this,sql)});
  const close=vi.spyOn(Database.prototype,'close');
  try {await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow('carried_result_account_mismatch');expect(close).toHaveBeenCalledTimes(1);
   const checkpoint=JSON.parse(readFileSync(path.join(f.output,'state.json'),'utf8'));expect(checkpoint.status).toBe('CHECKPOINTED_STARTUP_FAILURE');expect(checkpoint.account.cashUSDC).toBe('98.000000000000000000');expect(checkpoint.account.heldShares).toEqual({'777':'4.000000000'});expect(checkpoint.modelNetPnlUSDC).toBeNull();expect(checkpoint.complete).toBe(false);expect(existsSync(path.join(f.output,'epoch-000002.json'))).toBe(false);
  } finally {for(const db of opened)if(db.open)db.close();}
 });

 it('skips a fully validated empty ask book before ordinary execution without resetting the carried bank',async()=>{
  const f=await fixture('emptyBook'),gate=vi.spyOn(RegimeGate.prototype,'getLoadDiagnostics');
  const state=await runPaperFollower(f.admissionFile,{maxCycles:2,wait:async()=>{}});
  expect(gate).not.toHaveBeenCalled();expect(state.status).toBe('WAITING_CLOSED_SOURCE');expect(state.cashUSDC).toBe('98.000000000000000000');expect(state.heldShares).toEqual({'777':'4.000000000'});expect(state.lastModeledEpoch).toBe(1);expect(state.lastClosedEpoch).toBe(2);expect(state.modelNetPnlUSDC).toBeNull();
  const file=path.join(f.output,'epoch-000002.json'),receipt=JSON.parse(readFileSync(file,'utf8'));expect(receipt.disposition).toBe('SKIP_MODEL_SOURCE_INELIGIBLE');expect(receipt.reason).toBe('STRUCTURAL_SOURCE_TERMS_INELIGIBLE');expect(receipt.detail).toBe('Error: maker_source:empty_book_side');expect(receipt.reward).toBeNull();expect(receipt.modelNetPnlUSDC).toBeNull();
  const old=readFileSync(file);await runPaperFollower(f.admissionFile,{maxCycles:1});expect(readFileSync(file).equals(old)).toBe(true);
 });
 it.each(['emptyBookBadFee','emptyBookMalformedSide','emptyBookBadLevel','emptyBookWrongIdentity','emptyBookOffGrid'] as const)('does not hide malformed evidence behind an empty side: %s',async kind=>{
  const f=await fixture(kind),gate=vi.spyOn(RegimeGate.prototype,'getLoadDiagnostics');await expect(runPaperFollower(f.admissionFile,{maxCycles:1})).rejects.toThrow(({emptyBookBadFee:'fee_rate_schema',emptyBookMalformedSide:'book_side_schema',emptyBookBadLevel:'decimal_format',emptyBookWrongIdentity:'book_identity',emptyBookOffGrid:'price_grid'})[kind]);
  expect(gate).not.toHaveBeenCalled();expect(existsSync(path.join(f.output,'epoch-000002.json'))).toBe(false);const state=JSON.parse(readFileSync(path.join(f.output,'state.json'),'utf8'));expect(state.status).toBe('CHECKPOINTED_FAILURE');expect(state.cashUSDC).toBe('98.000000000000000000');expect(state.heldShares).toEqual({'777':'4.000000000'});expect(state.modelNetPnlUSDC).toBeNull();
 });

});
