import {expect,it} from 'vitest';
import {publishedResultProjection,retainedResultProjection} from '../../scripts/research/maker_fill_paper';

it('matches the exact persisted JSON projection including negative zero, null, nonfinite and omitted fields',()=>{
 const values=[undefined,null,-0,0,.10000000000000002,NaN,Infinity,-Infinity];
 for(const netPnl of values)for(const valuationTs of [undefined,null,-0,1795600000001]){
  const value={schema:'CONSERVING_PAPER_EPOCH_RESULT_V1',epoch:'authored',terminal:{snapshot:{cashUSDC:'101.659900000000000000',shares:{'π':'2.460000000'},reservedBuyUSDC:'0.000000000000000000',reservedSellShares:{'π':'0.010000000'}},accounting:{complete:netPnl===null,netPnl,valuationTs}},history:[{large:'retained only in full report'}]};
  const original=JSON.stringify(value),expected=retainedResultProjection(JSON.parse(original)),actual=publishedResultProjection(value);
  expect(actual).toStrictEqual(expected);expect(JSON.stringify(value)).toBe(original);expect(Object.is(actual.terminal!.accounting!.netPnl,-0)).toBe(false);
 }
 for(const value of [{schema:'missing'}, {schema:'null',terminal:null}, {schema:'partial',terminal:{snapshot:undefined,accounting:{complete:false}}}])expect(publishedResultProjection(value)).toStrictEqual(retainedResultProjection(JSON.parse(JSON.stringify(value))));
});
it('detaches the compact state while leaving every full history field and publication value intact',()=>{
 const value={schema:'report',epoch:'authored',terminal:{snapshot:{cashUSDC:'98',shares:{t:'4'},reservedBuyUSDC:'0',reservedSellShares:{}},accounting:{complete:false,netPnl:null,valuationTs:10}},history:Array.from({length:40000},(_,id)=>({id,payload:'authored-long-history'}))};
 const before=JSON.stringify(value),p=publishedResultProjection(value);value.terminal.snapshot.shares.t='5';expect(p.terminal!.snapshot!.shares.t).toBe('4');expect('history'in p).toBe(false);value.terminal.snapshot.shares.t='4';expect(JSON.stringify(value)).toBe(before);
});
