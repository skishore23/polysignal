/** Private exporter, not an archive replay or an admission authority. Uses only FS and SHA-256. */
import {createHash} from 'node:crypto';
import {closeSync,constants,existsSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import type {DecisionSampleFrontier,EvidencePin} from './maker_decision_checkpoint';

type Clock={utc:number;mono:number};
export type VerifiedArchiveInventory={
  schema:'ENG035_PRIVATE_VERIFIED_ARCHIVE_INVENTORY_V1'; logicalEpoch:string; archiveDirectory:string;
  files:Record<string,string>;
};
export type ReviewedPrefixBoundary={
  schema:'ENG035_PRIVATE_SELECTED_SOURCE_FRONTIER_V3'; archiveInventorySha256:string; destination:string; identity:EvidencePin;
  frontier:DecisionSampleFrontier;
  // Supplied by the independent verifier. A frontier/count alone cannot prove noninterference.
  dependencies:{complete:boolean;usesLaterSource:boolean;latestRequiredWireNumber:number;latestRequiredSampleIndex:number};
};
/** A private, separately verified selection from the named four original HTTP bytes. */
export type ReviewedMarketIdentity={
  schema:'ENG035_INDEPENDENT_SELECTED_MARKET_IDENTITY_V1';archiveInventorySha256:string;marketId:string;
  condition:string;token:string;protocolVersion:'v1'|'v2';bodySha256:Record<'metadata'|'market'|'book'|'fee',string>;
};
export type PrefixExportRequest={inventory:EvidencePin;boundary:EvidencePin;destination:string;maxOutputBytes:number};
type WireSuccessor={kind:'WIRE';wireNumber:number;wireKind:string;at:Clock;segment:string;segmentSha256:string;
  indexEntrySha256:string;lineOffset:number;lineBytes:number;lineSha256:string;resultingHead:string};
type WireEOF={kind:'EOF';wireCount:number;segmentCount:number;finalHead:string};
type PrivateWireProof={schema:'ENG035_PRIVATE_SAMPLE_WIRE_SUCCESSORS_V1';inventorySha256:string;indexSha256:string;
  ledgerSha256:string;samples:{sampleNumber:number;head:string;afterWireNumber:number;successor:WireSuccessor|WireEOF}[]};
type PrefixResult={status:'EXPORTED';inputDirectory:string;manifestSha256:string;privateArchiveInventorySha256:string;privateBoundarySha256:string;privateWireProof:PrivateWireProof}|
  {status:'INCOMPLETE';reason:string};
const names=['metadata','market','book','fee'] as const;
const hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
const jsonLine=(v:unknown)=>Buffer.from(JSON.stringify(v)+'\n');
const shaPattern=/^[a-f0-9]{64}$/;
const next=(head:string,line:Buffer)=>createHash('sha256').update(Buffer.from(head,'hex')).update(line).digest('hex');
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
function check(v:unknown,reason:string):asserts v {if(!v)throw Error('decision_prefix:'+reason);}
function keys(v:unknown,expected:string[]) {
  check(v!==null&&typeof v==='object'&&!Array.isArray(v),'record_shape');
  const actual=Object.keys(v);check(actual.length===expected.length&&expected.every(k=>Object.prototype.hasOwnProperty.call(v,k)),'record_shape');
}
function count(v:unknown):v is number{return typeof v==='number' && Number.isSafeInteger(v)&&v>=0;}
function clock(v:Clock){keys(v,['utc','mono']);check(count(v.utc)&&Number.isFinite(v.mono)&&v.mono>=0,'clock');}
const le=(a:Clock,b:Clock)=>a.utc<=b.utc&&a.mono<=b.mono;
const sameClock=(a:Clock,b:Clock)=>a.utc===b.utc&&a.mono===b.mono;
const under=(p:string,root:string)=>p===root||p.startsWith(root+path.sep);

function boundedBytes(file:string,digest:string,max:number):Buffer {
  check(path.isAbsolute(file)&&path.resolve(file)===file&&realpathSync(file)===file&&shaPattern.test(digest),'file_identity');
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const st=fstatSync(fd);check(st.isFile()&&st.nlink===1&&st.size<=max,'file_type_or_size');
    const b=Buffer.allocUnsafe(st.size);
    let n=0;
    while(n<b.length){const got=readSync(fd,b,n,b.length-n,null);check(got>0,'truncated_file');n+=got;}
    const end=fstatSync(fd),named=lstatSync(file);
    check(st.size===end.size&&st.mtimeMs===end.mtimeMs&&st.ctimeMs===end.ctimeMs&&end.nlink===1&&
      end.ino===named.ino&&end.dev===named.dev&&realpathSync(file)===file&&hash(b)===digest,'file_changed_or_unpinned');
    return b;
  }finally{closeSync(fd);}
}
function* rawLines(buf:Buffer,max:number){
  for(let start=0;start<buf.length;){
    const end=buf.indexOf(10,start);check(end>=start&&end+1-start<=max,'line_length_or_termination');
    yield buf.subarray(start,end+1);start=end+1;
  }
}
function parse(line:Buffer){return JSON.parse(utf8.decode(line));}
function producerLine(line:Buffer){
  const value=parse(line);
  // The actual producer emits JSON.stringify + LF. Its archive verifier chains raw bytes;
  // its native replay uses readline + LF. Never normalize an ambiguous/nonproducer wire.
  check(jsonLine(value).equals(line),'unsupported_producer_encoding');
  return value;
}
function syncDir(p:string){const fd=openSync(p,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function epochFile(files:Record<string,string>,root:string,name:string,max:number){
  check(Object.prototype.hasOwnProperty.call(files,name),'missing_file_pin');
  return boundedBytes(path.join(root,name),files[name]!,max);
}
function validSample(s:any){
  keys(s,['number','at','processedFrames','proofHeadSha256']);clock(s.at);
  check(count(s.number)&&s.number>0&&count(s.processedFrames)&&shaPattern.test(s.proofHeadSha256),'sample_shape');
}

/** A trusted caller supplies exact independent inventory and decision-evidence pins outside the consumer input. */
export function exportDecisionPrefix(request:PrefixExportRequest):PrefixResult {
  let pending:string|undefined;
  const opened:number[]=[];
  try{
    const inv:VerifiedArchiveInventory=parse(boundedBytes(request.inventory.path,request.inventory.sha256,16*1024**2));
    const binding:ReviewedPrefixBoundary=parse(boundedBytes(request.boundary.path,request.boundary.sha256,2*1024**2));
    check(inv.schema==='ENG035_PRIVATE_VERIFIED_ARCHIVE_INVENTORY_V1'&&binding.schema==='ENG035_PRIVATE_SELECTED_SOURCE_FRONTIER_V3'&&
      binding.archiveInventorySha256===request.inventory.sha256,'custody_binding');
    const identity:ReviewedMarketIdentity=parse(boundedBytes(binding.identity.path,binding.identity.sha256,64*1024));
    check(identity.schema==='ENG035_INDEPENDENT_SELECTED_MARKET_IDENTITY_V1'&&identity.archiveInventorySha256===request.inventory.sha256&&
      ['v1','v2'].includes(identity.protocolVersion)&&typeof identity.condition==='string'&&/^0x[0-9a-fA-F]{64}$/.test(identity.condition)&&typeof identity.marketId==='string'&&/^\d+$/.test(identity.marketId)&&
      typeof identity.token==='string'&&/^(0|[1-9]\d{0,77})$/.test(identity.token)&&BigInt(identity.token)<(1n<<256n),'market_identity');
    const root=inv.archiveDirectory,dest=request.destination,s=binding.frontier,dep=binding.dependencies;
    check(Object.keys(inv.files).every(name=>name.length>0&&name.split('/').every(part=>part!==''&&part!=='.'&&part!=='..')&&!name.includes('\\')),'inventory_path');
    check(path.resolve(root)===root&&realpathSync(root)===root&&lstatSync(root).isDirectory(),'archive_root');
    check(path.isAbsolute(inv.logicalEpoch)&&path.resolve(inv.logicalEpoch)===inv.logicalEpoch&&s.epoch===inv.logicalEpoch,'epoch_binding');
    check(dep.complete===true&&dep.usesLaterSource===false&&count(dep.latestRequiredSampleIndex)&&dep.latestRequiredSampleIndex<=s.index&&
      count(dep.latestRequiredWireNumber),'source_dependency');
    check(s.current===true&&count(s.index)&&count(s.ordinal)&&count(s.appliedFrames)&&shaPattern.test(s.proofHead),'selected_frontier');
    clock(s.at);validSample(s.sample);const selected=s.sample as {number:number;at:Clock;processedFrames:number;proofHeadSha256:string};
    check(selected.number===s.index+1&&selected.proofHeadSha256===s.proofHead&&sameClock(s.at,selected.at)&&s.appliedFrames===selected.processedFrames,'sample_binding');
    check(binding.destination===dest&&path.isAbsolute(dest)&&path.resolve(dest)===dest&&realpathSync(path.dirname(dest))===path.dirname(dest)&&
      !under(dest,root)&&!under(root,dest)&&!under(dest,inv.logicalEpoch)&&!under(inv.logicalEpoch,dest)&&!existsSync(dest),'output_identity');
    check(count(request.maxOutputBytes)&&request.maxOutputBytes>0,'output_budget');
    mkdirSync(dest,{mode:0o700});const staging=path.join(dest,'.building');mkdirSync(staging,{mode:0o700});pending=staging;
    mkdirSync(path.join(staging,'http'),{mode:0o700});
    let outBytes=0;
    const files:Record<string,{bytes:number;sha256:string}>={};
    const sink=(name:string)=>{
      const fd=openSync(path.join(staging,name),'wx',0o600);opened.push(fd);
      const h=createHash('sha256');let bytes=0;
      return {write(b:Buffer){
        check(outBytes+b.length<=request.maxOutputBytes,'output_budget');
        writeFileSync(fd,b);h.update(b);bytes+=b.length;outBytes+=b.length;
      },finish(){fsyncSync(fd);files[name]={bytes,sha256:h.digest('hex')};}};
    };
    const write=(name:string,b:Buffer)=>{const target=sink(name);target.write(b);target.finish();};
    const input=(name:string,max:number)=>epochFile(inv.files,root,name,max);
    const ledger=parse(input('source/ledger.json',16*1024**2)),summary=parse(input('epoch-summary.json',32*1024**2));
    check(summary.reconciled===true&&summary.cleanupFailure===null&&JSON.stringify(summary.source)===JSON.stringify(ledger)&&
      ledger.schema==='OPERATING_CAPTURE_ATTEMPT_V1','closed_archive_binding');
    clock(ledger.startedAt);keys(ledger.policy,['segmentBodyBytes','segmentMessages','maxQueuedBytes','maxQueuedMessages','freeDiskReserveBytes','metadataUrl','expiresUtcMs']);
    for(const k of Object.keys(ledger.policy))if(k!=='metadataUrl')check(count(ledger.policy[k]),'source_policy');
    check(typeof ledger.policy.metadataUrl==='string'&&/^https:\/\/gamma-api\.polymarket\.com\/markets\/slug\/btc-updown-5m-[0-9]{10}$/.test(ledger.policy.metadataUrl),'source_policy');
    const slot=Number(ledger.policy.metadataUrl.slice(-10))*1000;
    check(slot%300000===0&&ledger.startedAt.utc>=slot&&ledger.startedAt.utc<=slot+240000&&
      ledger.policy.expiresUtcMs>ledger.startedAt.utc&&ledger.policy.expiresUtcMs<=slot+300000,'original_slot');
    function receiptClock(t:Clock,origin:Clock=ledger.startedAt){
      clock(t);check(le(origin,t)&&t.utc<ledger.policy.expiresUtcMs&&
        Math.abs((t.utc-origin.utc)-(t.mono-origin.mono))<=100,'source_clock_or_expiry');
    }
    check(ledger.http.policy?.metadataUrl===ledger.policy.metadataUrl&&ledger.http.policy.expiresUtcMs===ledger.policy.expiresUtcMs,'http_policy');
    clock(ledger.http.startedAt);check(le(ledger.startedAt,ledger.http.startedAt)&&ledger.http.policy.maxWallMs===300000,'http_origin');
    for(const bound of [ledger.market,ledger.http.market]){
      check(bound?.condition===identity.condition&&bound.token===identity.token&&bound.protocolVersion===identity.protocolVersion,'producer_market_binding');
    }
    const open=ledger.subscription?.at;
    receiptClock(open);check(ledger.subscription.raw===JSON.stringify({type:'market',assets_ids:[identity.token]}),'subscription_binding');
    const urls={metadata:ledger.policy.metadataUrl,market:'https://clob.polymarket.com/'+(identity.protocolVersion==='v2'?'clob-markets/':'markets/')+identity.condition,
      book:'https://clob.polymarket.com/book?token_id='+identity.token,fee:'https://clob.polymarket.com/fee-rate?token_id='+identity.token};
    const init=jsonLine({schema:ledger.schema,policy:ledger.policy,startedAt:ledger.startedAt});
    let head=hash(init),last:Clock=ledger.startedAt;
    check(head===ledger.proofSeedSha256,'proof_seed');write('source-init.json',init);
    const samples=sink('samples.ndjson'),wanted=new Map<string,{wire:number;data:number;at:Clock}|null>();
    const observations:{at:Clock;processedFrames:number;proofHeadSha256:string}[]=[];
    let prevSample:Clock=open,priorData=0;
    for(const line of rawLines(input('samples.ndjson',32*1024**2),16384)){
      if(observations.length===selected.number){
        // Native lookup uses index. A repeated/decreasing sample number makes the supplied identity ambiguous.
        const later=parse(line);check(count(later.number)&&later.number>selected.number,'ambiguous_sample_number');continue;
      }
      const row=producerLine(line);validSample(row);receiptClock(row.at);
      check(row.at.utc>prevSample.utc&&row.at.mono-prevSample.mono>=1000,'producer_sample_cadence');
      check(row.number===observations.length+1&&le(prevSample,row.at)&&row.processedFrames>=priorData,'sample_sequence');
      samples.write(line);observations.push(row);wanted.set(row.proofHeadSha256,null);prevSample=row.at;priorData=row.processedFrames;
      if(row.number===selected.number)check(row.processedFrames===selected.processedFrames&&row.proofHeadSha256===s.proofHead&&sameClock(row.at,s.at),'wrong_selected_sample');
    }
    check(observations.length===selected.number,'missing_selected_sample');samples.finish();
    let wire=0,data=0;
    const register=()=>{
      if(wanted.has(head)){check(wanted.get(head)===null,'ambiguous_proof_head');wanted.set(head,{wire,data,at:last});}
    };
    const receipts=sink('http-proofs.ndjson');
    check(ledger.httpProofs?.length===4&&ledger.http?.reads?.length===4,'http_count');
    let selectedOutcomes:{token:string;label:string}[]=[];
    for(const [i,name] of names.entries()){
      const proof=ledger.httpProofs[i],row=ledger.http.reads[i];
      keys(proof,['http','url','at','startedAt','status','sha256','bytes']);clock(proof.at);clock(proof.startedAt);
      const b=input('source/http/'+name+'.bin',2097152);
      receiptClock(proof.at,ledger.http.startedAt);receiptClock(proof.startedAt,ledger.http.startedAt);check(proof.at.mono-ledger.http.startedAt.mono<ledger.http.policy.maxWallMs,'http_deadline');
      check(proof.url===urls[name]&&row.url===urls[name],'original_http_endpoint');
      check(identity.bodySha256[name]===hash(b),'selected_body_binding');
      const body=parse(b);
      if(name==='metadata'){
        check(body&&typeof body==='object'&&!Array.isArray(body)&&body.slug==='btc-updown-5m-'+slot/1000&&
          body.version===identity.protocolVersion&&body.conditionId===identity.condition&&body.id===identity.marketId&&proof.at.utc<=slot+240000,'original_gamma_identity');
        const array=(v:unknown)=>typeof v==='string'?JSON.parse(v):v;
        const ids=body.version==='v2'?body.positionIds:array(body.clobTokenIds),labels=array(body.outcomes);
        check(Array.isArray(ids)&&ids.length===2&&ids[0]===identity.token&&ids[0]!==ids[1]&&
          ids.every(x=>typeof x==='string'&&/^(0|[1-9]\d{0,77})$/.test(x)&&BigInt(x)<(1n<<256n))&&
          Array.isArray(labels)&&labels.length===2&&labels.every(x=>typeof x==='string')&&['Up,Down','Down,Up','Yes,No','No,Yes'].includes(labels.join(',')),'original_token_pair');
        selectedOutcomes=ids.map((token,i)=>{
          const label=labels[i];
          check(typeof label==='string','original_token_pair');
          return {token,label};
        });
      }else if(name==='market'){
        const v2=identity.protocolVersion==='v2',members=v2?body.t:body.tokens;
        if(!v2)check(body.condition_id===identity.condition&&body.market_slug==='btc-updown-5m-'+slot/1000,'original_market_identity');
        else if(body.condition_id!==undefined)check(body.condition_id===identity.condition,'original_market_identity');
        check(Array.isArray(members)&&members.length===2&&selectedOutcomes.every(({token,label})=>members.some(m=>
          v2?m.t===token&&m.o===label:m.token_id===token&&m.outcome===label)),'original_token_pair');
      }else if(name==='book'){
        check(body.market===identity.condition&&body.asset_id===identity.token&&
          (identity.protocolVersion==='v2'?body.version==='v2':body.version===undefined),'original_book_identity');
      }else{check(body&&typeof body==='object'&&!Array.isArray(body)&&(body.token_id===undefined||body.token_id===identity.token),'original_fee_identity');}

      check(proof.http===name&&row.name===name&&typeof proof.url==='string'&&proof.url===row.url&&
        proof.status===200&&row.httpStatus===200&&row.status==='COMPLETED'&&proof.bytes===b.length&&row.bodyBytes===b.length&&
        hash(b)===proof.sha256&&row.sha256===proof.sha256&&le(last,proof.startedAt)&&le(proof.startedAt,proof.at)&&
        sameClock(proof.at,row.at)&&sameClock(proof.startedAt,row.startedAt),'http_binding');
      const line=jsonLine(proof);receipts.write(line);write('http/'+name+'.bin',b);
      head=next(head,line);last=proof.at;register();
      check(i===3||!wanted.has(head),'sample_before_complete_http');
    }
    receipts.finish();check(le(last,open),'subscription_order');
    const frames=sink('frames.ndjson');
    const index=input('source/segments.ndjson',16*1024**2);
    check(ledger.index?.closed===true&&count(ledger.index.segments)&&count(ledger.wsMessages)&&ledger.index.file==='segments.ndjson'&&ledger.index.bytes===index.length&&ledger.index.sha256===hash(index),'archive_index');
    // Merge samples with data callbacks by processedFrames. A sample's proof head records retention,
    // not the last applied receipt. Controls and raw PONG never advance the data callback count.
    let serial=0,scannedWire=0,sampleCursor=0,lastApplied:Clock=last,processedClock:Clock=last,lastWire:Clock=open;
    let scanHead=head,readThroughEOF=true;
    const successors=new Map<string,WireSuccessor>();
    function orderedApplication(t:Clock){
      check(le(processedClock,t)&&Math.abs((t.utc-processedClock.utc)-(t.mono-processedClock.mono))<=100,'decoder_clock_order');
      processedClock=t;
    }
    function samplesBefore(nextData?:Clock){
      while(sampleCursor<observations.length&&observations[sampleCursor]!.processedFrames===data){
        const sample=observations[sampleCursor++]!;
        check(le(lastApplied,sample.at)&&(!nextData||le(sample.at,nextData)),'sample_fifo');
        orderedApplication(sample.at);
      }
    }
    segments: for(const line of rawLines(index,4096)){
      const entry=producerLine(line);serial++;
      const file='frames-'+String(serial).padStart(6,'0')+'.ndjson';
      check(entry.segment===serial&&entry.file===file&&entry.firstNumber===scannedWire+1,'segment_identity');
      const segment=input('source/'+file,32*1024**2);
      check(segment.length===entry.journalBytes&&hash(segment)===entry.sha256,'segment_pin');
      const indexEntrySha256=hash(line);let records=0,segmentOffset=0;
      for(const raw of rawLines(segment,Math.ceil(2097152*4/3)+4096)){
        const rec=producerLine(raw);keys(rec,['number','kind','bytes','retainedBytes','complete','sha256','rawBase64','at']);receiptClock(rec.at);
        check(rec.number===++scannedWire&&count(rec.bytes)&&rec.bytes<=2097152&&rec.complete===true&&rec.retainedBytes===rec.bytes&&
          ['message','protocol_ping','protocol_pong'].includes(rec.kind)&&typeof rec.rawBase64==='string'&&le(lastWire,rec.at),'frame_identity_or_time');
        lastWire=rec.at;records++;
        const body=Buffer.from(rec.rawBase64,'base64');check(body.length===rec.bytes&&body.toString('base64')===rec.rawBase64&&hash(body)===rec.sha256,'frame_body');
        const before=scanHead;scanHead=next(before,raw);
        const position=wanted.get(before);
        if(position){
          check(position.wire===scannedWire-1&&!successors.has(before),'wire_successor_identity');
          successors.set(before,{kind:'WIRE',wireNumber:scannedWire,wireKind:rec.kind,at:rec.at,
            segment:file,segmentSha256:entry.sha256,indexEntrySha256,lineOffset:segmentOffset,lineBytes:raw.length,
            lineSha256:hash(raw),resultingHead:scanHead});
        }
        segmentOffset+=raw.length;
        const isData=rec.kind==='message'&&rec.rawBase64!=='UE9ORw==';
        if(head===s.proofHead){
          // Private look-ahead solely checks whether the selected sample skipped an already-enqueued data callback.
          // Never export the successor, its clock, or any after-cut wire count/hash in the input.
          if(isData){samplesBefore(rec.at);readThroughEOF=false;break segments;}
          continue;
        }
        check(le(rec.at,s.at),'frame_identity_or_time');
        if(isData){samplesBefore(rec.at);orderedApplication(rec.at);data++;lastApplied=rec.at;}
        wire=scannedWire;frames.write(raw);head=scanHead;last=rec.at;register();
      }
      check(records===entry.records&&entry.lastNumber===scannedWire,'segment_continuity');
    }
    if(readThroughEOF)check(serial===ledger.index.segments&&scannedWire===ledger.wsMessages&&scanHead===ledger.proofHeadSha256,'wire_eof_binding');
    samplesBefore();
    frames.finish();
    check(head===s.proofHead&&data===s.appliedFrames&&le(last,s.at)&&dep.latestRequiredWireNumber<=wire,'selected_head_or_dependency');
    check(sampleCursor===observations.length,'unmatched_processed_sample');
    const privateWireProof:PrivateWireProof={schema:'ENG035_PRIVATE_SAMPLE_WIRE_SUCCESSORS_V1',inventorySha256:request.inventory.sha256,
      indexSha256:hash(index),ledgerSha256:inv.files['source/ledger.json']!,samples:[]};
    let lastSampleWire=0;
    for(const row of observations){
      const position=wanted.get(row.proofHeadSha256);
      check(position&&position.data>=row.processedFrames,'prior_sample_outside_prefix');
      check(position.wire>=lastSampleWire,'sample_head_regression');lastSampleWire=position.wire;
      let successor:WireSuccessor|WireEOF|undefined=successors.get(row.proofHeadSha256);
      if(successor)check(le(row.at,successor.at),'sample_head_omits_wire');
      else{
        check(readThroughEOF&&row.proofHeadSha256===scanHead&&position.wire===scannedWire,'wire_successor_missing');
        successor={kind:'EOF',wireCount:scannedWire,segmentCount:serial,finalHead:scanHead};
      }
      privateWireProof.samples.push({sampleNumber:privateWireProof.samples.length+1,head:row.proofHeadSha256,afterWireNumber:position.wire,successor});
    }
    const manifest=jsonLine({schema:'ENG035_CAUSAL_SOURCE_PREFIX_V3',sourceShape:'PREFIX_ONLY',proofSeedSha256:ledger.proofSeedSha256,
      proofHeadSha256:head,through:{sampleNumber:selected.number,at:selected.at,processedFrames:data,wireFrames:wire},files});
    check(outBytes+manifest.length<=request.maxOutputBytes,'output_budget');
    const fd=openSync(path.join(staging,'prefix.json'),'wx',0o600);opened.push(fd);writeFileSync(fd,manifest);fsyncSync(fd);
    while(opened.length)closeSync(opened.pop()!);
    syncDir(path.join(staging,'http'));syncDir(staging);
    const published=path.join(dest,'input');renameSync(staging,published);pending=published;syncDir(dest);syncDir(path.dirname(dest));pending=undefined;
    return {status:'EXPORTED',inputDirectory:published,manifestSha256:hash(manifest),privateArchiveInventorySha256:request.inventory.sha256,privateBoundarySha256:request.boundary.sha256,privateWireProof};
  }catch(error){
    while(opened.length){try{closeSync(opened.pop()!);}catch{/* retained failure */}}
    if(pending){try{rmSync(pending,{recursive:true,force:true});}catch{return {status:'INCOMPLETE',reason:'PRIVATE_STAGING_CLEANUP_FAILED'};}}
    const msg=error instanceof Error?error.message:'';
    return {status:'INCOMPLETE',reason:msg.startsWith('decision_prefix:')?msg.slice(16):'SOURCE_IO_OR_FORMAT'};
  }
}
