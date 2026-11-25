import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {afterEach,describe,it,expect,vi} from 'vitest';
import * as paper from '../../scripts/research/maker_fill_paper';
const N=16384, MAX=49152, dirs:string[]=[];
afterEach(()=>{vi.restoreAllMocks();syncBuiltinESMExports();for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true})});
const writer=(fd:number,wire:string)=>((paper as any).writeWireSync??((fd:number,v:string)=>fs.writeFileSync(fd,v)))(fd,wire);
const sha=(value:any)=>((paper as any).hashValue??((v:any)=>createHash('sha256').update(v).digest('hex')))(value);
const nativeSha=(v:any)=>createHash('sha256').update(v).digest('hex');
const samples=['','ascii\0\n','π❄️中文😀','a'.repeat(N-1)+'😀tail','b'.repeat(N-2)+'😀tail','c'.repeat(N)+'😀tail',
 'd'.repeat(N-1)+'\ud800\ud800\udc00x','e'.repeat(N-1)+'\udc00\ud800z','\ud800'+'f'.repeat(N-2)+'\udc00',
 '中'.repeat(N+1),JSON.stringify({x:'😀π'.repeat(N),negativeZero:-0,nan:NaN,missing:undefined},null,2)+'\n'];
function files(){const dir=fs.mkdtempSync(path.join(tmpdir(),'bounded-paper-wire-'));dirs.push(dir);return [path.join(dir,'actual'),path.join(dir,'native')];}
describe('bounded UTF8 publication and exact long string SHA, authored inputs',()=>{
 it.each(samples.map((wire,index)=>({wire,index})))('matches actual Node numeric-fd UTF8 and SHA case $index',({wire})=>{
  const [a,b]=files();const fd=fs.openSync(a!,'wx');try{writer(fd,wire)}finally{fs.closeSync(fd)}
  const ref=fs.openSync(b!,'wx');try{fs.writeFileSync(ref,wire)}finally{fs.closeSync(ref)}
  expect(fs.readFileSync(a!)).toEqual(fs.readFileSync(b!));expect(sha(wire)).toBe(nativeSha(wire));expect(nativeSha(fs.readFileSync(a!))).toBe(nativeSha(wire));
 });
 it('never sends a whole long UTF8 string to native file publication',()=>{
  const [file]=files(),fd=fs.openSync(file!,'wx'),wire='😀π中'.repeat(N);const old=fs.writeFileSync;let whole=0;
  const spy=vi.spyOn(fs,'writeFileSync').mockImplementation(((f:any,value:any,...rest:any[])=>{if(f===fd&&typeof value==='string'&&value.length>N)whole++;return (old as any)(f,value,...rest)}) as any);syncBuiltinESMExports();
  try{writer(fd,wire)}finally{fs.closeSync(fd);spy.mockRestore();syncBuiltinESMExports()}
  expect(whole).toBe(0);expect(fs.readFileSync(file!)).toEqual(Buffer.from(wire));
 });
 it('reuses one capped backing buffer and writes only its valid prefix',()=>{
  const [file]=files(),fd=fs.openSync(file!,'wx'),wire='a'.repeat(N*3+1)+'😀';const old=fs.writeSync;const backings=new Set<ArrayBufferLike>();let calls=0,max=0;
  const spy=vi.spyOn(fs,'writeSync').mockImplementation(((f:any,b:any,offset:any,length:any,...rest:any[])=>{if(f===fd){calls++;expect(Buffer.isBuffer(b)).toBe(true);backings.add(b.buffer);max=Math.max(max,b.byteLength);expect(length).toBeLessThanOrEqual(MAX);}return (old as any)(f,b,offset,length,...rest)}) as any);syncBuiltinESMExports();
  try{writer(fd,wire)}finally{fs.closeSync(fd);spy.mockRestore();syncBuiltinESMExports()}
  expect(calls).toBeGreaterThan(1);expect(backings.size).toBe(1);expect(max).toBeLessThanOrEqual(MAX);expect(fs.readFileSync(file!)).toEqual(Buffer.from(wire));
 });
 it('handles positive partial writes without losing or repeating bytes',()=>{
  const [file]=files(),fd=fs.openSync(file!,'wx'),wire='a'.repeat(N-1)+'😀\ud800end';const old=fs.writeSync;let calls=0;
  const spy=vi.spyOn(fs,'writeSync').mockImplementation(((f:any,b:any,offset:any,length:any,...rest:any[])=>{if(f===fd){calls++;return (old as any)(f,b,offset,Math.min(length,7),...rest)}return (old as any)(f,b,offset,length,...rest)}) as any);syncBuiltinESMExports();
  try{writer(fd,wire)}finally{fs.closeSync(fd);spy.mockRestore();syncBuiltinESMExports()}
  expect(calls).toBeGreaterThan(1);expect(fs.readFileSync(file!)).toEqual(Buffer.from(wire));
 });
 it.each([0,-1,NaN,Infinity,1.5,100000])('fails closed on invalid write progress %s',progress=>{
  const [file]=files(),fd=fs.openSync(file!,'wx');const spy=vi.spyOn(fs,'writeSync').mockReturnValue(progress);syncBuiltinESMExports();
  try{expect(()=>writer(fd,'payload')).toThrow('wire_write_progress')}finally{fs.closeSync(fd);spy.mockRestore();syncBuiltinESMExports()}
 });
 it('preserves an I/O error after an already-written prefix',()=>{
  const [file]=files(),fd=fs.openSync(file!,'wx');const old=fs.writeSync;let calls=0;
  const spy=vi.spyOn(fs,'writeSync').mockImplementation(((f:any,b:any,offset:any,length:any)=>{if(f!==fd)return (old as any)(f,b,offset,length);if(calls++)throw Object.assign(new Error('authored EIO'),{code:'EIO'});return (old as any)(f,b,offset,3)}) as any);syncBuiltinESMExports();
  try{expect(()=>writer(fd,'abcdefgh')).toThrow('authored EIO')}finally{fs.closeSync(fd);spy.mockRestore();syncBuiltinESMExports()}
  expect(fs.readFileSync(file!,'utf8')).toBe('abc');
 });
 it('keeps only capped Buffer prefixes on the long-string hash path',()=>{
  const wire='中😀'.repeat(N),expected=nativeSha(wire),prototype=Object.getPrototypeOf(createHash('sha256')),old=prototype.update;const seen:any[]=[];
  const spy=vi.spyOn(prototype,'update').mockImplementation(function(this:any,data:any,encoding:any){seen.push({kind:typeof data,bytes:Buffer.isBuffer(data)?data.length:null,backing:Buffer.isBuffer(data)?data.buffer:null});return old.call(this,data,encoding)} as any);
  let actual:string;try{actual=sha(wire)}finally{spy.mockRestore()}
  expect(actual!).toBe(expected);expect(seen.length).toBeGreaterThan(1);expect(seen.every(v=>v.kind==='object'&&v.bytes<=MAX)).toBe(true);expect(new Set(seen.map(v=>v.backing)).size).toBe(1);
 });
 it.each([N-1,N,N+1])('retains exact native hash at %s code units',length=>{const value='x'.repeat(length);expect(sha(value)).toBe(nativeSha(value))});
 it('preserves native Buffer/short-string paths and invalid-value errors',()=>{
  for(const value of [Buffer.from([0,255,192,128,237,160,128]),Buffer.alloc(N*5,0xa5),'short'])expect(sha(value)).toBe(nativeSha(value));
  for(const value of [null,undefined,12,{},new String('x')]){let a:any,b:any;try{sha(value)}catch(e){a=e}try{nativeSha(value)}catch(e){b=e}expect(a?.constructor).toBe(b?.constructor);expect(a?.code).toBe(b?.code)}
 });
 it('agrees on seeded arbitrary UTF16, including unpaired surrogates',()=>{
  let state=16016;for(let trial=0;trial<64;trial++){const code:number[]=[];for(let i=0;i<N+(trial%7);i++){state=(Math.imul(state,1664525)+1013904223)>>>0;code.push(state&65535)}const value=String.fromCharCode(...code);expect(sha(value)).toBe(nativeSha(value))}
 });
});
