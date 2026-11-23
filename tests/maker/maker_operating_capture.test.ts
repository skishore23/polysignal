import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { chmodSync, closeSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import WebSocket, { WebSocketServer, type ClientOptions } from 'ws';
import { performance } from 'node:perf_hooks';
import { OperatingSourceCapture, verifyOperatingCaptureArchive, type OperatingCapturePolicy } from '../../scripts/research/maker_operating_capture';
import { currentSlotMetadataUrl, type CaptureMarket, type CaptureSocketOptions } from '../../scripts/research/maker_startup_capture';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)), EPOCH = 1_800_000_000_000;
const MARKET: CaptureMarket = { condition: `0x${'1'.repeat(64)}`, token: '123', protocolVersion: 'v1' };
const parents: string[] = [];
class Socket extends EventEmitter {
  sent: string[] = []; terminated = false;
  send(raw: string, _options: unknown, callback: (e?: Error) => void) { this.sent.push(raw); callback(); }
  pong(_raw: Buffer) {}
  terminate() { this.terminated = true; this.emit('close'); }
  message(raw: string | Buffer, binary = false) { this.emit('message', Buffer.from(raw), binary); }
}
type Spec = { body?: Buffer | string; status?: number; stalled?: boolean };
function fixture(change: Partial<OperatingCapturePolicy> = {}, specs: Spec[] = []) {
  const parent = mkdtempSync(path.join(ROOT, 'reports/evidence/operating-offline-')); parents.push(parent);
  const outputDir = path.join(parent, 'capture');
  const calls: { url: string; options: RequestOptions; destroyed: boolean }[] = [];
  const sockets: { url: string; options: CaptureSocketOptions; socket: Socket }[] = [];
  const h = { skew: 0, monoSkew: 0, clockThrows: false, disk: 1n << 40n,
    clock: () => { if (h.clockThrows) throw Error('clock_unavailable');
      return { utc: Date.now() + h.skew, mono: Date.now() - EPOCH + h.monoSkew }; },
    request: (url: string, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
      const call = { url, options, destroyed: false }; const spec = specs[calls.length] ?? {}; calls.push(call);
      const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
      req.destroy = () => { call.destroyed = true; };
      req.end = () => queueMicrotask(() => {
        const res = new Readable({ read() {} }) as Readable & { statusCode: number; headers: object; rawHeaders: string[]; complete: boolean };
        res.statusCode = spec.status ?? 200; res.headers = { 'content-type': 'application/json' }; res.rawHeaders = []; res.complete = false;
        callback(res as unknown as IncomingMessage); if (res.destroyed) return;
        res.push(Buffer.from(spec.body ?? '{}')); if (!spec.stalled) { res.complete = true; res.push(null); }
      });
      return req as unknown as ClientRequest;
    },
    socket: (url: string, options: CaptureSocketOptions) => { const socket = new Socket(); sockets.push({ url, options, socket }); return socket as unknown as WebSocket; },
    freeDiskBytes: () => h.disk,
  };
  const policy = { metadataUrl: currentSlotMetadataUrl(EPOCH), expiresUtcMs: EPOCH + 300_000, freeDiskReserveBytes: 0, ...change };
  const capture = new OperatingSourceCapture(policy, h.clock, outputDir, h);
  return { capture, h, outputDir, calls, sockets, policy };
}
async function ready(f: ReturnType<typeof fixture>, market = MARKET) {
  await f.capture.readMetadata(); f.capture.bindMarket(market); await f.capture.readMarket(); await f.capture.readBook(); await f.capture.readFee();
}
async function flush() { for (let n = 0; n < 50; n++) await Promise.resolve(); }
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(EPOCH); });
afterEach(() => { vi.useRealTimers(); for (const p of parents.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe('one operating source attempt; all public HTTP mocked', () => {
  it.each(['v1', 'v2'] as const)('pins four exact HTTP reads and explicit %s without a second source', async protocolVersion => {
    const f = fixture(); await ready(f, { ...MARKET, protocolVersion });
    expect(f.calls.map(x => x.url)).toEqual([currentSlotMetadataUrl(EPOCH),
      `https://clob.polymarket.com/${protocolVersion === 'v1' ? 'markets' : 'clob-markets'}/${MARKET.condition}`,
      'https://clob.polymarket.com/book?token_id=123', 'https://clob.polymarket.com/fee-rate?token_id=123']);
    for (const x of f.calls) expect(x.options).toMatchObject({ agent: false, method: 'GET', maxHeaderSize: 16384 });
    expect(f.capture.ledger().httpProofs).toHaveLength(4); expect(f.capture.proofHeadSha256()).toMatch(/^[a-f0-9]{64}$/);
    f.capture.stop(); await f.capture.settleCallbacks();
  });

  it('rotates by message count instead of closing, with no lifetime controls/index array in memory', async () => {
    const f = fixture({ segmentMessages: 3 }); await ready(f); let n = 0;
    const pending = f.capture.stream({ onMessage() { n++; }, onSample() {}, shouldStop: () => n === 10 });
    const socket = f.sockets[0]!.socket; socket.emit('open'); const heads = new Set<string>();
    for (let k = 0; k < 10; k++) { socket.message(`message-${k}`); heads.add(f.capture.proofHeadSha256()); }
    await pending; await f.capture.settleCallbacks(); const ledger = f.capture.ledger();
    expect(n).toBe(10); expect(heads.size).toBe(10); expect(ledger.index).toMatchObject({ segments: 4, closed: true });
    expect(ledger.wsMessages).toBe(10); expect(ledger.controls).toBeUndefined(); expect(ledger.segments).toBeUndefined();
    expect(ledger.segment).toBeNull(); expect(ledger.queuedMessages).toBe(0);
    expect(await verifyOperatingCaptureArchive(f.outputDir, ledger)).toMatchObject({ segments: 4, messages: 10 });
    expect(f.sockets).toHaveLength(1); expect(f.calls).toHaveLength(4);
  });

  it('rotates at byte boundaries without turning a storage segment into an ingress cap', async () => {
    const f = fixture({ segmentBodyBytes: 8 }); await ready(f); let n = 0;
    const pending = f.capture.stream({ onMessage() { n++; }, onSample() {}, shouldStop: () => n === 5 });
    const socket = f.sockets[0]!.socket; socket.emit('open'); for (let k = 0; k < 5; k++) socket.message('abcd');
    await pending; await f.capture.settleCallbacks(); const l = f.capture.ledger();
    expect(l.index.segments).toBe(3); expect(l.wsBodyBytes).toBe(20); expect(l.archiveVerification.messages).toBe(5);
    expect(l.tlsWireBytes).toBeNull(); expect(l.actualAccountChargesUSD).toBeNull();
  });

  it('does not grow its ledger with the number of closed segments', async () => {
    const f = fixture({ segmentMessages: 1 }); await ready(f); let n = 0;
    const pending = f.capture.stream({ onMessage() { n++; }, onSample() {}, shouldStop: () => n === 50 });
    const socket = f.sockets[0]!.socket; socket.emit('open'); for (let k = 0; k < 50; k++) socket.message(String(k));
    await pending; await f.capture.settleCallbacks();
    expect(f.capture.ledger().index.segments).toBe(50); expect(JSON.stringify(f.capture.ledger()).length).toBeLessThan(20_000);
    expect(readFileSync(path.join(f.outputDir, 'segments.ndjson'), 'utf8').trim().split('\n')).toHaveLength(50);
  });

  it.each(['messages', 'bytes'])('fails closed on bounded queued %s instead of dropping or resetting the book', async kind => {
    const f = fixture(kind === 'messages' ? { maxQueuedMessages: 2 } : { maxQueuedBytes: 5 }); await ready(f);
    const seen: string[] = []; let release!: () => void;
    const pending = f.capture.stream({ onMessage: async c => { seen.push(c.raw); await new Promise<void>(r => { release = r; }); },
      onSample() {}, shouldStop: () => false }); const check = expect(pending).rejects.toThrow('queue_capacity');
    const socket = f.sockets[0]!.socket; socket.emit('open'); socket.message('aaa'); await flush(); socket.message('bbb');
    if (kind === 'messages') socket.message('ccc');
    expect(f.capture.observationFrontier().open).toBe(false); await check;
    let done = false; const joined = f.capture.settleCallbacks().then(() => { done = true; }); await flush(); expect(done).toBe(false);
    release(); await joined; expect(seen).toEqual(['aaa']);
    expect(f.capture.ledger().archiveVerification.messages).toBe(kind === 'messages' ? 3 : 2);
    expect(f.sockets).toHaveLength(1); expect(f.calls).toHaveLength(4);
  });

  it('advances the delivered application frontier before queued semantic delivery and excludes PONG', async () => {
    const f = fixture(); await ready(f); let release!: () => void;
    const pending = f.capture.stream({ onMessage: () => new Promise<void>(r => { release = r; }), onSample() {}, shouldStop: () => false });
    const socket = f.sockets[0]!.socket; socket.emit('open'); socket.message('PONG'); socket.message('one'); await flush(); socket.message('two');
    expect(f.capture.observationFrontier()).toEqual({ sequence: 2, open: true });
    f.capture.stop(); expect(f.capture.observationFrontier().open).toBe(false); await pending; release(); await f.capture.settleCallbacks();
    expect(f.capture.ledger().wsMessages).toBe(3);
  });

  it('joins an in-flight callback even when the clock provider fails during shutdown', async () => {
    const f = fixture(); await ready(f); let release!: () => void; let calls = 0;
    const pending = f.capture.stream({ onMessage: async () => { calls++; await new Promise<void>(r => { release = r; }); },
      onSample() {}, shouldStop: () => false }); const check = expect(pending).rejects.toThrow();
    const socket = f.sockets[0]!.socket; socket.emit('open'); socket.message('one'); await flush(); socket.message('two');
    f.h.clockThrows = true; f.capture.stop(); await check;
    let done = false; const joined = f.capture.settleCallbacks().then(() => { done = true; }); await flush(); expect(done).toBe(false);
    release(); await joined; expect(calls).toBe(1);
    expect(f.capture.ledger().callbackSettlement).toMatchObject({ startedAt: null, completedAt: null });
  });

  it('retains fractional-early sample guards and actual cadence without extending slot expiry', async () => {
    const f = fixture({ expiresUtcMs: EPOCH + 2001 }); await ready(f); const samples: number[] = [];
    const pending = f.capture.stream({ onMessage() {}, onSample(at) { samples.push(at.mono); }, shouldStop: () => false });
    f.sockets[0]!.socket.emit('open'); await vi.advanceTimersByTimeAsync(1000); f.h.monoSkew = -.25;
    await vi.advanceTimersByTimeAsync(1001); await expect(pending).resolves.toMatchObject({ reason: 'slot_deadline' });
    await f.capture.settleCallbacks(); expect(samples).toEqual([1000]); expect(f.capture.ledger().index.closed).toBe(true);
  });

  it('records an ordinary sample every actual second during a healthy attempt', async () => {
    const f = fixture(); await ready(f); const samples: number[] = [];
    const pending = f.capture.stream({ onMessage() {}, onSample(at) { samples.push(at.mono); }, shouldStop: () => samples.length === 3 });
    f.sockets[0]!.socket.emit('open'); await vi.advanceTimersByTimeAsync(3000); await pending; await f.capture.settleCallbacks();
    expect(samples).toEqual([1000, 2000, 3000]); expect(f.sockets[0]!.options).toMatchObject({
      allowSynchronousEvents: false, perMessageDeflate: false, followRedirects: false, maxPayload: 2097152 });
  });

  it('marks operator stop immediately during a bounded HTTP read, then joins its completion', async () => {
    const f = fixture({}, [{ stalled: true }]);
    const read = f.capture.readMetadata(); const check = expect(read).rejects.toThrow(); await flush(); f.capture.stop();
    expect(f.capture.ledger()).toMatchObject({ status: 'STOPPED', termination: { httpPending: true } });
    await expect(f.capture.readMarket()).rejects.toThrow('closed');
    const join = f.capture.settleCallbacks(); await vi.advanceTimersByTimeAsync(10_000); await check; await join;
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.destroyed).toBe(true); expect(f.sockets).toHaveLength(0);
  });

  it.each(['binary', 'utf8', 'oversized', 'disconnect', 'clock'])('retains fault %s and closes without reconnect', async kind => {
    const f = fixture(); await ready(f); const onMessage = vi.fn();
    const pending = f.capture.stream({ onMessage, onSample() {}, shouldStop: () => false }); const check = expect(pending).rejects.toThrow();
    const socket = f.sockets[0]!.socket; socket.emit('open');
    if (kind === 'binary') socket.message('PONG', true);
    if (kind === 'utf8') socket.message(Buffer.from([255]));
    if (kind === 'oversized') socket.message(Buffer.alloc(2097153, 65));
    if (kind === 'disconnect') socket.emit('close');
    if (kind === 'clock') { f.h.skew = 101; socket.message('{}'); }
    await check; await f.capture.settleCallbacks(); expect(onMessage).not.toHaveBeenCalled();
    expect(f.capture.observationFrontier().open).toBe(false); expect(f.sockets).toHaveLength(1);
    expect(f.capture.ledger().status).toBe('FAILED');
  });

  it('enforces the configurable disk reserve before opening a replacement segment', async () => {
    const f = fixture({ segmentMessages: 1, freeDiskReserveBytes: 1024 }); await ready(f);
    const pending = f.capture.stream({ onMessage() {}, onSample() {}, shouldStop: () => false }); const check = expect(pending).rejects.toThrow('disk_reserve');
    const socket = f.sockets[0]!.socket; socket.emit('open'); socket.message('one'); await flush(); f.h.disk = 0n; socket.message('two');
    await check; await f.capture.settleCallbacks(); expect(f.capture.ledger().status).toBe('FAILED');
    expect(f.capture.ledger().index.closed).toBe(true); expect(f.sockets).toHaveLength(1);
  });

  it.each(['index', 'record', 'truncated', 'missing'])('streaming verification rejects %s archive mutation', async kind => {
    const f = fixture({ segmentMessages: 1 }); await ready(f); let n = 0;
    const pending = f.capture.stream({ onMessage() { n++; }, onSample() {}, shouldStop: () => n === 2 });
    const socket = f.sockets[0]!.socket; socket.emit('open'); socket.message('one'); socket.message('two'); await pending;
    const file = path.join(f.outputDir, kind === 'index' ? 'segments.ndjson' : 'frames-000001.ndjson');
    if (kind === 'missing') rmSync(file);
    else { const b = readFileSync(file); chmodSync(file, 0o600);
      writeFileSync(file, kind === 'truncated' ? b.subarray(0, -1) : Buffer.from(b.toString().replace('sha256', 'changed'))); }
    await expect(verifyOperatingCaptureArchive(f.outputDir, f.capture.ledger())).rejects.toThrow();
  });

  it.each(['missing', 'modified'])('verifies actual HTTP raw files even without WS: %s metadata', async kind => {
    const f = fixture(); await ready(f); f.capture.stop(); await f.capture.settleCallbacks();
    expect((await verifyOperatingCaptureArchive(f.outputDir, f.capture.ledger())).messages).toBe(0);
    const file = path.join(f.outputDir, 'http', 'metadata.bin');
    if (kind === 'missing') rmSync(file); else writeFileSync(file, 'tampered');
    await expect(verifyOperatingCaptureArchive(f.outputDir, f.capture.ledger())).rejects.toThrow();
  });

  it('retains and verifies a failed partial HTTP prefix without calling it complete source evidence', async () => {
    const f = fixture({}, [{ body: '{"partial":', stalled: true }]);
    const pending = f.capture.readMetadata(); const check = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000); await check; await f.capture.settleCallbacks();
    expect(f.capture.ledger().status).toBe('FAILED'); expect(f.capture.ledger().http.reads[0].status).toBe('FAILED');
    expect(readFileSync(path.join(f.outputDir, 'http', 'metadata.bin'), 'utf8')).toBe('{"partial":');
    expect((await verifyOperatingCaptureArchive(f.outputDir, f.capture.ledger())).messages).toBe(0);
    expect(f.sockets).toHaveLength(0);
  });

  it('closes the archive index after a failed segment write and rejects unrecorded semantic delivery', async () => {
    const f = fixture(); await ready(f); const onMessage = vi.fn();
    const pending = f.capture.stream({ onMessage, onSample() {}, shouldStop: () => false }); const check = expect(pending).rejects.toThrow();
    const socket = f.sockets[0]!.socket; socket.emit('open'); socket.message('one'); await flush();
    closeSync((f.capture as unknown as { segmentFd: number }).segmentFd); socket.message('two'); await check;
    await f.capture.settleCallbacks(); expect(onMessage).toHaveBeenCalledTimes(1);
    expect(f.capture.ledger().index.closed).toBe(true); expect(f.capture.ledger().archiveError).toBeDefined();
  });

  it('rejects late first-slot metadata and invalid market version without alternate requests', async () => {
    expect(() => fixture({ metadataUrl: currentSlotMetadataUrl(EPOCH + 300000) })).toThrow('current_slot_policy');
    const f = fixture(); await f.capture.readMetadata();
    expect(() => f.capture.bindMarket({ ...MARKET, protocolVersion: 'v3' as 'v1' })).toThrow();
    await expect(f.capture.readMarket()).rejects.toThrow('closed'); expect(f.calls).toHaveLength(1);
  });

  it('samples through a real loopback burst while rotating its archive and retaining every delivered frame', async () => {
    const f = fixture(); vi.useRealTimers();
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error('local_address');
    const N = 6000; let sent = 0, seen = 0; const samples: number[] = [];
    server.on('connection', ws => ws.once('message', () => {
      for (let n = 0; n < N; n++) { ws.send(JSON.stringify({ n, payload: 'x'.repeat(200) })); sent++; }
    }));
    const monoOrigin = performance.now();
    // Explicit synthetic UTC plus a real elapsed monotonic clock: local transport
    // engineering only, never a public-market timestamp or observation.
    const clock = () => { const mono = performance.now(); return { utc: EPOCH + Math.floor(mono - monoOrigin), mono }; };
    const dir = path.join(path.dirname(f.outputDir), 'loopback');
    const capture = new OperatingSourceCapture({ metadataUrl: currentSlotMetadataUrl(EPOCH), expiresUtcMs: EPOCH + 6000,
      segmentMessages: 500, freeDiskReserveBytes: 0 }, clock, dir, { request: f.h.request,
      socket: (_url, options) => { expect(options.allowSynchronousEvents).toBe(false);
        return new WebSocket(`ws://127.0.0.1:${address.port}`, options as unknown as ClientOptions); } });
    try {
      await capture.readMetadata(); capture.bindMarket(MARKET); await capture.readMarket(); await capture.readBook(); await capture.readFee();
      const result = await capture.stream({ onMessage(c) {
        expect(JSON.parse(c.raw).n).toBe(seen++);
        const until = performance.now() + .25; while (performance.now() < until) { /* finite ordinary local work */ }
      }, onSample() { samples.push(seen); }, shouldStop: () => samples.length > 0 });
      await capture.settleCallbacks(); const ledger = capture.ledger();
      expect(result.reason).toBe('caller_stop'); expect(sent).toBe(N);
      expect(samples[0]).toBeGreaterThan(500); expect(samples[0]).toBeLessThan(N);
      expect(ledger.index.segments).toBeGreaterThan(1); expect(ledger.wsMessages).toBe(seen);
      expect(ledger.peakQueuedMessages).toBeLessThanOrEqual(4000);
      expect(ledger.peakQueuedBytes).toBeLessThanOrEqual(8388608);
      expect(await verifyOperatingCaptureArchive(dir, ledger)).toMatchObject({ messages: seen });
      expect(capture.observationFrontier()).toEqual({ sequence: seen, open: false });
    } finally { for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 10_000);
});
