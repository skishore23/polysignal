import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyOriginalPrint, createPaperDatabase, PaperFillSession, restorePaperBook } from '../../scripts/research/maker_fill_paper';
import { createOperatingSourceState } from '../../scripts/research/maker_operating_source_bridge';
import { currentSlotMetadataUrl } from '../../scripts/research/maker_startup_capture';
import { selectCurrentBtcMarket } from '../../scripts/research/maker_paper_startup';

const START = 1_800_000_000_000, CONDITION = `0x${'a'.repeat(64)}`;
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
describe('actual ordinary MakerLoop with separately typed conserving paper sink', () => {
  it('creates a real ordinary quote, accounts a supported modeled fill and preserves funded state on reopen', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'paper-fill-factory-')); dirs.push(dir);
    const file = path.join(dir, 'paper.sqlite'), db = createPaperDatabase(file);
    let at = { utc: START, mono: 0 };
    const raw = (url: string, value: unknown) => { const text = JSON.stringify(value); return { url, raw: text, at: { ...at }, startedAt: { ...at }, status: 200, sha256: createHash('sha256').update(text).digest('hex') }; };
    const gamma = raw(currentSlotMetadataUrl(START), { id: '45', version: 'v2', conditionId: CONDITION,
      slug: `btc-updown-5m-${START / 1000}`, question: 'Bitcoin Up or Down, five minutes', description: 'Authored offline integration only',
      eventStartTime: new Date(START).toISOString(), endDate: new Date(START + 300000).toISOString(), active: true, closed: false,
      archived: false, acceptingOrders: true, enableOrderBook: true, negRisk: false, outcomes: '["Up","Down"]',
      clobTokenIds: '["999","888"]', positionIds: ['111','222'], orderPriceMinTickSize: .01, orderMinSize: 5,
      volume: '100', liquidity: '100', feesEnabled: true, feeSchedule: { rate: .25, exponent: 1, takerOnly: true, rebateRate: 0 } });
    const selection = selectCurrentBtcMarket(gamma);
    const config = JSON.parse(readFileSync('configs/worker.json','utf8'));
    const book = (bid = '0.49') => ({ version: 'v2', market: CONDITION, asset_id: '111', timestamp: String(at.utc),
      bids: [{ price: bid, size: '900' }], asks: [{ price: '0.51', size: '100' }], hash: 'authored-'+at.utc,
      tick_size: '0.01', min_order_size: '5', neg_risk: false });
    const source = createOperatingSourceState({ gamma, selection,
      clobMarket: raw(`https://clob.polymarket.com/clob-markets/${CONDITION}`, { t: [{t:'111',o:'Up'},{t:'222',o:'Down'}], mos:5,mts:.01,mbf:0,tbf:10,fd:{r:.25,e:1,to:true},oas:0 }),
      clobBook: raw('https://clob.polymarket.com/book?token_id=111',book()), tokenFee: raw('https://clob.polymarket.com/fee-rate?token_id=111',{base_fee:2500}),
      originalLabel: 'Up', topKLevels: config.topN, decision: at }, {maxTradesPerSlot:20000});
    const logger: any = Object.fromEntries(['info','warn','error','debug','trace','fatal'].map(k=>[k,()=>{}]));
    vi.spyOn(Date,'now').mockImplementation(()=>at.utc);
    let session = new PaperFillSession(db,config,()=>at,logger);
    try {
      const quoteSnapshotSpy = vi.spyOn(session.execution, 'snapshot');
      for (let s=1;s<=40;s++) {
        at={utc:START+s*1000,mono:s*1000}; const b=book(s%2 ? '0.49':'0.48');
        source.process({kind:'frame',at,raw:JSON.stringify({...b,event_type:'book'})});
        if(s===13)source.process({kind:'frame',at,raw:JSON.stringify({event_type:'last_trade_price',market:CONDITION,asset_id:'111',timestamp:String(at.utc),price:'0.50',size:'5',side:'BUY'})});
        source.process({kind:'sample',at}); const d=source.snapshot(at);
        session.execution.observeBook({sourceId:b.hash,market:'45',token:'111',bids:b.bids,asks:b.asks,tick:'0.01',lot:d.book.lot,minimumShares:d.book.minimumShares,minimumNotionalUSDC:d.book.minimum,at,venueUtc:at.utc});
        await session.sample(d);
      }
      // Ordinary quote sizing must not materialize the cumulative audit history.
      expect(quoteSnapshotSpy).not.toHaveBeenCalled();
      quoteSnapshotSpy.mockRestore();
      const all = session.execution.snapshot().orders as any[];
      expect(all.length).toBeGreaterThan(0);
      const order=all.find(o=>o.status==='OPEN'&&o.side==='BUY'); expect(order).toBeDefined();
      at={utc:at.utc+200,mono:at.mono+200};
      const beforeForeign=session.execution.snapshot();
      expect(applyOriginalPrint(session.execution,{event_type:'last_trade_price',asset_id:'222',market:CONDITION,
        timestamp:String(at.utc),side:'SELL',price:String(order.price),size:'1100'}, {token:'111',condition:CONDITION},at)).toBeNull();
      expect(session.execution.snapshot()).toEqual(beforeForeign);
      restorePaperBook(db,session.execution,{sourceId:'authored-warm-book',market:'45',token:'111',tick:'0.01',lot:'0.01',minimumShares:'5',minimumNotionalUSDC:'5',
        bids:[{price:'0.48',size:'900'}],asks:[{price:'0.51',size:'100'}],at,venueUtc:at.utc});
      expect(session.execution.snapshot()).toEqual(beforeForeign);
      const result=session.execution.processTrade({sourceId:'authored-large-opposite-print',token:'111',side:'SELL',price:String(order.price),size:'1100',at,venueUtc:at.utc});
      expect(Number(result.allocatedShares),JSON.stringify({order,result,after:session.execution.snapshot()})).toBeGreaterThan(0);
      const snapshot=session.execution.snapshot(); expect(Number(snapshot.cashUSDC)).toBeLessThan(100); expect(Number(snapshot.shares['111'])).toBeGreaterThan(0);
      expect(db.prepare("SELECT COUNT(*) n FROM accounting_events WHERE kind='FILL' AND finality='SIMULATED'").get()).toMatchObject({n:1});
      session.close(); session = new PaperFillSession(db,config,()=>at,logger);
      expect(session.execution.snapshot().cashUSDC).toBe(snapshot.cashUSDC); expect(session.execution.snapshot().shares).toEqual(snapshot.shares);
      expect(db.prepare("SELECT COUNT(*) n FROM accounting_events WHERE kind='OPENING'").get()).toMatchObject({n:1});
    } finally { session.close(); db.close(); }
  });
});
