/** One isolated fork, first ordinary tick. No source acquisition, policy or live-follower entry point. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHook, executionAsyncResource } from 'node:async_hooks';

type Db = Database.Database;
type Clock = {utc:number; mono:number};
type Cursor = {ordinal:number; at:Clock; randomState:number};
type Phase = 'INITIAL' | 'PREFIX' | 'SAMPLE' | 'TICK' | 'SEALED';
export type CheckpointClock = Cursor;
export type EvidencePin = {path:string; sha256:string};

function requireValue(condition:unknown, why:string):asserts condition {
  if (!condition) throw new Error('decision_checkpoint:'+why);
}
const quote = (s:string) => '"'+s.replace(/"/g,'""')+'"';

/** Lossless scalar typing, including signed zero and the initial lastTick=-Infinity. */
export function checkpointWire(value:unknown): unknown {
  if(value===null || typeof value==='string' || typeof value==='boolean') return value;
  if(typeof value==='number') return ['number',Object.is(value,-0)?'-0':String(value)];
  if(typeof value==='bigint') return ['integer',value.toString()];
  if(typeof value==='undefined') return ['undefined'];
  if(Buffer.isBuffer(value)) return ['blob',value.toString('base64')];
  if(value instanceof Error) return ['error',value.name,value.message,(value as Error & {code?:string}).code??null];
  requireValue(typeof value==='object','unsupported_type');
  requireValue(Array.isArray(value)||[Object.prototype,null].includes(Object.getPrototypeOf(value)), 'unsupported_object');
  const entries=Object.getOwnPropertyDescriptors(value),keys=Object.keys(entries);
  requireValue(Object.getOwnPropertySymbols(value).length===0,'symbol_key');
  for(const k of keys)requireValue('value' in entries[k]!, 'accessor');
  if(Array.isArray(value)) {
    requireValue(keys.length===value.length+1 && keys.filter(k=>k!=='length').every((k,i)=>k===String(i)), 'array_shape');
    return ['array',value.map((_,i)=>checkpointWire(entries[String(i)]!.value))];
  }
  return ['object',keys.map(k=>[k,checkpointWire(entries[k]!.value)])];
}

/** Low-memory main/temp schema and typed rows. Must be invoked on the writer for an in-flight cut. */
export function checkpointDatabaseDigest(db:Db) {
  const sum=createHash('sha256');
  const add=(x:unknown)=>{const s=JSON.stringify(checkpointWire(x));sum.update(String(Buffer.byteLength(s))+':');sum.update(s);};
  const tables:{schema:string;name:string;rows:number}[]=[];
  const databases=db.pragma('database_list') as {name:string}[];
  requireValue(databases.every(x=>['main','temp'].includes(x.name)), 'attached_database');
  for(const schema of ['main','temp']) {
    const ddl=db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM '+schema+'.sqlite_schema ORDER BY type,name').safeIntegers().raw();
    for(const row of ddl.iterate()) add([schema,row]);
    const items=(db.pragma(schema+'.table_list') as {name:string;type:string;wr:number}[]).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    for(const item of items) {
      if(item.type==='view' || ['sqlite_schema','sqlite_temp_schema'].includes(item.name))continue;
      requireValue(item.type==='table','unsupported_table:'+item.name);
      const columns=db.pragma(schema+'.table_xinfo('+quote(item.name)+')') as {name:string;pk:number}[];
      const names=columns.map(c=>c.name.toLowerCase());
      const rowid=['rowid','_rowid_','oid'].find(n=>!names.includes(n));
      requireValue(item.wr===1||rowid,'shadowed_rowid');
      const order=item.wr?columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>quote(c.name)).join(','):rowid!;
      requireValue(order,'row_order');
      const sql='SELECT '+(item.wr?'':rowid+',')+'* FROM '+schema+'.'+quote(item.name)+' ORDER BY '+order;
      add([schema,item.name,columns.map(c=>c.name)]);
      let rows=0;
      for(const row of db.prepare(sql).safeIntegers().raw().iterate()){add(row);rows++;}
      tables.push({schema,name:item.name,rows});
      add(rows);
    }
  }
  const pragmas:Record<string,unknown>={};
  for(const key of ['foreign_keys','recursive_triggers','user_version','application_id','encoding','page_size','journal_mode','synchronous','defer_foreign_keys','read_uncommitted','query_only'])pragmas[key]=db.pragma(key,{simple:true});
  return {sha256:sum.digest('hex'),tables,pragmas,inTransaction:db.inTransaction};
}

/** A fresh directory and an exclusively owned coherent backup. Validate the image, never infer it from a racy pre-copy read. */
export async function backupDecisionGenesis(source:Db, freshDirectory:string, expectedLastConsumed:number) {
  requireValue(source.readonly && !source.inTransaction && !source.memory,'readonly_disk_source');
  requireValue(Number.isSafeInteger(expectedLastConsumed)&&expectedLastConsumed>0,'last_epoch');
  const directory=resolve(freshDirectory);
  requireValue(realpathSync(resolve(directory,'..'))===resolve(directory,'..'),'backup_parent_alias');
  mkdirSync(directory,{mode:0o700});
  const destination=join(directory,'genesis.sqlite');
  await source.backup(destination);
  const image=new Database(destination,{readonly:true,fileMustExist:true});
  try {
    requireValue(image.pragma('quick_check',{simple:true})==='ok','backup_integrity');
    const consumed=image.prepare('SELECT MAX(epoch) FROM paper_consumed_epochs').pluck().get();
    requireValue(consumed===expectedLastConsumed,'unexpected_epoch');
    for(const row of image.prepare('SELECT epoch FROM paper_replay_cursor').iterate() as Iterable<{epoch:string}>) {
      const match=/\/epoch-(\d{6})$/.exec(row.epoch);
      requireValue(match && Number(match[1])<=expectedLastConsumed,'incomplete_epoch_cursor');
      requireValue(image.prepare('SELECT 1 FROM paper_consumed_epochs WHERE epoch=?').get(Number(match[1])),'cursor_without_consumption');
    }
  } finally {image.close();}
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(destination))hash.update(chunk);
  return {path:destination,sha256:hash.digest('hex'),bytes:statSync(destination).size,lastConsumed:expectedLastConsumed};
}

export type DecisionSampleFrontier={epoch:string;sample:unknown;index:number;ordinal:number;appliedFrames:number;proofHead:string;at:Clock;randomState:number;current:boolean};
type Observation={kind:string;data:unknown};

/** All potentially failing observation reads are contained. A trace failure never becomes a policy exception. */
export class FirstDecisionRecorder {
  private phase:Phase='INITIAL';
  private failed:string|null=null;
  private generationStart:bigint|null=null;
  private tickSeen=false;
  private currentSample:DecisionSampleFrontier|null=null;
  private selectedSample:DecisionSampleFrontier|null=null;
  private inspecting=false;
  private traceBytes=0;
  private trace:Observation[]=[];
  private prefix:Observation[]=[];
  private applicationEffects:Observation[]=[];
  private applicationWitnessActive=false;
  private snapshots:Record<string,unknown>={};
  private disposition:'COMMITTED'|'ROLLED_BACK'|null=null;
  private elapsedNs:string|null=null;
  private db:Db|null=null;
  private undoDbMethods:(()=>void)[]=[];
  private verboseBound=false;
  private timerInitializations=new Map<number,{delayMs:number|null;repeatMs:number|null}>();
  private timeoutPrototype:object|null=null;
  private timerCallbacks=0;
  private timerWatchEnabled=false;
  private readonly timerWatch=createHook({
    init:(id,type,_trigger,resource)=>{
      if(type!=='Timeout'||!this.timerWatchEnabled)return;
      // Async-hook callbacks must remain synchronous and never throw or log.
      try {
        if(this.timerInitializations.size>=128){this.failed??='decision_checkpoint:timer_resource_budget';return;}
        const own=Object.getOwnPropertyDescriptor(resource,'_idleTimeout');
        const repeat=Object.getOwnPropertyDescriptor(resource,'_repeat');
        this.timeoutPrototype=Object.getPrototypeOf(resource);
        this.timerInitializations.set(id,{delayMs:own&&'value' in own&&typeof own.value==='number'?own.value:null,repeatMs:repeat&&'value' in repeat&&typeof repeat.value==='number'?repeat.value:null});
      } catch {this.failed??='decision_checkpoint:timer_observation_failed';}
    },
    before:(id)=>{
      if(!this.timerWatchEnabled)return;
      try {
        // Node20.14's emitBeforeScript pushes the actual resource even when its
        // init predates this hook. Do not infer callback absence from known ids.
        const resource=executionAsyncResource();
        const timeout=Object.getOwnPropertyDescriptor(resource,'_onTimeout');
        const delay=Object.getOwnPropertyDescriptor(resource,'_idleTimeout');
        const timerLike=Boolean(timeout&&delay);
        const samePrototype=this.timeoutPrototype!==null&&Object.getPrototypeOf(resource)===this.timeoutPrototype;
        if(this.timerInitializations.has(id)||timerLike||samePrototype){
          this.timerCallbacks++;
          this.failed??='decision_checkpoint:native_timeout_callback';
        }
      } catch {this.failed??='decision_checkpoint:timer_observation_failed';}
    },
  });
  constructor(readonly maxTraceBytes:number) {
    requireValue(Number.isSafeInteger(maxTraceBytes)&&maxTraceBytes>0,'trace_budget');
  }
  private protect(fn:()=>void) {
    if(this.failed!==null||this.phase==='SEALED')return;
    try {fn();} catch(error){this.failed=String(error);}
  }
  private append(to:Observation[],kind:string,value:unknown){
    const data=checkpointWire(value),size=Buffer.byteLength(JSON.stringify([kind,data]));
    requireValue(this.traceBytes+size<=this.maxTraceBytes,'trace_budget_exhausted');
    this.traceBytes+=size;to.push({kind,data});
  }
  private snapshot(name:string,read:()=>unknown){
    this.inspecting=true;
    try {this.snapshots[name]=checkpointWire(read());}finally{this.inspecting=false;}
  }
  /** Pass to the constructor of the isolated DB before preparing any original statements. */
  readonly nativeSQL=(sql:string)=>{
    if(this.inspecting)return;
    this.protect(()=>{
      if(this.applicationWitnessActive)this.append(this.applicationEffects,'SQLITE_TRACE',sql);
      if(this.inSample())this.append(this.trace,'SQLITE_TRACE',sql);
    });
  };
  bindPrivateDatabase(db:Db){
    requireValue(this.db===null&&!db.inTransaction&&!db.readonly,'fresh_private_connection');
    this.db=db;
    const prepare=db.prepare,exec=db.exec,self=this;
    const prepareOwn=Object.getOwnPropertyDescriptor(db,'prepare'),execOwn=Object.getOwnPropertyDescriptor(db,'exec');
    const restore=(name:'prepare'|'exec',descriptor:PropertyDescriptor|undefined)=>{
      if(descriptor)Object.defineProperty(db,name,descriptor);else Reflect.deleteProperty(db,name);
    };
    this.undoDbMethods.push(()=>restore('prepare',prepareOwn),()=>restore('exec',execOwn));
    Object.defineProperty(db,'prepare',{configurable:true,writable:true,value:function(this:Db,...args:unknown[]){
      const statement=Reflect.apply(prepare,this,args) as Database.Statement;
      const run=statement.run;
      try {
        Object.defineProperty(statement,'run',{configurable:true,writable:true,value:function(this:Database.Statement,...bound:unknown[]){
          if(this!==statement)self.failed??='decision_checkpoint:borrowed_statement_receiver';
          return self.observeWrite('run',statement.source,bound,()=>Reflect.apply(run,this,bound));
        }});
      } catch(error){self.failed=String(error);}
      return statement;
    }});
    Object.defineProperty(db,'exec',{configurable:true,writable:true,value:function(this:Db,sql:string){
      return self.observeWrite('exec',sql,[],()=>Reflect.apply(exec,this,[sql]));
    }});
  }
  /** Native SQLite verbose is distinct from JS run/exec. Require the native connection to emit its own sentinel. */
  confirmNativeTrace(db:Db){
    requireValue(db===this.db, 'connection_mismatch');
    // The caller must use the exact callback from traceCallback() when constructing this DB.
    this.verboseBound=false;
    db.prepare('SELECT 1 /* ENG035 native trace binding */').get();
    requireValue(this.verboseBound,'missing_native_verbose');
  }
  readonly traceCallback=(message?:unknown,...additionalArgs:unknown[])=>{
    if(typeof message!=='string'||additionalArgs.length!==0){
      this.failed??='decision_checkpoint:unsupported_native_verbose';
      return;
    }
    if(message==='SELECT 1 /* ENG035 native trace binding */')this.verboseBound=true;
    this.nativeSQL(message);
  };
  private inSample(){return this.phase==='SAMPLE'||this.phase==='TICK';}
  private observeWrite<T>(kind:string,sql:string,args:unknown[],call:()=>T):T {
    if(this.inspecting||(!this.inSample()&&!this.applicationWitnessActive))return call();
    const record=(name:string,value:unknown)=>this.protect(()=>{
      if(this.applicationWitnessActive)this.append(this.applicationEffects,name,value);
      if(this.inSample())this.append(this.trace,name,value);
    });
    record('WRITE_BEGIN',{kind,sql,args});
    try {
      const result=call();
      record('WRITE_RETURN',kind==='exec'?null:result);
      return result;
    } catch(error){
      record('WRITE_THROW',error);
      throw error;
    }
  }
  beginApplicationWitness(){
    requireValue(this.phase==='INITIAL'&&!this.applicationWitnessActive,'application_witness_start');
    this.applicationWitnessActive=true;
  }
  started(db:Db,read:()=>unknown){
    this.protect(()=>{
      requireValue(db===this.db&&this.verboseBound&&!db.inTransaction&&this.applicationWitnessActive,'initial_connection');
      this.snapshot('initial',read);
      this.phase='PREFIX';
      this.generationStart=process.hrtime.bigint();
      this.timerWatchEnabled=true;
      this.timerWatch.enable();
    });
  }
  initialized(read:()=>unknown){this.protect(()=>this.snapshot('initializedSession',read));}
  sample(frontier:DecisionSampleFrontier){
    this.protect(()=>{
      this.phase='SAMPLE';this.currentSample=structuredClone(frontier);this.trace=[];
      this.append(this.trace,'SAMPLE_DISPATCH',frontier);
    });
  }
  sampleEntry(read:()=>unknown){this.protect(()=>this.snapshot('preTTL',read));}
  event(kind:string,read:()=>unknown){
    if(!this.inSample())return;
    this.protect(()=>this.append(this.trace,kind,read()));
  }
  tick(read:()=>unknown){
    this.protect(()=>{
      requireValue(this.phase==='SAMPLE'&&this.currentSample?.current,'tick_without_current_sample');
      this.tickSeen=true;this.phase='TICK';this.selectedSample=this.currentSample;
      this.snapshot('tickEntry',read);
      this.append(this.trace,'TICK_ENTER',null);
    });
  }
  completed(disposition:'COMMITTED'|'ROLLED_BACK',state:Cursor,read:()=>unknown){
    if(!this.inSample())return;
    this.protect(()=>{
      if(!this.tickSeen){
        this.append(this.prefix,'PRIOR_SAMPLE',{frontier:this.currentSample,disposition,cursor:state});
        this.phase='PREFIX';this.currentSample=null;this.trace=[];
        return;
      }
      this.elapsedNs=(process.hrtime.bigint()-this.generationStart!).toString();
      this.disposition=disposition;this.append(this.trace,disposition,state);
      this.snapshot('postEnclosingTransaction',read);
      if(BigInt(this.elapsedNs)>=30_000_000_000n)this.failed='decision_checkpoint:timer_window';
      if(this.timerInitializations.size!==1||[...this.timerInitializations.values()][0]?.delayMs!==60000||[...this.timerInitializations.values()][0]?.repeatMs!==60000)
        this.failed??='decision_checkpoint:unsupported_timer_registration';
      this.timerWatchEnabled=false;
      this.timerWatch.disable();
      this.applicationWitnessActive=false;
      this.phase='SEALED';
    });
  }
  close(){
    this.applicationWitnessActive=false;
    this.timerWatchEnabled=false;
    this.timerWatch.disable();
    for(const undo of this.undoDbMethods.splice(0).reverse()){try{undo();}catch(error){this.failed=String(error);}}
    if(this.phase!=='SEALED'&&this.failed===null)this.failed=this.tickSeen?'decision_checkpoint:missing_transaction_end':'decision_checkpoint:no_actual_tick';
    this.phase='SEALED';
  }
  result(){
    return {schema:'PROSPECTIVE_FIRST_PAPER_TICK_OBSERVATION_V1',status:this.failed?'INCOMPLETE':this.phase==='SEALED'?'REQUIRES_INDEPENDENT_PARITY_AND_CUSTODY':'INCOMPLETE',
      reason:this.failed,disposition:this.disposition,selectedSample:this.selectedSample,elapsedToTransactionEndNs:this.elapsedNs,hostWindowNs:'30000000000',
      snapshots:this.snapshots,prefixSamples:this.prefix,orderedTrace:this.trace,applicationNativeEffects:this.applicationEffects,traceBytes:this.traceBytes,
      nativeTimerObservation:{api:'node:async_hooks',node:process.versions.node,uv:process.versions.uv,
        registrations:[...this.timerInitializations].map(([asyncId,timer])=>({asyncId,...timer})),beforeCallbacks:this.timerCallbacks,
        scope:'Enabled after initial digest and before original session construction, disabled at selected transaction end or close. Actual dispatch resource is checked, including timers registered before enabling. Any observed Timeout callback refuses capture; no timer lower-bound inferred from elapsed time alone.'},
      verifiedComplete:false,newIndependentEconomicLabels:0,actualRevenue:null};
  }
}
