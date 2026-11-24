/** Conventional, explicitly modeled maker execution; never authenticated venue fills. */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { postAccountingEvent, getAccountingReport } from '@polysignal/storage';
export type PaperClock = { utc:number; mono:number };
export type PaperLevel = { price:string; size:string };
export type PaperBook = { sourceId:string; token:string; market:string; bids:PaperLevel[]; asks:PaperLevel[];
  tick:string; lot:string; minimumShares:string; minimumNotionalUSDC?:string; at:PaperClock; venueUtc:number };
export type PaperTrade = { sourceId:string; token:string; side:'BUY'|'SELL'; price:string; size:string; at:PaperClock; venueUtc:number };
export type PaperMakerPolicy = { accountKey:string; walletId:number; openingCash:string; perOrder:string;
  maxExposure:string; maxInventoryShares:string; submitLatencyMs:number; cancelLatencyMs:0;
  feeModel:'paper-maker-zero-fee-v1' };
const S=1_000_000_000n, C=S*S;
function need(ok:unknown,why:string):asserts ok {if(!ok)throw Error('paper_execution:'+why);}
function units(v:unknown):bigint {need(typeof v==='string'||typeof v==='number','decimal_type');let s=String(v);if(typeof v==='number'&&/[eE]/.test(s)){need(Number.isFinite(v)&&v>=0,'decimal');s=v.toFixed(9);need(Number(s)===v,'decimal_precision');}
  need(/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(s),'decimal');const[a,b='']=s.split('.');return BigInt(a!)*S+BigInt(b.padEnd(9,'0'));}
function text(v:bigint,scale=S):string {const sign=v<0n?'-':'';v=v<0n?-v:v;const d=scale===S?9:18;
 return sign+(v/scale).toString()+'.'+(v%scale).toString().padStart(d,'0');}
const digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const min=(a:bigint,b:bigint)=>a<b?a:b;
type Row=Record<string,any>;
export class PaperMakerExecution {
 private books=new Map<string,PaperBook>(); private internal=false; private readonly policy:PaperMakerPolicy;
 constructor(private db:Database.Database, policy:PaperMakerPolicy, private clock:()=>PaperClock){
  this.policy=structuredClone(policy);need(Number.isSafeInteger(policy.walletId)&&policy.walletId>0&&policy.accountKey===`wallet:${policy.walletId}`,'policy_identity');
  need(policy.openingCash==='100'&&policy.perOrder==='20'&&policy.maxExposure==='40'&&policy.maxInventoryShares==='200','policy_limits');
  need(policy.submitLatencyMs===100&&policy.cancelLatencyMs===0&&policy.feeModel==='paper-maker-zero-fee-v1','model_policy');
  const at=this.clock();this.validClock(at);
  db.exec(`CREATE TABLE IF NOT EXISTS paper_execution_account(id INTEGER PRIMARY KEY CHECK(id=1),policy TEXT NOT NULL,cash TEXT NOT NULL,last_utc INTEGER NOT NULL,last_mono REAL NOT NULL);
   CREATE TABLE IF NOT EXISTS paper_execution_positions(token TEXT PRIMARY KEY,shares TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS paper_execution_queues(cohort TEXT PRIMARY KEY,token TEXT,side TEXT,price TEXT,ahead TEXT NOT NULL,source_id TEXT NOT NULL,activate_utc INTEGER NOT NULL,activate_mono REAL NOT NULL,checked INTEGER NOT NULL,rejected INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS paper_execution_orders(order_id INTEGER PRIMARY KEY,token TEXT NOT NULL,side TEXT NOT NULL,price TEXT NOT NULL,remaining TEXT NOT NULL,activate_utc INTEGER NOT NULL,activate_mono REAL NOT NULL,status TEXT NOT NULL,cohort TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS paper_execution_trades(source_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,volume TEXT NOT NULL,ahead_consumed TEXT NOT NULL,allocated TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS paper_execution_terms(token TEXT PRIMARY KEY,market TEXT NOT NULL,tick TEXT NOT NULL,lot TEXT NOT NULL,minimum TEXT NOT NULL,notional TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS paper_execution_watermarks(token TEXT PRIMARY KEY,venue_utc INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS paper_execution_allocations(source_id TEXT,order_id INTEGER,quantity TEXT NOT NULL,PRIMARY KEY(source_id,order_id));`);
  const old=this.account();
  if(old)need(old.policy===JSON.stringify(this.policy),'policy_drift');
  else db.transaction(()=>{
   need((db.prepare('SELECT COUNT(*) n FROM accounting_events').get() as Row).n===0 && (db.prepare('SELECT COUNT(*) n FROM paper_execution_orders').get() as Row).n===0 && (db.prepare('SELECT COUNT(*) n FROM paper_execution_positions').get() as Row).n===0,'nonempty_ledger_genesis');
   need((db.prepare('SELECT COUNT(*) n FROM shadow_orders').get() as Row).n===0 && (db.prepare('SELECT COUNT(*) n FROM shadow_fills').get() as Row).n===0,'nonempty_opening');
   db.prepare('INSERT INTO paper_execution_account VALUES(1,?,?,?,?)').run(JSON.stringify(this.policy),(units(policy.openingCash)*S).toString(),at.utc,at.mono);
   postAccountingEvent(db,{eventKey:'paper-opening:'+policy.accountKey,accountKey:policy.accountKey,kind:'OPENING',source:'paper-maker-model',sourceRef:'opening',eventTs:at.utc,receiptTs:at.utc,processingOrder:0,finality:'SIMULATED',cashDelta:100,feeEvidence:'NOT_APPLICABLE',ruleVersion:'paper-opening-v1',roundingPolicy:'exact-scale18-cash-scale9-shares',collateralAsset:'USDC'});
  })();
  db.function('paper_execution_insert',(raw:string,view:string)=>{this.validateOrder(JSON.parse(raw),this.clock(),JSON.parse(view));return 1;});
  db.function('paper_execution_register',(raw:string,prior:string)=>{const o=JSON.parse(raw);return (JSON.parse(prior) as string[]).reduce((n,v)=>BigInt(v)>n?BigInt(v):n,this.initialAhead(o)).toString();});
  db.function('paper_execution_internal',()=>this.internal?1:0);
  db.function('paper_execution_update',(a:string,b:string)=>{if(!this.internal)this.validateCancel(JSON.parse(a),JSON.parse(b));return 1;});
  db.function('paper_execution_now_mono',()=>this.clock().mono);
  db.function('paper_execution_book_source',(token:string)=>this.books.get(token)!.sourceId);
  db.function('paper_execution_decimal',(v:number)=>text(units(v)));
  db.function('paper_execution_cohort',(token:string,side:string,price:number,ts:number)=>digest([token,side,text(units(price)),ts,this.books.get(token)!.sourceId]));
  const cols=(db.prepare('PRAGMA table_info(shadow_orders)').all() as Row[]).map(c=>String(c.name));
  need(cols.every(c=>/^[a-z_]+$/.test(c)),'schema_columns');
  const obj=(prefix:string)=>'json_object('+cols.flatMap(k=>["'"+k+"'",prefix+'.'+k]).join(',')+')';
  db.exec(`CREATE TRIGGER IF NOT EXISTS paper_execution_order_guard BEFORE INSERT ON shadow_orders BEGIN SELECT paper_execution_insert(${obj('NEW')},json_object('cash',(SELECT cash FROM paper_execution_account WHERE id=1),'active',json((SELECT json_group_array(json_object('remaining',remaining,'price',price,'side',side,'token',token)) FROM paper_execution_orders WHERE status='ACTIVE')),'positions',json((SELECT json_group_array(json_object('token',token,'shares',shares)) FROM paper_execution_positions)))); END;
   CREATE TRIGGER IF NOT EXISTS paper_execution_register_order AFTER INSERT ON shadow_orders BEGIN
    INSERT OR IGNORE INTO paper_execution_queues VALUES(paper_execution_cohort(NEW.token_id,NEW.side,NEW.price,NEW.ts),NEW.token_id,NEW.side,paper_execution_decimal(NEW.price),paper_execution_register(${obj('NEW')},(SELECT json_group_array(ahead) FROM paper_execution_queues q WHERE q.token=NEW.token_id AND q.side=NEW.side AND q.price=paper_execution_decimal(NEW.price) AND EXISTS(SELECT 1 FROM paper_execution_orders o WHERE o.cohort=q.cohort AND o.status='ACTIVE'))),paper_execution_book_source(NEW.token_id),NEW.ts+${policy.submitLatencyMs},paper_execution_now_mono()+${policy.submitLatencyMs},0,0);
    INSERT INTO paper_execution_orders VALUES(NEW.id,NEW.token_id,NEW.side,paper_execution_decimal(NEW.price),paper_execution_decimal(NEW.size),NEW.ts+${policy.submitLatencyMs},paper_execution_now_mono()+${policy.submitLatencyMs},'ACTIVE',paper_execution_cohort(NEW.token_id,NEW.side,NEW.price,NEW.ts)); END;
   CREATE TRIGGER IF NOT EXISTS paper_execution_update_guard BEFORE UPDATE ON shadow_orders BEGIN SELECT paper_execution_update(${obj('OLD')},${obj('NEW')}); END;
   CREATE TRIGGER IF NOT EXISTS paper_execution_cancel AFTER UPDATE ON shadow_orders WHEN NEW.status='CANCELLED' BEGIN UPDATE paper_execution_orders SET status='CANCELLED',remaining='0' WHERE order_id=NEW.id; END;
   CREATE TRIGGER IF NOT EXISTS paper_execution_order_delete BEFORE DELETE ON shadow_orders BEGIN SELECT RAISE(ABORT,'paper_execution:no_order_delete'); END;
   CREATE TRIGGER IF NOT EXISTS paper_execution_fill_guard BEFORE INSERT ON shadow_fills WHEN paper_execution_internal()!=1 BEGIN SELECT RAISE(ABORT,'paper_execution:unauthorized_fill'); END;
   CREATE TRIGGER IF NOT EXISTS paper_execution_fill_update BEFORE UPDATE ON shadow_fills BEGIN SELECT RAISE(ABORT,'paper_execution:immutable_fill'); END;
   CREATE TRIGGER IF NOT EXISTS paper_execution_fill_delete BEFORE DELETE ON shadow_fills BEGIN SELECT RAISE(ABORT,'paper_execution:immutable_fill'); END;`);
  this.corroborate();
 }
 private corroborate(){
  const fills=this.db.prepare('SELECT f.*,o.side,o.token_id FROM shadow_fills f JOIN shadow_orders o ON o.id=f.order_id ORDER BY f.id').all() as Row[];
  let cash=units(this.policy.openingCash)*S;const positions:Record<string,bigint>={};
  for(const f of fills){need(f.method==='paper_fifo_model','foreign_fill');const q=units(f.size),p=units(f.price);cash+=(f.side==='BUY'?-1n:1n)*q*p;positions[f.token_id]=(positions[f.token_id]??0n)+(f.side==='BUY'?q:-q);}
  need(cash===BigInt(this.account()!.cash),'cash_ledger_mismatch');
  const actual=this.db.prepare('SELECT * FROM paper_execution_positions').all() as Row[];need(actual.every(r=>BigInt(r.shares)===(positions[r.token]??0n))&&Object.keys(positions).every(t=>actual.some(r=>r.token===t)),'position_ledger_mismatch');
  const report=getAccountingReport(this.db,this.policy.accountKey,Number.MAX_SAFE_INTEGER);
  need(report.events.length===fills.length+1&&report.events.every(e=>e.accountKey===this.policy.accountKey&&e.finality==='SIMULATED'&&(e.eventKey==='paper-opening:'+this.policy.accountKey||fills.some(f=>e.eventKey==='shadow-fill:'+f.id)))&&Math.abs(report.cash-Number(text(cash,C)))<1e-8,'canonical_ledger_mismatch');
 }
 private activationSafe(book:PaperBook,queue:Row){return book.at.utc<=queue.activate_utc&&queue.activate_utc-book.at.utc<=1000&&book.at.mono<=queue.activate_mono&&queue.activate_mono-book.at.mono<=1000&&queue.activate_utc-book.venueUtc<=1000;}
 private rejectCohort(cohort:string,at:PaperClock){const before=this.internal;this.internal=true;try{
  this.db.prepare("UPDATE shadow_orders SET status='REJECTED',last_update_ts=? WHERE id IN(SELECT order_id FROM paper_execution_orders WHERE cohort=? AND status='ACTIVE')").run(at.utc,cohort);
  this.db.prepare("UPDATE paper_execution_orders SET status='REJECTED',remaining='0' WHERE cohort=? AND status='ACTIVE'").run(cohort);
 }finally{this.internal=before;}}
 private account():Row|undefined {return this.db.prepare('SELECT * FROM paper_execution_account WHERE id=1').get() as Row|undefined;}
 private validClock(at:PaperClock){need(Number.isSafeInteger(at.utc)&&at.utc>=0&&Number.isFinite(at.mono)&&at.mono>=0,'clock');}
 private position(token:string):bigint {const r=this.db.prepare('SELECT shares FROM paper_execution_positions WHERE token=?').get(token) as Row|undefined;return BigInt(r?.shares??'0');}
 private active():Row[]{return this.db.prepare("SELECT q.*,o.size,o.filled_size,o.ts,o.expected_cancel_ts FROM paper_execution_orders q JOIN shadow_orders o ON o.id=q.order_id WHERE q.status='ACTIVE' ORDER BY o.ts,o.id").all() as Row[];}
 private book(token:string,at:PaperClock):PaperBook {const b=this.books.get(token);need(b,'book_unavailable');need(at.utc>=b.at.utc&&at.utc-b.at.utc<=1000&&at.mono>=b.at.mono&&at.mono-b.at.mono<=1000&&at.utc-b.venueUtc<=1000,'stale_book');return b;}
 observeBook(input:PaperBook){const b=structuredClone(input);this.validClock(b.at);const now=this.clock();need(b.at.utc<=now.utc&&b.at.mono<=now.mono,'book_receipt_clock');need(b.sourceId&&b.token&&b.market&&Number.isSafeInteger(b.venueUtc)&&b.venueUtc<=b.at.utc&&b.at.utc-b.venueUtc<=1000,'book_identity_clock');
  const old=this.books.get(b.token);if(old){need(b.market===old.market,'book_market_change');need(b.at.utc>=old.at.utc&&b.at.mono>=old.at.mono&&b.venueUtc>=old.venueUtc,'backdated_book');
   if(this.active().some(r=>r.token===b.token))need(units(b.tick)===units(old.tick)&&units(b.lot)===units(old.lot)&&units(b.minimumShares)===units(old.minimumShares)&&units(b.minimumNotionalUSDC??'0')===units(old.minimumNotionalUSDC??'0'),'active_terms_change');}
  const tick=units(b.tick);need(tick>0n&&units(b.lot)>0n&&units(b.minimumShares)>0n,'book_terms');units(b.minimumNotionalUSDC??'0');
  for(const side of [b.bids,b.asks]){need(Array.isArray(side)&&side.length>0,'book_side');const seen=new Set<string>();for(const l of side){const p=units(l.price),q=units(l.size);need(p>0n&&p<S&&p%tick===0n&&q>0n&&!seen.has(p.toString()),'book_level');seen.add(p.toString());}}
  need(b.bids.reduce((a,l)=>units(l.price)>a?units(l.price):a,0n)<b.asks.reduce((a,l)=>units(l.price)<a?units(l.price):a,S),'crossed_book');const persisted=this.db.prepare('SELECT * FROM paper_execution_terms WHERE token=?').get(b.token) as Row|undefined;
  if(persisted){need(b.market===persisted.market,'book_market_change');if(this.active().some(r=>r.token===b.token))need(units(b.tick)===units(persisted.tick)&&units(b.lot)===units(persisted.lot)&&units(b.minimumShares)===units(persisted.minimum)&&units(b.minimumNotionalUSDC??'0')===units(persisted.notional),'active_terms_change');}
  this.db.transaction(()=>{
   for(const queue of this.db.prepare('SELECT * FROM paper_execution_queues WHERE token=? AND checked=0').all(b.token) as Row[]){
    const price=units(queue.price);
    const crossed=(book:PaperBook)=>queue.side==='BUY'?price>=book.asks.reduce((n,l)=>min(n,units(l.price)),S):price<=book.bids.reduce((n,l)=>units(l.price)>n?units(l.price):n,0n);
    // At an exact activation tie the source update is ordered first. Otherwise
    // use the last known book BEFORE activation, never a later uncrossing.
    const crossedBoundary=b.at.utc>=queue.activate_utc;
    const activationBook=b.at.utc===queue.activate_utc?b:old;
    const reference=crossedBoundary?activationBook:b;
    const levels=reference?(queue.side==='BUY'?reference.bids:reference.asks):[];
    const visible=levels.filter(l=>units(l.price)===price).reduce((n,l)=>n+units(l.size),0n);
    const failed=crossedBoundary&&(!activationBook||!this.activationSafe(activationBook,queue)||crossed(activationBook));
    this.db.prepare('UPDATE paper_execution_queues SET ahead=?,checked=?,rejected=? WHERE cohort=?').run((visible>BigInt(queue.ahead)?visible:BigInt(queue.ahead)).toString(),crossedBoundary?1:0,failed?1:queue.rejected,queue.cohort);
    if(failed||queue.rejected)this.rejectCohort(queue.cohort,b.at);

   }
   this.db.prepare('INSERT INTO paper_execution_terms VALUES(?,?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET tick=excluded.tick,lot=excluded.lot,minimum=excluded.minimum,notional=excluded.notional').run(b.token,b.market,b.tick,b.lot,b.minimumShares,b.minimumNotionalUSDC??'0');
  })();this.books.set(b.token,b);
 }
 validateOrder(o:Row,at:PaperClock,view?:{cash:string;active:Row[];positions:Row[]}){this.validClock(at);const b=this.book(o.token_id,at),p=units(o.price),q=units(o.size);
  need(o.wallet_id===this.policy.walletId&&o.market_id===b.market&&o.execution_mode==='SHADOW'&&o.external_order_id==null&&o.status==='OPEN'&&(o.filled_size??0)===0&&o.filled_price==null,'order_identity');
  need((o.side==='BUY'&&o.kind==='MAKER_BID')||(o.side==='SELL'&&o.kind==='MAKER_ASK'),'order_side');
  need(Number.isSafeInteger(o.ts)&&o.ts===at.utc&&Number.isSafeInteger(o.expected_cancel_ts)&&o.expected_cancel_ts>o.ts&&o.expected_cancel_ts-o.ts<=5000,'order_clock');
  need(p>0n&&p<S&&p%units(b.tick)===0n&&q%units(b.lot)===0n&&q>=units(b.minimumShares)&&p*q>=units(b.minimumNotionalUSDC??'0')*S,'order_grid_minimum');
  need(o.side==='BUY'?p<b.asks.reduce((a,l)=>min(a,units(l.price)),S):p>b.bids.reduce((a,l)=>units(l.price)>a?units(l.price):a,0n),'post_only');
  need(p*q<=units(this.policy.perOrder)*S,'per_order');const rows=view?.active??this.active();let reserved=0n,buys=0n,sells=0n;
  for(const r of rows){const remain=units(r.remaining);if(r.side==='BUY'){reserved+=units(r.price)*remain;buys+=remain;}else if(r.token===o.token_id)sells+=remain;}
  const positions=view?.positions??(this.db.prepare('SELECT token,shares FROM paper_execution_positions').all() as Row[]);
  const cash=BigInt(view?.cash??this.account()!.cash),totalHeld=positions.reduce((n,r)=>n+BigInt(r.shares),0n);
  if(o.side==='BUY'){reserved+=p*q;buys+=q;}else sells+=q;
  need(reserved<=cash,'cash');need(reserved<=units(this.policy.maxExposure)*S,'aggregate_cap');need(units(this.policy.openingCash)*S-cash+reserved<=units(this.policy.maxExposure)*S,'exposure');
  need(totalHeld+buys<=units(this.policy.maxInventoryShares),'inventory_cap');need(sells<=BigInt(positions.find(r=>r.token===o.token_id)?.shares??'0'),'sell_inventory');
 }
 private initialAhead(o:Row):bigint {const b=this.book(o.token_id,this.clock()),levels=o.side==='BUY'?b.bids:b.asks;const p=units(o.price);return levels.filter(l=>units(l.price)===p).reduce((n,l)=>n+units(l.size),0n);}
 registerOrder(id:number,_at:PaperClock){need(this.db.prepare('SELECT 1 FROM paper_execution_orders WHERE order_id=?').get(id),'unregistered_order');}
 private validateCancel(a:Row,b:Row){need(['OPEN','PARTIAL'].includes(a.status)&&b.status==='CANCELLED','terminal_transition');for(const k of Object.keys(a))if(!['status','last_update_ts'].includes(k))need(a[k]===b[k],'immutable_order');need(Number.isSafeInteger(b.last_update_ts)&&b.last_update_ts>=a.last_update_ts&&b.last_update_ts===this.clock().utc,'cancel_clock');}
 cancel(id:number,at:PaperClock){this.validClock(at);need(at.utc===this.clock().utc,'cancel_clock');this.db.prepare("UPDATE shadow_orders SET status='CANCELLED',last_update_ts=? WHERE id=? AND status IN ('OPEN','PARTIAL')").run(at.utc,id);}
 reconcileOrders(_at:PaperClock){for(const r of this.active()){const o=this.db.prepare('SELECT * FROM shadow_orders WHERE id=?').get(r.order_id) as Row;need(o&&['OPEN','PARTIAL'].includes(o.status)&&units(r.remaining)===units(o.size)-units(o.filled_size??0),'order_reconciliation');}}
 processTrade(t:PaperTrade){
  need(t.sourceId&&t.token&&(t.side==='BUY'||t.side==='SELL'),'trade_identity');const p=units(t.price),volume=units(t.size);
  need(p>0n&&p<S&&volume>0n,'trade_value');const fingerprint=digest({token:t.token,side:t.side,price:text(p),size:text(volume),venueUtc:t.venueUtc});
  const existing=this.db.prepare('SELECT * FROM paper_execution_trades WHERE source_id=?').get(t.sourceId) as Row|undefined;
  if(existing){need(existing.fingerprint===fingerprint,'trade_identity_conflict');return {duplicate:true,allocatedShares:text(BigInt(existing.allocated)),aheadConsumedShares:text(BigInt(existing.ahead_consumed))};}
  this.validClock(t.at);const now=this.clock();need(t.at.utc===now.utc&&t.at.mono===now.mono,'trade_receipt_clock');const b=this.book(t.token,t.at),a=this.account()!;
  need(Number.isSafeInteger(t.venueUtc)&&t.venueUtc<=t.at.utc&&t.at.utc-t.venueUtc<=1000&&t.venueUtc>=b.venueUtc,'trade_clock');
  const watermark=this.db.prepare('SELECT venue_utc FROM paper_execution_watermarks WHERE token=?').get(t.token) as Row|undefined;need(!watermark||t.venueUtc>=watermark.venue_utc,'backdated_trade');
  need(t.at.utc>=a.last_utc&&t.at.mono>=a.last_mono&&p%units(b.tick)===0n,'trade_order');
  return this.db.transaction(()=>{
   this.reconcileOrders(t.at);let left=volume,aheadConsumed=0n,allocated=0n;
   // A previously cancelled/expired order never becomes fillable through a late venue timestamp.
   for(const r of this.active())if(r.expected_cancel_ts<=t.at.utc)this.cancel(r.order_id,t.at);
   const side=t.side==='SELL'?'BUY':'SELL';const eligible=this.active().filter(r=>r.token===t.token&&r.side===side&&units(r.price)===p&&r.activate_utc<=t.venueUtc&&r.activate_mono<=t.at.mono);
   if(eligible.length){
    for(const r of eligible){if(left===0n)break;
     const queue=this.db.prepare('SELECT * FROM paper_execution_queues WHERE cohort=?').get(r.cohort) as Row;need(queue,'queue_missing');
     if(!queue.checked){const crossed=!this.activationSafe(b,queue)||(side==='BUY'?p>=b.asks.reduce((n,l)=>min(n,units(l.price)),S):p<=b.bids.reduce((n,l)=>units(l.price)>n?units(l.price):n,0n));
      this.db.prepare('UPDATE paper_execution_queues SET checked=1,rejected=? WHERE cohort=?').run(queue.rejected||crossed?1:0,r.cohort);queue.rejected=queue.rejected||crossed;}
     if(queue.rejected){this.rejectCohort(r.cohort,t.at);continue;}
     const consumed=min(BigInt(queue.ahead),left);left-=consumed;aheadConsumed+=consumed;
     this.db.prepare('UPDATE paper_execution_queues SET ahead=? WHERE cohort=?').run((BigInt(queue.ahead)-consumed).toString(),r.cohort);
     const q=min(units(r.remaining),left);if(q===0n)continue;
     const cash=BigInt(this.account()!.cash),shares=this.position(t.token),gross=p*q;
     need(side==='BUY'?cash>=gross:shares>=q,'fill_funding');
     this.db.prepare('UPDATE paper_execution_account SET cash=? WHERE id=1').run((cash+(side==='BUY'?-gross:gross)).toString());
     this.db.prepare('INSERT INTO paper_execution_positions VALUES(?,?) ON CONFLICT(token) DO UPDATE SET shares=excluded.shares').run(t.token,(shares+(side==='BUY'?q:-q)).toString());
     const priorFills=this.db.prepare('SELECT price,size FROM shadow_fills WHERE order_id=? ORDER BY id').all(r.order_id) as Row[];
     const priorQ=priorFills.reduce((n,f)=>n+units(f.size),0n),priorNotional=priorFills.reduce((n,f)=>n+units(f.size)*units(f.price),0n);
     const remaining=units(r.remaining)-q,nextFilled=priorQ+q;
     this.internal=true;
     try {
      const fill=this.db.prepare('INSERT INTO shadow_fills(ts,order_id,price,size,method,note,trade_id) VALUES(?,?,?,?,?,?,?)').run(t.at.utc,r.order_id,Number(text(p)),Number(text(q)),'paper_fifo_model',JSON.stringify({sourceId:t.sourceId,venueUtc:t.venueUtc,receipt:t.at,model:'risk-adverse-same-price-cohort-fifo-v1',cohort:r.cohort,queueSourceId:queue.source_id,activationUtc:r.activate_utc,actualExecution:false}),t.sourceId);
      const id=Number(fill.lastInsertRowid);
      postAccountingEvent(this.db,{eventKey:'shadow-fill:'+id,accountKey:this.policy.accountKey,kind:'FILL',source:'paper-fifo-model',sourceRef:String(id),orderId:r.order_id,tradeId:t.sourceId,tokenId:t.token,side,eventTs:t.at.utc,receiptTs:t.at.utc,processingOrder:id,finality:'SIMULATED',grossShares:Number(text(q)),netSharesDelta:Number(text(side==='BUY'?q:-q)),price:Number(text(p)),cashDelta:Number(text(side==='BUY'?-gross:gross,C)),feeAsset:'USDC',feeAmount:0,feeEvidence:'MODELED',ruleVersion:this.policy.feeModel,roundingPolicy:'exact-scale18-cash-scale9-shares;canonical-real-projection',collateralAsset:'USDC'});
      this.db.prepare('UPDATE shadow_orders SET status=?,filled_size=?,filled_price=?,last_update_ts=? WHERE id=?').run(remaining===0n?'FILLED':'PARTIAL',Number(text(nextFilled)),Number(priorNotional+gross)/Number(nextFilled*S),t.at.utc,r.order_id);
     }finally{this.internal=false;}
     this.db.prepare('UPDATE paper_execution_orders SET remaining=?,status=? WHERE order_id=?').run(text(remaining),remaining===0n?'FILLED':'ACTIVE',r.order_id);
     this.db.prepare('INSERT INTO paper_execution_allocations VALUES(?,?,?)').run(t.sourceId,r.order_id,q.toString());left-=q;allocated+=q;
    }
   }
   need(aheadConsumed+allocated<=volume,'conservation');
   this.db.prepare('INSERT INTO paper_execution_trades VALUES(?,?,?,?,?,?)').run(t.sourceId,fingerprint,JSON.stringify(t),volume.toString(),aheadConsumed.toString(),allocated.toString());
   this.db.prepare('UPDATE paper_execution_account SET last_utc=?,last_mono=? WHERE id=1').run(t.at.utc,t.at.mono);
   this.db.prepare('INSERT INTO paper_execution_watermarks VALUES(?,?) ON CONFLICT(token) DO UPDATE SET venue_utc=excluded.venue_utc').run(t.token,t.venueUtc);
   return {duplicate:false,allocatedShares:text(allocated),aheadConsumedShares:text(aheadConsumed)};
  })();
 }
 snapshot(){const rows=this.active();let reserved=0n;const sell:Record<string,bigint>={};
  for(const r of rows){if(r.side==='BUY')reserved+=units(r.price)*units(r.remaining);else sell[r.token]=(sell[r.token]??0n)+units(r.remaining);}
  const cash=BigInt(this.account()!.cash),exposureRemaining=units(this.policy.maxExposure)*S-(units(this.policy.openingCash)*S-cash)-reserved;
  const available=min(min(cash-reserved,exposureRemaining),units(this.policy.maxExposure)*S-reserved);
  return {cashUSDC:text(cash,C),shares:Object.fromEntries((this.db.prepare('SELECT * FROM paper_execution_positions ORDER BY token').all() as Row[]).map(r=>[r.token,text(BigInt(r.shares))])),
   reservedBuyUSDC:text(reserved,C),reservedSellShares:Object.fromEntries(Object.entries(sell).map(([k,v])=>[k,text(v)])),availableBuyUSDC:text(available>0n?available:0n,C),
   orders:this.db.prepare('SELECT * FROM shadow_orders ORDER BY id').all(),queues:this.db.prepare('SELECT * FROM paper_execution_queues ORDER BY token,side,price').all(),
   trades:this.db.prepare('SELECT * FROM paper_execution_trades ORDER BY rowid').all(),allocations:this.db.prepare('SELECT * FROM paper_execution_allocations ORDER BY rowid').all(),
   finality:'SIMULATED',actualPaidFees:null,actualRevenue:null,forcedFills:false,syntheticRebalance:false};
 }
 terminalReport(options:{valuationTs:number;asOfReceiptTs?:number}){
  const snapshot=this.snapshot(),canonical=getAccountingReport(this.db,this.policy.accountKey,options.valuationTs,options.asOfReceiptTs);
  const missing=Object.entries(snapshot.shares).filter(([token,q])=>{
   if(units(q)===0n)return false;const p=canonical.positions.find(p=>p.tokenId===token);
   try{return !p||units(p.shares)!==units(q)||p.mark==null||p.markTs==null||p.markTs>Math.min(options.valuationTs,options.asOfReceiptTs??options.valuationTs)||options.valuationTs-p.markTs>60000;}catch{return true;}
  }).map(([token])=>token);
  const lastFill=(this.db.prepare('SELECT MAX(ts) ts FROM shadow_fills').get() as Row).ts as number|null;
  const retrospectiveUnsupported=lastFill!=null&&Math.min(options.valuationTs,options.asOfReceiptTs??options.valuationTs)<lastFill;
  const accounting=missing.length||retrospectiveUnsupported?{...canonical,reportId:digest({canonicalReportId:canonical.reportId,exactMissing:missing,retrospectiveUnsupported,snapshot}),canonicalReportId:canonical.reportId,accountingVersion:canonical.accountingVersion+'+exact-paper-holdings-v1',complete:false,netPnl:null,issues:[...canonical.issues,...missing.map(tokenId=>({code:'EXACT_NONZERO_HOLDING_UNMARKED',tokenId})),...(retrospectiveUnsupported?[{code:'RETROSPECTIVE_EXACT_HOLDINGS_UNSUPPORTED'}]:[])],assurance:{...canonical.assurance,dataComplete:false,postingValidated:false}}:canonical;
  return {snapshot,accounting,canonicalAccounting:canonical,exactUnmarkedTokens:missing,retrospectiveUnsupported,realizedVenueProfit:null,queueModel:'risk-adverse-same-price-cohort-fifo-v1'};
 }
}
