/** Owner28 ordinary continuous SHADOW quoting. No fill simulator or live gateway. */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, realpathSync, lstatSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { OperatingSourceCapture } from "./maker_operating_capture";
import { createOperatingSourceState } from "./maker_operating_source_bridge";
import { currentSlotMetadataUrl } from "./maker_startup_capture";
import { selectCurrentBtcMarket, syncEngineInputs, REQUIRED_INPUTS } from "./maker_paper_startup";
import { createIsolatedMaker, installStartupSink, newIsolatedStartupDatabase, PAPER_PROFILES, type StartupContract, type StartupClock } from "./maker_quote_startup";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OWNER = path.resolve(ROOT, "../Emergent/docs/research/plans/ongoing-owner-2026-11-18/28-continuous-paper-operation-and-burst.txt");
export const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const json = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
function check(x: unknown, why: string): asserts x { if (!x) throw Error("maker_operating:" + why); }
export const OPERATING_PROTOCOL = {
  schema: "ORDINARY_PAPER_MAKER_OPERATING_V5", venue: "POLYMARKET_ONLY", profile: "OPERATING_BURST_V1",
  account: PAPER_PROFILES.OPERATING_BURST_V1, sizing: "soft20USDC*positive_regime; exact legal venue floor within hard limits",
  inventoryPreference: "configured K50bps at full200share capacity; changed prospective convention",
  noFills: true, noLiveOrders: true, noPi: true, rewards: false, stopAtFirstQuote: false,
  source: { slotMs: 300000, startBeforeCloseMs: 60000, readsPerAttempt: 4, socketsPerAttempt: 1,
    maxAttemptsPerSlot: 3, retryBackoffMs: [2000,10000], metadataRetryBackoffMs: [90000,90000],
    metadataNotReady: "missing only observed volume/liquidity: no quote; bounded fresh retries, then next fixed slot; generic selection failure remains fatal",
    tickChange: "validated original-token tick event cancels and requires four fresh reads; never change grid in place",
    oldDelta: "fully validated singleton old delta cancels and requires four fresh reads/history; never apply or continue the old chain",
    emptyBook: "cancel and fresh resync within existing attempts; malformed side schema remains correctness fault", rawFrameMaxBytes: 2097152,
    segmentBodyBytes: 8388608, segmentMessages: 20000, maxQueuedBytes: 8388608, maxQueuedMessages: 4000,
    maxTradesPerSlot: 20000, reconnect: "fresh explicit attempt; cancel and reset history; no continuous-gap claim" },
  tickMs: 1000, ttlMs: 5000, watchdogMs: 250, sourceMaxAgeMs: 1000,
  capacity: { minimumFreeDiskBytes: 8589934592, processRssMaxBytes: 1073741824 },
  lifetime: "standing until owner stop or correctness/capacity boundary; no silent financial or scientific authority",
  marketTransition: "zero reservations and virtual bank100 before next original market; no repeated additive funding",
  inference: "quote lifecycle engineering only; no realized fills, PnL, learned search or advantage",
} as const;
export const OPERATING_INPUTS = [...new Set([...REQUIRED_INPUTS,
  "scripts/research/maker_operating.ts", "scripts/research/maker_operating_service.py",
  "scripts/research/maker_operating_capture.ts", "scripts/research/maker_operating_source_bridge.ts",
  "apps/worker/src/maker/budgetQuoteSizing.ts"] )].sort();
export function operatingInputHashes() { return Object.fromEntries(OPERATING_INPUTS.map(p => [p, sha(readFileSync(path.join(ROOT,p)))])); }
export type OperatingAdmission = { schema: "STANDING_PAPER_MAKER_ADMISSION_V1"; runName: string;
  inputMode: "CURRENT_PUBLIC_CAPTURE" | "OFFLINE_FIXTURE"; notBeforeUtcMs: number; protocolSha256: string;
  carryFrom?: { runName:string; stateSha256:string };
  inputSha256: Record<string,string>; owner28Sha256: string; reviewFile: string; reviewSha256: string };
export function validateOperatingAdmission(a: OperatingAdmission, now: StartupClock, offline = false) {
  check(a.schema === "STANDING_PAPER_MAKER_ADMISSION_V1" && /^maker-operating-[a-zA-Z0-9_-]{1,80}$/.test(a.runName), "admission");
  check(["CURRENT_PUBLIC_CAPTURE","OFFLINE_FIXTURE"].includes(a.inputMode) && (!offline || a.inputMode === "OFFLINE_FIXTURE"), "evidence_mode");
  check(Number.isSafeInteger(a.notBeforeUtcMs) && now.utc >= a.notBeforeUtcMs, "not_before");
  check(a.owner28Sha256 === sha(readFileSync(OWNER)) && a.protocolSha256 === sha(json(OPERATING_PROTOCOL)), "authority_or_protocol");
  const hashes = operatingInputHashes();
  check(Object.keys(a.inputSha256).length === OPERATING_INPUTS.length && OPERATING_INPUTS.every(p => hashes[p] === a.inputSha256[p]), "source_drift");
  const raw = readFileSync(a.reviewFile); check(sha(raw) === a.reviewSha256, "review_hash"); const r = JSON.parse(raw.toString());
  check(r.decision === "APPROVE_STANDING_PAPER_OPERATION" && r.runName === a.runName && r.inputMode === a.inputMode
    && r.protocolSha256 === a.protocolSha256 && r.owner28Sha256 === a.owner28Sha256
    && ((!r.carryFrom && !a.carryFrom) || (r.carryFrom && a.carryFrom
      && r.carryFrom.runName===a.carryFrom.runName && r.carryFrom.stateSha256===a.carryFrom.stateSha256))
    && OPERATING_INPUTS.every(p => r.inputSha256[p] === hashes[p]), "independent_operating_admission");
}
export function isUnavailableEmptyBook(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "maker_source:empty_book_side"
    || error.message === "operating:Error: maker_source:empty_book_side:";
}
/** Exact clean causes only: an archive/schema failure appended by cleanup stays fatal. */
export function operatingUnavailableReason(error: unknown): "empty_book"|"metadata_not_ready"|"tick_size_change"|"backdated_delta"|null {
  if (!(error instanceof Error)) return null;
  if(isUnavailableEmptyBook(error))return "empty_book";
  if(error.message === "maker_operating:source_metadata:OBSERVED_MARKET_VOLUME_AND_LIQUIDITY")return "metadata_not_ready";
  if(error.message === "maker_source:validated_tick_size_change"
    || error.message === "operating:Error: maker_source:validated_tick_size_change:")return "tick_size_change";
  if(error.message === "maker_source:validated_backdated_delta"
    || error.message === "operating:Error: maker_source:validated_backdated_delta:")return "backdated_delta";
  return null;
}
function atomic(file: string, value: unknown) { const tmp = file + "." + randomUUID() + ".tmp"; writeFileSync(tmp,json(value),{flag:"wx",mode:0o600}); renameSync(tmp,file); }
export function reconcileOperatingDatabase(file: string, utc: number, allowedRunDirectory: string) {
  const resolved = path.resolve(file), allowed = path.resolve(allowedRunDirectory);
  check(allowed.startsWith(path.resolve(ROOT,"reports/evidence")+path.sep) && realpathSync(allowed) === allowed, "recovery_run_scope");
  check(/^epoch-[0-9]{6}\/paper\.sqlite$/.test(path.relative(allowed,resolved).split(path.sep).join("/")), "recovery_scope");
  for(let p=resolved;p!==allowed;p=path.dirname(p))check(!lstatSync(p).isSymbolicLink(), "recovery_symlink");
  check(realpathSync(resolved) === resolved,"recovery_identity");
  const db = new Database(resolved,{fileMustExist:true});
  try {
    const opening = JSON.parse((db.prepare("SELECT record FROM startup_opening").get() as any).record);
    check(opening.paperProfile === "OPERATING_BURST_V1" && opening.cashUSDC === "100", "recovery_opening");
    check((db.prepare("SELECT COUNT(*) n FROM shadow_fills").get() as any).n === 0, "unexpected_fill_recovery");
    check((db.prepare("SELECT COUNT(*) n FROM shadow_orders WHERE execution_mode!='SHADOW' OR external_order_id IS NOT NULL OR filled_size!=0").get() as any).n === 0, "recovery_order_scope");
    const before = (db.prepare("SELECT COUNT(*) n FROM shadow_orders WHERE status='OPEN'").get() as any).n;
    db.prepare("UPDATE shadow_orders SET status='CANCELLED',last_update_ts=MAX(last_update_ts,?) WHERE status='OPEN'").run(utc);
    check((db.prepare("SELECT COUNT(*) n FROM shadow_orders WHERE status IN ('OPEN','PENDING','PARTIAL')").get() as any).n === 0, "unreleased_reservations");
    const missingEvidence=(db.prepare("SELECT id FROM shadow_orders ORDER BY id").all() as any[])
      .filter(o=>!existsSync(path.join(path.dirname(file),"quote-"+String(o.id).padStart(6,"0")+".json"))).length;
    return { cancelled:before, unverifiedCrashTailOrders:missingEvidence, virtualCashUSDC:"100", allSharesZero:true, pendingLiabilityUSDC:"0", fills:0, profitUSDC:null };
  } finally { db.close(); }
}
type Capture = Pick<OperatingSourceCapture,"readMetadata"|"bindMarket"|"readMarket"|"readBook"|"readFee"|"stream"|"settleCallbacks"|"observationFrontier"|"proofHeadSha256"|"stop"|"ledger">;
type Sink = ReturnType<typeof installStartupSink>;
export async function runOperatingMaker(admissionFile: string, test?: { clock:()=>StartupClock;
  makeCapture:(slot:number,attempt:number,dir:string)=>Capture; wait:(ms:number)=>Promise<void>; maxSlots:number;
  config?:any; disableWatchdog?:boolean }) {
  const now = test?.clock ?? (()=>({utc:Date.now(),mono:performance.now()}));
  const rawAdmission = readFileSync(admissionFile), admission:OperatingAdmission=JSON.parse(rawAdmission.toString());
  validateOperatingAdmission(admission,now(),!!test);
  const runDir = path.join(ROOT,"reports/evidence",admission.runName);
  if (!existsSync(runDir)) mkdirSync(runDir,{mode:0o700});
  check(realpathSync(runDir) === runDir,"isolated_run_identity");
  const frozen = path.join(runDir,"frozen-admission.json");
  if (existsSync(frozen)) check(readFileSync(frozen).equals(rawAdmission),"restart_admission_change");
  else writeFileSync(frozen,rawAdmission,{flag:"wx",mode:0o600});
  if (!test) {
    const fd=Number(process.env.PAPER_MAKER_LOCK_FD), lock=process.env.PAPER_MAKER_LOCK_PATH;
    check(Number.isSafeInteger(fd) && fd>=3 && lock === path.join(ROOT,"reports/evidence/maker-operating-account.lock"),"kernel_lock_launcher_required");
    check(fstatSync(fd).ino === statSync(lock!).ino && fstatSync(fd).dev === statSync(lock!).dev,"kernel_lock_identity");
  }
  // Own immutable copies prevent RegimeGate's reload timer from admitting model drift.
  const frozenConfig=structuredClone(test?.config ?? JSON.parse(readFileSync(path.join(ROOT,"configs/worker.json"),"utf8")));
  frozenConfig.executionMode="PAPER";
  const modelDir=path.join(runDir,"frozen-models");if(!existsSync(modelDir))mkdirSync(modelDir,{mode:0o700});
  const modelCopies:{file:string;source:string}[]=[];
  for(const key of ["markovPath","strategyPath","manifestPath"]){
    const source=path.relative(ROOT,path.resolve(ROOT,frozenConfig.regimeGating[key]));
    check(source in admission.inputSha256,"unpinned_model_path");const raw=readFileSync(path.join(ROOT,source));
    check(sha(raw)===admission.inputSha256[source],"model_drift");
    const file=path.join(modelDir,path.basename(source));
    if(!existsSync(file)){writeFileSync(file,raw,{flag:"wx",mode:0o400});chmodSync(file,0o400);}
    check(sha(readFileSync(file))===admission.inputSha256[source],"frozen_model_drift");
    modelCopies.push({file,source});frozenConfig.regimeGating[key]=file;
  }
  const manifest=JSON.parse(readFileSync(frozenConfig.regimeGating.manifestPath,"utf8"));
  check(manifest.markovFile===path.basename(frozenConfig.regimeGating.markovPath)
    && manifest.strategyFile===path.basename(frozenConfig.regimeGating.strategyPath),"manifest_model_scope");
  const verifyReviewedInputs=()=>check(OPERATING_INPUTS.every(p=>sha(readFileSync(path.join(ROOT,p)))===admission.inputSha256[p])
    && modelCopies.every(p=>sha(readFileSync(p.file))===admission.inputSha256[p.source])
    && sha(readFileSync(OWNER))===admission.owner28Sha256,"runtime_source_drift");
  const stateFile=path.join(runDir,"state.json"), events=path.join(runDir,"events.ndjson"), stopFile=path.join(runDir,"STOP");
  let carry:any=null;
  if(!existsSync(stateFile) && admission.carryFrom){
    check(/^maker-operating-[a-zA-Z0-9_-]{1,80}$/.test(admission.carryFrom.runName)
      && admission.carryFrom.runName!==admission.runName,"carry_scope");
    const priorDir=path.join(ROOT,"reports/evidence",admission.carryFrom.runName);check(realpathSync(priorDir)===priorDir,"carry_identity");
    const priorRaw=readFileSync(path.join(priorDir,"state.json"));check(sha(priorRaw)===admission.carryFrom.stateSha256,"carry_state_hash");
    carry=JSON.parse(priorRaw.toString());
    check(carry.schema==="OPERATING_PAPER_STATE_V1" && carry.virtualCashUSDC==="100" && carry.activeDatabase===null
      && carry.activeOrders===0 && carry.pendingLiabilityNumerator==="0" && carry.fills===0
      && ["STOPPED","OFFLINE_FINISHED"].includes(carry.status),"carry_unreconciled");
    carry={...carry,carriedFrom:admission.carryFrom,sourceAdmissionChanged:true};
  }
  const state:any=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,"utf8")):carry??{schema:"OPERATING_PAPER_STATE_V1",virtualCashUSDC:"100",epoch:0,totalQuotes:0,totalTicks:0,totalSamples:0,totalCancellations:0};
  check(state.virtualCashUSDC==="100" && state.schema==="OPERATING_PAPER_STATE_V1","account_state");
  const emit=(kind:string,data:any={})=>appendFileSync(events,JSON.stringify({kind,at:now(),...data})+"\n",{mode:0o600});
  if (state.activeDatabase) { const recovered=reconcileOperatingDatabase(state.activeDatabase,now().utc,runDir);emit("RESTART_RECONCILED",recovered);state.totalCancellations=(state.totalCancellations??0)+recovered.cancelled;state.unverifiedCrashTailOrders=(state.unverifiedCrashTailOrders??0)+recovered.unverifiedCrashTailOrders;state.activeDatabase=null; }
  state.pid=process.pid;state.startedAt=now();state.status="RUNNING";state.stopReason=null;state.fault=null;state.profitUSDC=null;state.fills=0;state.inputMode=admission.inputMode;
  let stopping=false, stopReason="operator_stop", capture:Capture|null=null, sink:Sink|null=null, currentBook:any=null, appliedFrames=0;
  const stop=(why:string)=>{stopping=true;stopReason=why;capture?.stop(why);};
  const signal=()=>stop("signal_stop"); if (!test) {process.on("SIGTERM",signal);process.on("SIGINT",signal);}
  const save=()=>atomic(stateFile,{...state,lastHeartbeat:now(),processRssBytes:process.memoryUsage().rss});
  const cancel=(reason:string)=>{if(!sink)return;const active=sink.snapshot().orders.filter((o:any)=>o.status==="OPEN").length;
    if(active){const terminal=sink.cancelAll();state.totalCancellations+=active;state.activeOrders=0;state.pendingLiabilityNumerator="0";emit("CANCEL",{reason,count:active,terminal});}};
  const wait=test?.wait ?? (async(ms:number)=>{const end=performance.now()+ms;while(!stopping && performance.now()<end)await new Promise(r=>setTimeout(r,Math.min(250,end-performance.now())));});
  let watchdog:ReturnType<typeof setInterval>|undefined;
  if (!test?.disableWatchdog) watchdog=setInterval(()=>{try{
    if(existsSync(stopFile)){stop("operator_stop_file");cancel("operator_stop");}
    if(process.memoryUsage().rss>OPERATING_PROTOCOL.capacity.processRssMaxBytes){stop("capacity_rss");cancel("capacity_rss");}
    if(sink){const clock=now(),f=capture?.observationFrontier();
      const s=sink.snapshot();const expired=s.orders.some((o:any)=>o.status==="OPEN" && o.expected_cancel_ts<=clock.utc);
      if(expired || !f?.open || f.sequence!==appliedFrames || !currentBook || clock.utc>=state.marketEndUtc || clock.utc-currentBook.venueUtc>1000 || clock.mono-currentBook.receipt.mono>1000)
        cancel(expired?"TTL":"stale_closed_or_market_end");}
    save();
  }catch(e){state.fault=String(e);stop("watchdog_fault");}},OPERATING_PROTOCOL.watchdogMs);
  let finishedSlots=0;
  if(existsSync(stopFile))stop("operator_stop_file");
  try {
    while(!stopping && (!test || finishedSlots<test.maxSlots)) {
      const slot=Math.floor(now().utc/300000)*300000;
      if(now().utc>slot+240000){state.status="WAITING_NEXT_SLOT";save();await wait(slot+300000-now().utc+1);continue;}
      state.status="RUNNING";
      for(let attempt=(state.marketSlot===slot ? (state.attempt ?? 0) : 0)+1;attempt<=OPERATING_PROTOCOL.source.maxAttemptsPerSlot && !stopping;attempt++) {
        if(now().utc>slot+240000)break;
        verifyReviewedInputs();
        state.epoch++; const epoch=state.epoch,dir=path.join(runDir,"epoch-"+String(epoch).padStart(6,"0"));
        mkdirSync(dir,{mode:0o700});state.marketEndUtc=slot+300000;state.marketSlot=slot;state.attempt=attempt;state.lastEpochDirectory=dir;save();
        capture=test?.makeCapture(slot,attempt,path.join(dir,"source")) ?? new OperatingSourceCapture({metadataUrl:currentSlotMetadataUrl(slot),expiresUtcMs:slot+300000,
          freeDiskReserveBytes:OPERATING_PROTOCOL.capacity.minimumFreeDiskBytes},now,path.join(dir,"source"));
        let db:Database.Database|null=null,engine:ReturnType<typeof createIsolatedMaker>|null=null,lastTick=-Infinity,knownQuotes=0;
        appliedFrames=0;
        let normalEnd=false,availability:ReturnType<typeof operatingUnavailableReason>=null;currentBook=null;sink=null;const seen=new Set<string>();
        const samplesFile=path.join(dir,"samples.ndjson"),samplesFd=openSync(samplesFile,"ax",0o600);
        let sampleHead=sha("OPERATING_ACTUAL_SAMPLE_CLOCKS_V1"),sampleRecords=0,sampleBytes=0;
        const sourceClock=()=>{const f=capture!.observationFrontier();return {...now(),sourceSequence:f.sequence,sourceAvailable:f.open};};
        const logFile=path.join(dir,"engine.ndjson");const logger:any=Object.fromEntries(["info","warn","error","debug","trace","fatal"].map(level=>[level,(...args:any[])=>appendFileSync(logFile,JSON.stringify({level,at:now(),args})+"\n",{mode:0o600})]));
        try {
          const gamma=await capture.readMetadata();if(stopping)break;
          const selection=selectCurrentBtcMarket(gamma);check(selection.selected,"original_market_not_eligible");
          const selected=selection.selected!,first=selected.outcomes[0]!;
          capture.bindMarket({condition:selected.condition_id,token:first.token_id,protocolVersion:selected.protocol_version});
          const clobMarket=await capture.readMarket(),clobBook=await capture.readBook(),tokenFee=await capture.readFee();if(stopping)break;
          const config=frozenConfig;
          check(config.belief?.sportsbook?.enabled===false,"external_belief_forbidden");
          const sources=createOperatingSourceState({gamma,selection,clobMarket,clobBook,tokenFee,originalLabel:first.label,topKLevels:config.topN,decision:now()}, {maxTradesPerSlot:20000});
          const initial=sources.snapshot(now());const permanent=initial.missing.filter(x=>!["OBSERVED_VOLATILITY_HISTORY","OBSERVED_ORIGINAL_TOKEN_TRADE_FLOW","CURRENT_CANONICAL_FEATURE_SAMPLE","FRESH_AUTHORITATIVE_ORIGINAL_BOOK"].includes(x));
          check(!permanent.length,"source_metadata:"+permanent.join(","));
          state.marketId=selected.market_id;emit("SOURCE_ATTEMPT_OPEN",{epoch,slot,attempt,conditionHash:sha(selected.condition_id),sourceHashes:initial.sourceHashes});save();
          const term=await capture.stream({shouldStop:()=>stopping,
            onMessage:async frame=>{appliedFrames++;sources.process({kind:"frame",raw:frame.raw,at:frame.at});const d=sources.bookStatus(frame.at);currentBook=d.book;
              if(d.bookInvalidation || !d.fresh)cancel("source_book_inapplicable");},
            onSample:async at=>{
              state.totalSamples++;sampleRecords++;
              const sampleLine=JSON.stringify({number:sampleRecords,at,processedFrames:appliedFrames,proofHeadSha256:capture!.proofHeadSha256()})+"\n";
              appendFileSync(samplesFd,sampleLine);fsyncSync(samplesFd);sampleBytes+=Buffer.byteLength(sampleLine);
              sampleHead=sha(Buffer.concat([Buffer.from(sampleHead,"hex"),Buffer.from(sampleLine)]));
              sources.process({kind:"sample",at});const d=sources.snapshot(at);currentBook=d.book;
              state.lastMissing=d.missing;state.lastBookInvalidation=d.bookInvalidation;
              if(d.missing.length){cancel("missing_current_inputs");save();return;}
              if(at.mono-lastTick<1000)return;
              const head=capture!.proofHeadSha256(),captureSha256=sha(JSON.stringify({sourceHashes:d.sourceHashes,head,processedFrames:appliedFrames,at,sampleHead,sampleRecords}));
              const common={paperProfile:"OPERATING_BURST_V1" as const,
                executionDeadlineUtc:slot+300000,sourceFrontier:appliedFrames,market:d.identity.market,condition:d.identity.condition,wallet:1,
                tokens:d.identity.outcomes.map(o=>o.token) as [string,string],book:{...d.book,sourceHash:captureSha256,valid:true},fee:d.fee};
              const contract:StartupContract=admission.inputMode==="OFFLINE_FIXTURE"
                ? {...common,purpose:"SYNTHETIC_OFFLINE_ENGINEERING"}
                : {...common,purpose:"PROSPECTIVE_PAPER_ENGINEERING",evidence:{admissionSha256:sha(rawAdmission),captureSha256,
                    mode:"PUBLIC_POLYMARKET_READ_ONLY",protocolVersion:selected.protocol_version}};
              if(!db){db=newIsolatedStartupDatabase(path.join(dir,"paper.sqlite"),readFileSync(path.join(ROOT,"tests/maker/fixtures/startup-canonical-schema.sql"),"utf8"));
                sink=installStartupSink(db,contract,sourceClock);db.prepare("INSERT INTO wallets(id,name,starting_balance,created_at,maker_enabled,auto_trade_enabled,maker_inventory_max_abs) VALUES (1,'Owner28 one virtual bank carry',100,?,1,0,200)").run(at.utc);
                state.activeDatabase=path.join(dir,"paper.sqlite");save();engine=createIsolatedMaker(db,config,logger);
              }else sink!.updateObservation(contract);
              verifyReviewedInputs();
              syncEngineInputs(db,d,seen);lastTick=at.mono;
              try{await engine!.tick();state.totalTicks++;}
              catch(e){cancel("tick_rejected");emit("TICK_REJECTED",{epoch,error:String(e)});if(!String(e).includes("startup:") && !String(e).includes("user-defined function"))throw e;}
              const snap=sink!.snapshot(),count=snap.orders.length;
              if(count>knownQuotes){const added=count-knownQuotes;state.totalQuotes+=added;knownQuotes=count;
                const evidence={schema:"OPERATING_PAPER_QUOTE_EVIDENCE_V1",at:now(),sampleAt:at,epoch,proofHeadSha256:head,processedFrames:appliedFrames,
                  samples:{file:"samples.ndjson",records:sampleRecords,bytes:sampleBytes,headSha256:sampleHead},
                  metadataSourceHashes:d.sourceHashes,book:d.book,feature:d.feature,gate:engine!.getGateDiagnostics(),snapshot:snap};
                const quoteFile=path.join(dir,"quote-"+String(count).padStart(6,"0")+".json");writeFileSync(quoteFile,json(evidence),{flag:"wx",mode:0o600});
                if(!state.firstQuoteEvidence)state.firstQuoteEvidence=quoteFile;state.lastQuoteEvidence=quoteFile;emit("PAPER_QUOTE",{epoch,count,added,evidence:quoteFile});
              }
              state.activeOrders=snap.orders.filter((o:any)=>o.status==="OPEN").length;state.pendingLiabilityNumerator=snap.pendingLiabilityNumerator;save();
            }});
          normalEnd=term.reason==="slot_deadline" || now().utc>=slot+300000 || stopping;
          emit("SOURCE_ATTEMPT_END",{epoch,termination:term});
        } catch(e){state.lastSourceFault=String(e);emit("SOURCE_ATTEMPT_FAULT",{epoch,error:String(e)});
          if(now().utc>=slot+300000)normalEnd=true;
          else if((availability=operatingUnavailableReason(e))) {
            cancel("source_"+availability);
            emit(availability==="empty_book"?"EMPTY_BOOK_RESYNC":"SOURCE_UNAVAILABLE_RESYNC",{epoch,slot,attempt,reason:availability});
          }
          else if(String(e).includes("maker_source:") || String(e).includes("maker_operating_source:") || String(e).includes("source_metadata:") || String(e).includes("maker_operating:"))stop("source_correctness_fault");
        } finally {
          const finalCapture=capture as Capture;
          let cleanupFailure:unknown=null, reconciled=false;
          try { finalCapture.stop("attempt_cleanup"); await finalCapture.settleCallbacks(); }
          catch(e) { cleanupFailure=e; }
          const finalSink=sink as Sink|null;
          try {
            if(finalSink){cancel("attempt_end");const terminal=finalSink.cancelAll();
              check(terminal.syntheticCashUSDC==="100" && terminal.pendingLiabilityUSDC==="0" && terminal.fills===0,"terminal_bank");
              emit("TERMINAL_RECONCILED",{epoch,terminal});
              writeFileSync(path.join(dir,"terminal.json"),json({terminal,snapshot:finalSink.snapshot()}),{flag:"wx",mode:0o600});}
            reconciled=true;
          } catch(e) { cleanupFailure ??= e; }
          finally { if(db)(db as Database.Database).close();closeSync(samplesFd); sink=null; currentBook=null; }
          if(reconciled){state.activeDatabase=null;state.activeOrders=0;state.pendingLiabilityNumerator="0";}
          atomic(path.join(dir,"epoch-summary.json"),{epoch,slot,attempt,normalEnd,source:finalCapture.ledger(),
            virtualCashUSDC:"100",fills:0,profitUSDC:null,reconciled,cleanupFailure:cleanupFailure?String(cleanupFailure):null});
          capture=null;save();
          if(cleanupFailure)throw cleanupFailure;
        }
        if(normalEnd || stopping)break;
        if(attempt<3 && now().utc<=slot+240000){
          const backoffMs=(availability==="metadata_not_ready"?OPERATING_PROTOCOL.source.metadataRetryBackoffMs:OPERATING_PROTOCOL.source.retryBackoffMs)[attempt-1]!;
          state.status="WAITING_SOURCE_RESYNC";emit("FRESH_RESYNC_GAP",{slot,nextAttempt:attempt+1,reason:availability,backoffMs});save();await wait(backoffMs);state.status="RUNNING";
        }
      }
      finishedSlots++;if(!stopping && (!test || finishedSlots<test.maxSlots)){state.status="WAITING_NEXT_SLOT";save();await wait(Math.max(1,slot+300000-now().utc+1));}
    }
    state.status=stopping?"STOPPED":"OFFLINE_FINISHED";state.stopReason=stopReason;
  } catch(e){state.status="FAULTED";state.fault=String(e);throw e;}
  finally {if(watchdog)clearInterval(watchdog);
    try { capture?.stop("shutdown");if(capture)await capture.settleCallbacks(); }
    finally {cancel("shutdown"); if(!test){process.off("SIGTERM",signal);process.off("SIGINT",signal);}
      save();emit("SERVICE_CHECKPOINT",{status:state.status,quotes:state.totalQuotes,virtualCashUSDC:"100",fills:0,profitUSDC:null});}}
  return state;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  check(process.argv.length===4 && process.argv[2]==="--admission","usage_admission_required");
  runOperatingMaker(process.argv[3]!).catch(e=>{console.error(String(e));process.exitCode=1;});
}
