import {afterEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {exportDecisionPrefix,type ReviewedPrefixBoundary,type VerifiedArchiveInventory,type ReviewedMarketIdentity} from '../../scripts/research/maker_decision_prefix_v4';

const roots:string[]=[];
afterEach(()=>{for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true});});
const line=(v:unknown)=>Buffer.from(JSON.stringify(v)+'\n');
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
const chain=(h:string,b:Buffer)=>sha(Buffer.concat([Buffer.from(h,'hex'),b]));
const time=(i:number)=>({utc:1800000000000+i,mono:i});
type ControlKind='protocol_ping'|'protocol_pong'|'text_PONG';
type WireProbe={subject:'earlier'|'selected';control:ControlKind;delta:number;coordinate?:'utc'|'mono'};
type Options={wireProbe?:WireProbe;terminal?:boolean;badEOF?:'wireCount'|'segments'|'finalHead';tail?:string;noWire?:boolean;duplicateSelected?:boolean;priorLaterHead?:boolean;
  wrongCount?:boolean;futureClock?:boolean;unsafeSegment?:boolean;crlf?:boolean;extraFrame?:boolean;duplicateKey?:boolean;missingBodyPin?:boolean;
  endpoint?:(typeof names)[number];v1?:boolean;wrongVersionRoute?:boolean;wrongTokenPair?:boolean;wrongGammaToken?:boolean;wrongMarketCondition?:boolean;wrongOuterToken?:boolean;wrongBookToken?:boolean;wrongFeeToken?:boolean;
  wrongBoundToken?:boolean;wrongSubscription?:boolean;wrongIdentityBody?:boolean;slotExpired?:boolean;originSkew?:boolean;badFirstCadence?:boolean;
  badNextCadence?:boolean;flatUtc?:boolean;shortUtc?:boolean;earlyOutsideCut?:boolean;lateApplied?:'utc'|'mono';earlyUnapplied?:'utc'|'mono';withheld?:boolean;equalFIFO?:boolean};
const names=['metadata','market','book','fee'] as const;

function authored(opts:Options={}){
  const home=mkdtempSync(path.join(realpathSync(tmpdir()),'eng035-prefix-'));roots.push(home);
  const root=path.join(home,'epoch-000001'),source=path.join(root,'source');mkdirSync(path.join(source,'http'),{recursive:true});
  const files:Record<string,string>={};
  const write=(name:string,b:Buffer)=>{writeFileSync(path.join(root,name),b);files[name]=sha(b);};
  const policy={segmentBodyBytes:8388608,segmentMessages:20000,maxQueuedBytes:8388608,maxQueuedMessages:4000,freeDiskReserveBytes:0,
    metadataUrl:'https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-1800000000',expiresUtcMs:1800000300000};
  const schema='OPERATING_CAPTURE_ATTEMPT_V1',startedAt=time(0),seed=sha(line({schema,policy,startedAt}));let proof=seed;
  const condition='0x'+'a'.repeat(64),token='111',protocolVersion=opts.v1?'v1':'v2';
  const boundMarket={condition,token,protocolVersion},labels=['Up','Down'],ids=[token,'222'];
  const actualIds=opts.wrongGammaToken?['222',token]:ids;
  const gamma={id:'17',conditionId:condition,slug:policy.metadataUrl.split('/').pop(),version:protocolVersion,outcomes:JSON.stringify(labels),
    ...(opts.v1?{clobTokenIds:JSON.stringify(actualIds)}:{positionIds:actualIds})};
  const mIds=opts.wrongTokenPair?['111','333']:ids;
  const market=opts.v1?{condition_id:condition,market_slug:gamma.slug,tokens:mIds.map((t,i)=>({token_id:t,outcome:labels[i]}))}:{...(opts.wrongMarketCondition?{condition_id:'0x'+'b'.repeat(64)}:{}),t:mIds.map((t,i)=>({t,o:labels[i]}))};
  const book={asset_id:opts.wrongBookToken?'222':token,market:condition,...(opts.v1?{}:{version:'v2'})};
  const bodies={metadata:gamma,market,book,fee:{token_id:opts.wrongFeeToken?'222':token,base_fee:2500}};
  const urls={metadata:policy.metadataUrl, market:'https://clob.polymarket.com/'+(opts.wrongVersionRoute?'markets':opts.v1?'markets':'clob-markets')+'/'+condition,
    book:'https://clob.polymarket.com/book?token_id='+token,fee:'https://clob.polymarket.com/fee-rate?token_id='+token};
  const httpProofs=names.map((name,i)=>{
    const b=line(bodies[name]);write('source/http/'+name+'.bin',b);
    const entry={http:name,url:opts.endpoint===name?((name==='book'||name==='fee')?urls[name].replace('111','222'):'https://fixture.invalid/'+name):urls[name],
      at:time(i*2+2),startedAt:time(i*2+1),status:200,sha256:sha(b),bytes:b.length};
    proof=chain(proof,line(entry));return entry;
  });
  const httpHead=proof;
  const reads=httpProofs.map(e=>({name:e.http,url:e.url,at:e.at,startedAt:e.startedAt,httpStatus:200,status:'COMPLETED',bodyBytes:e.bytes,sha256:e.sha256}));
  const rawLines:Buffer[]=[],heads:string[]=[];
  const tail=opts.tail??'LATER_PRIVATE_BALANCE_917';
  const probe=opts.wireProbe;
  const controlText=probe?.control==='text_PONG'?'PONG':tail;
  const kindForProbe=probe?.control==='text_PONG'?'message':probe?.control;
  const messages=probe?[['message','A'],[kindForProbe!,controlText],['message','B'],['protocol_ping','p'],['message',tail]]:
    [['message','{"authored":"first"}'],['protocol_ping','hello'],['message','PONG'],['message','{"authored":"second"}'],['message',tail]];
  if(opts.terminal)messages.pop();
  for(const [i,[kind,body]] of messages.entries()){
    const firstAt=opts.equalFIFO?1010:opts.withheld||opts.lateApplied||opts.earlyUnapplied?1010:1100;
    const rawAt=probe?(probe.subject==='earlier'?[700,1010,1800,1900,2400]:[700,2015,2500,2600,3000])[i]!:
      opts.noWire?[opts.earlyOutsideCut?2000:2400,2410,2420,2500,2600][i]!:[firstAt,1200,1300,opts.futureClock?2016:1800,2200][i]!;
    const at=time(rawAt);
    if(i===1&&probe){
      if(probe.coordinate===undefined||probe.coordinate==='utc')at.utc+=probe.delta;
      if(probe.coordinate===undefined||probe.coordinate==='mono')at.mono+=probe.delta;
    }
    if(i===0&&opts.lateApplied)at[opts.lateApplied]+=1;
    if(i===0&&opts.earlyUnapplied)at[opts.earlyUnapplied]-=1;
    if(i===0&&opts.originSkew)at.utc+=101;
    const b=Buffer.from(body!);let raw=line({number:i+1,kind,bytes:b.length,retainedBytes:b.length,complete:true,sha256:sha(b),rawBase64:b.toString('base64'),at,...(opts.extraFrame&&i===0?{futureField:'not-native'}:{})});
    if(opts.crlf&&i===0)raw=Buffer.concat([raw.subarray(0,-1),Buffer.from('\r\n')]);
    if(opts.duplicateKey&&i===0)raw=Buffer.from(raw.toString().replace('{"number":1','{"number":99,"number":1'));
    proof=chain(proof,raw);heads.push(proof);rawLines.push(raw);
  }
  // Probe heads end a segment so the immediate successor must come from the next authenticated file.
  const segments=probe?[rawLines.slice(0,1),rawLines.slice(1)]:[rawLines];
  let first=1;
  const index=Buffer.concat(segments.map((lines,i)=>{
    const segment=i+1,segname='frames-'+String(segment).padStart(6,'0')+'.ndjson',seg=Buffer.concat(lines);
    write('source/'+segname,seg);
    const bodyBytes=lines.reduce((n,b)=>n+JSON.parse(b.toString()).bytes,0);
    const entry={segment,file:opts.unsafeSegment?'../outside':segname,firstNumber:first,lastNumber:first+lines.length-1,records:lines.length,
      deliveredBodyBytes:bodyBytes,retainedBodyBytes:bodyBytes,journalBytes:seg.length,sha256:sha(seg)};
    first+=lines.length;return line(entry);
  }));
  write('source/segments.ndjson',index);
  const ledger={schema,policy,startedAt,market:{...boundMarket,token:opts.wrongOuterToken?'222':token},subscription:{raw:JSON.stringify({type:'market',assets_ids:[opts.wrongSubscription?'222':token]}),at:time(10)},
    http:{reads,startedAt,policy:{...policy,maxWallMs:300000},market:{...boundMarket,token:opts.wrongBoundToken?'222':token}},httpProofs,proofSeedSha256:seed,proofHeadSha256:opts.badEOF==='finalHead'?'f'.repeat(64):proof,wsMessages:rawLines.length+Number(opts.badEOF==='wireCount'),index:{closed:true,segments:segments.length+Number(opts.badEOF==='segments'),file:'segments.ndjson',bytes:index.length,sha256:sha(index)}};
  write('source/ledger.json',line(ledger));write('epoch-summary.json',line({source:ledger,reconciled:true,cleanupFailure:null,privateTerminalTag:tail}));
  const selectedCount=opts.noWire?0:probe?.subject==='selected'?1:2;
  const selectedAt=time(opts.slotExpired?300000:opts.badNextCadence?2009:2015);if(opts.flatUtc)selectedAt.utc=time(1010).utc;
  if(opts.shortUtc)selectedAt.utc=time(2000).utc;
  const selected={number:2,at:selectedAt,processedFrames:opts.wrongCount?selectedCount+1:selectedCount,proofHeadSha256:opts.noWire?httpHead:probe?.subject==='selected'?heads[0]!:heads[3]!};
  const earlier={number:1,at:time(opts.badFirstCadence?1009:1010),processedFrames:probe||opts.lateApplied||opts.withheld?1:0,
    proofHeadSha256:probe?heads[0]!:opts.priorLaterHead?heads[4]!:opts.lateApplied?heads[0]!:opts.withheld?heads[3]!:httpHead};
  const later={number:opts.duplicateSelected?2:3,at:time(3100),processedFrames:opts.terminal?2:3,proofHeadSha256:heads[heads.length-1]!};
  write('samples.ndjson',Buffer.concat([line(earlier),line(selected),line(later)]));
  if(opts.missingBodyPin)delete files['source/http/book.bin'];
  const weakPin=(p:string,v:unknown)=>{const b=line(v);writeFileSync(p,b);return {path:p,sha256:sha(b)};};
  const inv:VerifiedArchiveInventory={schema:'ENG035_PRIVATE_VERIFIED_ARCHIVE_INVENTORY_V1',logicalEpoch:root,archiveDirectory:root,files};
  const inventory=weakPin(path.join(home,'private-inventory.json'),inv);
  const bodySha256={metadata:files['source/http/metadata.bin']!,market:files['source/http/market.bin']!,book:files['source/http/book.bin']!,fee:files['source/http/fee.bin']!};
  if(opts.wrongIdentityBody)bodySha256.market='1'.repeat(64);
  const identity:ReviewedMarketIdentity={schema:'ENG035_INDEPENDENT_SELECTED_MARKET_IDENTITY_V1',archiveInventorySha256:inventory.sha256,marketId:'17',condition,token,protocolVersion,bodySha256};
  const identityPin=weakPin(path.join(home,'independent-identity.json'),identity);
  const evidence:ReviewedPrefixBoundary={schema:'ENG035_PRIVATE_SELECTED_SOURCE_FRONTIER_V3',identity:identityPin,archiveInventorySha256:inventory.sha256,destination:path.join(home,'result'),
    frontier:{epoch:root,sample:selected,index:1,ordinal:9,appliedFrames:selected.processedFrames,proofHead:selected.proofHeadSha256,at:selected.at,randomState:17,current:true},
    dependencies:{complete:true,usesLaterSource:false,latestRequiredWireNumber:opts.noWire?0:probe?.subject==='selected'?1:4,latestRequiredSampleIndex:1}};
  const boundary=weakPin(path.join(home,'private-boundary.json'),evidence);
  const req={inventory,boundary,destination:path.join(home,'result'),maxOutputBytes:1024*1024};
  return {root,home,req,evidence,weakPin,rawLines,selected,earlier,httpProofs,tail};
}

describe('ENG035 V3 sample head and original endpoint order, authored files only',()=>{
  it('exports exact HTTP and wire bytes through a mid-segment proof head; different valid future tails produce identical inputs',()=>{
    const signatures:string[]=[];
    for(const tail of ['SECRET_FUTURE_A','LONGER_SECRET_FUTURE_B']){
      const f=authored({tail}),out=exportDecisionPrefix(f.req);expect(out.status).toBe('EXPORTED');if(out.status!=='EXPORTED')throw Error(out.reason);
      const get=(n:string)=>readFileSync(path.join(out.inputDirectory,n));
      expect(readdirSync(out.inputDirectory).sort()).toEqual(['frames.ndjson','http','http-proofs.ndjson','prefix.json','samples.ndjson','source-init.json']);
      expect(get('frames.ndjson')).toEqual(Buffer.concat(f.rawLines.slice(0,4)));
      expect(get('samples.ndjson')).toEqual(Buffer.concat([line(f.earlier),line(f.selected)]));
      expect(get('http-proofs.ndjson')).toEqual(Buffer.concat(f.httpProofs.map(line)));
      for(const p of f.httpProofs)expect(get('http/'+p.http+'.bin')).toEqual(readFileSync(path.join(f.root,'source/http',p.http+'.bin')));
      const m=JSON.parse(get('prefix.json').toString());expect(m.through).toEqual({sampleNumber:2,at:f.selected.at,processedFrames:2,wireFrames:4});
      for(const [n,p] of Object.entries(m.files) as [string,{bytes:number;sha256:string}][]){expect(get(n).length).toBe(p.bytes);expect(sha(get(n))).toBe(p.sha256);}
      expect(get('prefix.json').toString()).not.toContain(f.req.inventory.sha256);expect(out.manifestSha256).toBe(sha(get('prefix.json')));signatures.push(out.manifestSha256);
    }
    expect(signatures[0]).toBe(signatures[1]);
  });
  it('distinguishes two samples at the same complete HTTP head by index and processes no wire data',()=>{
    const f=authored({noWire:true}),o=exportDecisionPrefix(f.req);if(o.status!=='EXPORTED')throw Error(o.reason);
    expect(readFileSync(path.join(o.inputDirectory,'frames.ndjson')).length).toBe(0);
    expect(readFileSync(path.join(o.inputDirectory,'samples.ndjson'))).toEqual(Buffer.concat([line(f.earlier),line(f.selected)]));
  });
  it.each([
    ['duplicateSelected','ambiguous_sample_number'],['priorLaterHead','prior_sample_outside_prefix'],['wrongCount','selected_head_or_dependency'],
    ['futureClock','frame_identity_or_time'],['unsafeSegment','segment_identity'],['crlf','unsupported_producer_encoding'],
    ['extraFrame','record_shape'],['duplicateKey','unsupported_producer_encoding'],['missingBodyPin','missing_file_pin'],
  ] as const)('withholds %s without a published packet',(key,reason)=>{
    const f=authored({[key]:true});expect(exportDecisionPrefix(f.req)).toEqual({status:'INCOMPLETE',reason});
    expect(existsSync(path.join(f.req.destination,'input'))).toBe(false);
  });
  it.each(['metadata','market','book','fee'] as const)('rejects a re-bound wrong original %s endpoint even when proof, row and chain agree',endpoint=>{
    const f=authored({endpoint});expect(exportDecisionPrefix(f.req)).toEqual({status:'INCOMPLETE',reason:'original_http_endpoint'});
  });
  it.each([
    ['wrongVersionRoute','original_http_endpoint'],['wrongTokenPair','original_token_pair'],['wrongGammaToken','original_token_pair'],
    ['wrongMarketCondition','original_market_identity'],['wrongOuterToken','producer_market_binding'],['flatUtc','source_clock_or_expiry'],
    ['wrongBookToken','original_book_identity'],['wrongFeeToken','original_fee_identity'],['wrongBoundToken','producer_market_binding'],
    ['wrongSubscription','subscription_binding'],['wrongIdentityBody','selected_body_binding'],['slotExpired','source_clock_or_expiry'],
    ['originSkew','source_clock_or_expiry'],['badFirstCadence','producer_sample_cadence'],['badNextCadence','producer_sample_cadence'],
  ] as const)('rejects independently re-sealed %s',(key,reason)=>{
    const f=authored({[key]:true});expect(exportDecisionPrefix(f.req)).toEqual({status:'INCOMPLETE',reason});expect(existsSync(path.join(f.req.destination,'input'))).toBe(false);
  });
  it.each(['utc','mono'] as const)('rejects both FIFO directions on the %s coordinate',coordinate=>{
    for(const f of [authored({lateApplied:coordinate}),authored({earlyUnapplied:coordinate})]){
      expect(exportDecisionPrefix(f.req)).toEqual({status:'INCOMPLETE',reason:'sample_fifo'});
    }
  });
  it('rejects an already enqueued first data receipt outside the selected HTTP-only head',()=>{
    const f=authored({noWire:true,earlyOutsideCut:true});
    expect(exportDecisionPrefix(f.req)).toEqual({status:'INCOMPLETE',reason:'sample_fifo'});
    expect(existsSync(path.join(f.req.destination,'input'))).toBe(false);
  });
  it.each([{withheld:true},{equalFIFO:true},{v1:true},{shortUtc:true}])('accepts producer-valid withheld, tied, v1 and off-grid inputs: %o',opts=>{
    const f=authored(opts);const o=exportDecisionPrefix(f.req);if(o.status!=='EXPORTED')throw Error(o.reason);
    expect(readFileSync(path.join(o.inputDirectory,'samples.ndjson'))).toEqual(Buffer.concat([line(f.earlier),line(f.selected)]));
  });
  it.each(['protocol_ping','protocol_pong','text_PONG'] as const)('rejects %s omitted by a prior or selected head, on either clock',control=>{
    for(const subject of ['earlier','selected'] as const)for(const coordinate of ['utc','mono'] as const){
      const f=authored({wireProbe:{subject,control,delta:-1,coordinate}}),o=exportDecisionPrefix(f.req);
      expect(o).toEqual({status:'INCOMPLETE',reason:'sample_head_omits_wire'});
      expect(existsSync(path.join(f.req.destination,'input'))).toBe(false);
    }
  });
  it.each(['earlier','selected'] as const)('authenticates tied and later control wires after the %s sample head across a segment boundary',subject=>{
    for(const control of ['protocol_ping','protocol_pong','text_PONG'] as const)for(const delta of [0,1]){
      const f=authored({wireProbe:{subject,control,delta}}),o=exportDecisionPrefix(f.req);if(o.status!=='EXPORTED')throw Error(o.reason);
      const sample=o.privateWireProof.samples[subject==='earlier'?0:1]!,n=sample.successor;
      if(n.kind!=='WIRE')throw Error('missing successor');
      expect(n.wireNumber).toBe(2);expect(sample.afterWireNumber).toBe(1);expect(n.segment).toBe('frames-000002.ndjson');
      expect(n.lineOffset).toBe(0);expect(n.lineBytes).toBe(f.rawLines[1]!.length);expect(n.lineSha256).toBe(sha(f.rawLines[1]!));
      expect(n.resultingHead).toBe(chain(sample.head,f.rawLines[1]!));expect(n.at).toEqual(time((subject==='earlier'?1010:2015)+delta));
      const key=subject==='earlier'?f.earlier:f.selected;expect(sample.head).toBe(key.proofHeadSha256);
      expect(o.privateWireProof.inventorySha256).toBe(f.req.inventory.sha256);
      expect(n.segmentSha256).toBe(sha(Buffer.concat(f.rawLines.slice(1))));
      const idx=readFileSync(path.join(f.root,'source/segments.ndjson'));expect(o.privateWireProof.indexSha256).toBe(sha(idx));
      expect(n.indexEntrySha256).toBe(sha(Buffer.from(idx.toString().trimEnd().split('\n')[1]!+'\n')));
      expect(o.privateWireProof.ledgerSha256).toBe(sha(readFileSync(path.join(f.root,'source/ledger.json'))));
    }
  });
  it('keeps different true private control successors and their hashes out of an identical consumer input',()=>{
    const manifestHashes:string[]=[],privateHashes:string[]=[];
    for(const tail of ['PRIVATE_NEXT_CONTROL_A','PRIVATE_NEXT_CONTROL_WITH_A_LONGER_BODY_B']){
      const f=authored({wireProbe:{subject:'selected',control:'protocol_ping',delta:1},tail}),o=exportDecisionPrefix(f.req);
      if(o.status!=='EXPORTED')throw Error(o.reason);const n=o.privateWireProof.samples[1]!.successor;
      if(n.kind!=='WIRE')throw Error('missing successor');
      manifestHashes.push(o.manifestSha256);privateHashes.push(n.lineSha256);
      expect(readFileSync(path.join(o.inputDirectory,'frames.ndjson'))).toEqual(f.rawLines[0]);
      const m=readFileSync(path.join(o.inputDirectory,'prefix.json'),'utf8');expect(m).not.toContain(n.lineSha256);expect(m).not.toContain(tail);
    }
    expect(manifestHashes[0]).toBe(manifestHashes[1]);expect(privateHashes[0]).not.toBe(privateHashes[1]);
  });
  it('attests an actual final head by exact scanned closed-index count and terminal chain',()=>{
    const f=authored({terminal:true}),o=exportDecisionPrefix(f.req);if(o.status!=='EXPORTED')throw Error(o.reason);
    expect(o.privateWireProof.samples[1]!.successor).toEqual({kind:'EOF',wireCount:4,segmentCount:1,finalHead:f.selected.proofHeadSha256});
    expect(readFileSync(path.join(o.inputDirectory,'prefix.json'),'utf8')).not.toContain('EOF');
  });
  it.each(['wireCount','segments','finalHead'] as const)('rejects a contradictory private EOF %s',badEOF=>{
    const f=authored({terminal:true,badEOF});expect(exportDecisionPrefix(f.req)).toEqual({status:'INCOMPLETE',reason:'wire_eof_binding'});
  });
  it.each(['laterWire','futureDependency','withheld','clockMismatch','indexMismatch','unboundInventory'] as const)('rejects a mismatched frontier or dependency: %s',kind=>{
    const f=authored(),b=structuredClone(f.evidence);
    if(kind==='laterWire')b.dependencies.latestRequiredWireNumber=5;
    if(kind==='futureDependency')b.dependencies.usesLaterSource=true;
    if(kind==='withheld')b.frontier.current=false;
    if(kind==='clockMismatch')b.frontier.at={...b.frontier.at,mono:1};
    if(kind==='indexMismatch')b.frontier.index++;
    if(kind==='unboundInventory')b.archiveInventorySha256='0'.repeat(64);
    f.req.boundary=f.weakPin(f.req.boundary.path,b);expect(exportDecisionPrefix(f.req).status).toBe('INCOMPLETE');
    expect(existsSync(path.join(f.req.destination,'input'))).toBe(false);
  });
  it.each(['tamper','missing','symlink','hardlink','occupied','budget','outputInsideSource'] as const)('refuses %s and preserves original inputs',kind=>{
    const f=authored(),book=path.join(f.root,'source/http/book.bin');
    if(kind==='tamper')writeFileSync(book,'x');
    if(kind==='missing')rmSync(book);
    if(kind==='symlink'){const moved=path.join(f.home,'moved.bin');renameSync(book,moved);symlinkSync(moved,book);}
    if(kind==='hardlink')linkSync(book,path.join(f.home,'link.bin'));
    if(kind==='occupied'){mkdirSync(f.req.destination);writeFileSync(path.join(f.req.destination,'prior'),'kept');}
    if(kind==='budget')f.req.maxOutputBytes=1;
    if(kind==='outputInsideSource')f.req.destination=path.join(f.root,'illegal-output');
    expect(exportDecisionPrefix(f.req).status).toBe('INCOMPLETE');expect(existsSync(path.join(f.req.destination,'input'))).toBe(false);
    if(kind==='occupied')expect(readFileSync(path.join(f.req.destination,'prior'),'utf8')).toBe('kept');
  });
});
