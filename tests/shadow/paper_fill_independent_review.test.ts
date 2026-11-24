import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { PaperMakerExecution, type PaperMakerPolicy, type PaperBook } from '../../apps/worker/src/shadow/PaperMakerExecution';

const T = 1_800_000_000_000;
const all: Database.Database[] = [];
afterEach(() => { for (const db of all.splice(0)) db.close(); });
function fixture() {
  const db = new Database(':memory:'); all.push(db);
  for (const file of ['tests/maker/fixtures/startup-canonical-schema.sql','packages/storage/migrations/0048_accounting_events.sql','packages/storage/migrations/0049_accounting_reports.sql']) db.exec(readFileSync(file, 'utf8'));
  let ms = 0;
  const clock = () => ({utc:T + ms, mono:ms});
  const policy:PaperMakerPolicy = {accountKey:'wallet:2', walletId:2, openingCash:'100', perOrder:'20', maxExposure:'40', maxInventoryShares:'200', submitLatencyMs:100, cancelLatencyMs:0, feeModel:'paper-maker-zero-fee-v1'};
  let e = new PaperMakerExecution(db, policy, clock);
  const book = (bid='0.49', qty='10', ask='0.60', extra:Partial<PaperBook>={}) => {
    const b:PaperBook = {sourceId:'book/'+ms, token:'123', market:'77', tick:'0.01', lot:'0.01', minimumShares:'1', minimumNotionalUSDC:'0', at:clock(), venueUtc:T+ms,
      bids:[{price:bid,size:qty}], asks:[{price:ask,size:'100'}],...extra};
    e.observeBook(b);
  };
  book();
  const submit = (qty=10, price=.5, side='BUY', ttl=5000) => Number(db.prepare("INSERT INTO shadow_orders(ts,wallet_id,token_id,market_id,side,kind,price,size,expected_cancel_ts,execution_mode,status,filled_size,last_update_ts) VALUES(?,2,'123','77',?,?,?,?,?,'SHADOW','OPEN',0,?)").run(T+ms, side, side==='BUY'?'MAKER_BID':'MAKER_ASK',price,qty,T+ms+ttl,T+ms).lastInsertRowid);
  const trade = (key:string, size:string, venue=ms, side:'BUY'|'SELL'='SELL', price='0.50') => e.processTrade({sourceId:key,token:'123',side,price,size,at:clock(),venueUtc:T+venue});
  return {db,clock,policy, at:(v:number)=>{ms=v}, book, submit, trade, get engine(){return e}, reopen:()=>{e=new PaperMakerExecution(db,policy,clock)}};
}
describe('independent authored paper lifecycle obligations', () => {
  it('does not execute a post-only bid that crosses the effective book at activation',()=>{
    const f=fixture(); f.submit(); f.at(60); f.book('0.48','10','0.49'); f.at(110);
    expect(f.trade('aftercross','6').allocatedShares).toBe('0.000000000');
  });
  it('does not jump a displayed same-price bid received during submit latency',()=>{
    const f=fixture(); f.submit(); f.at(70); f.book('0.50','20'); f.at(111);
    expect(f.trade('afterdepth','6').allocatedShares).toBe('0.000000000');
  });
  it('keeps new external same-price size ahead of the later own order',()=>{
    const f=fixture(); f.submit(1); f.at(110); f.book('0.50','20'); f.at(115); f.submit(5);
    f.at(220); const fill=f.trade('later','6'); expect(fill.allocatedShares).toBe('1.000000000');
  });
  it('does not accept new trade with an earlier venue clock than the prior selected-token print',()=>{
    const f=fixture(); f.submit(); f.at(300); f.trade('newer','1',250); f.at(310);
    expect(()=>f.trade('older','2',225)).toThrow();
  });
  it('rejects an order extending beyond five seconds',()=>{const f=fixture();expect(()=>f.submit(10,.5,'BUY',5001)).toThrow()});
  it('rejects an order off the original .01-share lot',()=>{const f=fixture();expect(()=>f.submit(10.001)).toThrow()});
  it('reconciles a tiny legal public print before the next qualifying print',()=>{
    const f=fixture(); f.submit(); f.at(110); f.trade('dust','0.000000001'); f.at(120);
    expect(f.trade('rest','2').allocatedShares).toBe('2.000000000');
  });
  it('checks for an existing opening ledger when no orders remain',()=>{
    const f=fixture(); f.db.prepare('DELETE FROM paper_execution_account').run();
    f.at(10); expect(()=>f.reopen()).toThrow();
  });
  it('keeps the absolute aggregate reservation cap after profitable sells',()=>{
    const f=fixture(); f.book('0.09'); f.submit(40,.10); f.at(110); f.trade('b','40',110,'SELL','0.10');
    f.submit(40,.50,'SELL'); f.at(220); f.trade('s','40',220,'BUY','0.50');
    expect(f.engine.snapshot().cashUSDC).toBe('116.000000000000000000');
    f.submit(40,.50); f.submit(40,.50); expect(()=>f.submit(20,.50)).toThrow();
  });
  it('cannot match a previously admitted order to a different market after reopening',()=>{
    const f=fixture(); f.submit(); f.at(200); f.reopen();
    expect(()=>{f.book('0.49','10','0.6',{market:'wrong-market'});const r=f.trade('cross-market','3');if(r.allocatedShares==='0.000000000')throw Error('safe refusal');}).toThrow();
  });
  it('rejects a reused database with independent residual canonical bank events',()=>{
    const f=fixture(); f.db.exec("DELETE FROM paper_execution_account; DELETE FROM accounting_events");
    f.db.prepare("INSERT INTO accounting_events(event_key,account_key,kind,source,source_ref,event_ts,receipt_ts,processing_order,finality,cash_delta,fee_evidence,rule_version,rounding_policy,collateral_asset) VALUES('unrelated','wallet:2','TRANSFER','fixture','1',?,?,1,'SIMULATED',8,'NOT_APPLICABLE','fixture','none','USDC')").run(T,T);
    expect(()=>f.reopen()).toThrow();
  });
  it('keeps a one-nanoshare exact position unmarked until it has a valid quote',()=>{
    const f=fixture(); f.submit(); f.at(115); f.trade('dust-only','0.000000001');
    const terminal=f.engine.terminalReport({valuationTs:f.clock().utc});
    expect(terminal.snapshot.shares['123']).toBe('0.000000001');
    expect(terminal.accounting.netPnl).toBeNull();
  });
  it('refuses a stale effective-activation book even when a fresh later book exists',()=>{
    const f=fixture(); f.at(950); f.submit(); f.at(1100); f.book(); f.at(1130);
    expect(f.trade('late-refresh','4').allocatedShares).toBe('0.000000000');
  });
  it('releases reservations as soon as the activation check rejects a crossing maker',()=>{
    const f=fixture(); f.submit(); f.at(100); f.book('0.47','10','0.48');
    expect(f.engine.snapshot().reservedBuyUSDC).toBe('0.000000000000000000');
    expect((f.engine.snapshot().orders[0] as {status:string}).status).toBe('REJECTED');
  });
  it('reconstructs conserved queue allocations, independent per-order remainder and bank on restart',()=>{
    const f=fixture(); f.book('0.50','5'); f.submit(2); f.submit(2);
    f.at(120); const first=f.trade('one','8'); expect(first).toMatchObject({aheadConsumedShares:'5.000000000',allocatedShares:'3.000000000'});
    const before=f.engine.snapshot();expect(before.cashUSDC).toBe('98.500000000000000000');expect(before.reservedBuyUSDC).toBe('0.500000000000000000');
    f.reopen();f.book('0.50','1');expect(f.trade('one','8').duplicate).toBe(true);f.at(130);f.trade('two','1');
    const end=f.engine.snapshot();expect(end.shares['123']).toBe('4.000000000');expect(end.cashUSDC).toBe('98.000000000000000000');
    expect(end.orders.map((o:any)=>[o.status,o.filled_size])).toEqual([['FILLED',2],['FILLED',2]]);
  });
  it('cancelling an older cohort cannot promote later orders through unproven external cancellations',()=>{
    const f=fixture(); f.book('0.50','5'); const first=f.submit(2);
    f.at(110); f.book('0.50','1'); f.at(120); f.submit(2); f.at(125); f.engine.cancel(first,f.clock());
    f.at(230); const r=f.trade('still-ahead','2');expect(r.allocatedShares).toBe('0.000000000');
  });
  it('cannot certify an as-of-receipt valuation from a mark later than that cutoff',()=>{
    const f=fixture(); f.submit(2); f.at(150); f.trade('held','2');
    f.at(300); f.db.prepare('INSERT INTO latest_features(token_id,ts,mid) VALUES(?,?,?)').run('123',T+300,.75);
    const r=f.engine.terminalReport({valuationTs:T+300,asOfReceiptTs:T+200});
    expect(r.accounting.netPnl).toBeNull();
  });
  it('preserves the mark cutoff for an earlier position sold before report creation',()=>{
    const f=fixture(); f.submit(2); f.at(150); f.trade('b','2'); f.submit(2,.55,'SELL');
    f.at(400); f.trade('s','2',400,'BUY','0.55');
    f.db.prepare('INSERT INTO latest_features(token_id,ts,mid) VALUES(?,?,?)').run('123',T+300,.75);
    const r=f.engine.terminalReport({valuationTs:T+300,asOfReceiptTs:T+200});
    expect(r.accounting.netPnl).toBeNull();
  });
});
