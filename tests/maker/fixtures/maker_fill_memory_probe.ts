/** Authored engineering probes only: no original accounts or market requests. */
import {readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createPaperDatabase,FILL_POLICY,hashFileSync} from '../../../scripts/research/maker_fill_paper';
import {PaperMakerExecution} from '../../../apps/worker/src/shadow/PaperMakerExecution';
const mode=process.argv[2];
if(mode==='replay-file'){const module=await import(pathToFileURL(process.argv[3]!).href),db=module.createPaperDatabase(process.argv[5]!);try{const config=JSON.parse(readFileSync('configs/worker.json','utf8')),logger=Object.fromEntries(['info','warn','error','debug','trace','fatal'].map(k=>[k,()=>{}])),out=await module.replayPaperEpoch(process.argv[4]!,db,config,logger);const {resources,...economic}=out;writeFileSync(process.argv[6]!,JSON.stringify(economic));console.log(JSON.stringify({schema:'AUTHORED_PAIRED_REPLAY_RESULT_V1',output:process.argv[6],resources}));}finally{db.close()}}else if(mode==='hash-old'||mode==='hash-new'){
 const dir=process.argv[3]!,passes=Number(process.argv[4]??12),files=readdirSync(dir).sort().map(n=>path.join(dir,n));let sum='',maxRSSBytes=process.memoryUsage().rss;
 const start=performance.now(),cpu=process.cpuUsage();
 for(let pass=0;pass<passes;pass++)for(const file of files){let digest:string;if(mode==='hash-old'){const raw=readFileSync(file);maxRSSBytes=Math.max(maxRSSBytes,process.memoryUsage().rss);digest=createHash('sha256').update(raw).digest('hex');}else{digest=hashFileSync(file);maxRSSBytes=Math.max(maxRSSBytes,process.memoryUsage().rss)}sum=createHash('sha256').update(sum+digest).digest('hex');}
 console.log(JSON.stringify({mode,passes,files:files.length,bytesFullyRead:files.reduce((n,p)=>n+statSync(p).size,0)*passes,fullFileBufferBytesAllocated:mode==='hash-old'?files.reduce((n,p)=>n+statSync(p).size,0)*passes:0,scratchBufferBytes:mode==='hash-new'?65536:0,maxRSSBytes,maxRSSReported:process.resourceUsage().maxRSS,memory:process.memoryUsage(),wallMs:performance.now()-start,cpu:process.cpuUsage(cpu),digest:sum}));
}else if(mode==='clock-before'||mode==='clock-after'){
 if(typeof global.gc!=='function')throw Error('authored probe requires --expose-gc');const db=createPaperDatabase(':memory:');const at={utc:1800000000000,mono:0};
 function register(){const context={history:Buffer.alloc(12*1024*1024,7)};const execution=new PaperMakerExecution(db,FILL_POLICY,()=>{if(context.history[0]!==7)throw Error('authored context');return at});return {execution:new WeakRef(execution),context:new WeakRef(context)}}
 const refs=register();for(let i=0;i<8;i++){await new Promise(resolve=>setImmediate(resolve));global.gc()}
 const aliveBefore=!!refs.context.deref();if(mode==='clock-after')refs.execution.deref()!.releaseSourceContext();
 for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc()}
 const aliveAfter=!!refs.context.deref();let releasedGuard=false;try{db.prepare('SELECT paper_execution_now_mono()').get()}catch(error){releasedGuard=String(error).includes('source_context_released')}
 const fundsBefore=db.prepare('SELECT cash FROM paper_execution_account').get();const restored=new PaperMakerExecution(db,FILL_POLICY,()=>at);restored.observeBook({sourceId:'authored',market:'1',token:'111',tick:'0.01',lot:'0.01',minimumShares:'1',bids:[{price:'0.49',size:'1'}],asks:[{price:'0.61',size:'1'}],at,venueUtc:at.utc});db.prepare("INSERT INTO shadow_orders(ts,wallet_id,token_id,market_id,side,kind,price,size,expected_cancel_ts,execution_mode,status,filled_size,last_update_ts) VALUES(?,1,'111','1','BUY','MAKER_BID',.5,1,?,'SHADOW','OPEN',0,?)").run(at.utc,at.utc+5000,at.utc);
 console.log(JSON.stringify({mode,aliveBefore,aliveAfter,releasedGuard,fundsBefore,cashAfter:restored.snapshot().cashUSDC,orders:restored.snapshot().orders.length,openingEvents:(db.prepare("SELECT COUNT(*) n FROM accounting_events WHERE kind='OPENING'").get() as any).n}));db.close();
}else throw Error('unknown authored probe mode');
