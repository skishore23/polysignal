import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import type WebSocket from 'ws';
import { STARTUP_METADATA_URL, currentSlotMetadataUrl, StartupSourceCapture,
  type StartupCapturePolicy, type CaptureMarket, type CaptureSocketOptions } from '../../scripts/research/maker_startup_capture';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EPOCH = 1_800_000_000_000;
const CONDITION = `0x${'a'.repeat(64)}`;
const MARKET: CaptureMarket = { condition: CONDITION, token: '123', protocolVersion: 'v1' };
const parents: string[] = [];
const policy = (extra: Partial<StartupCapturePolicy> = {}): StartupCapturePolicy => ({
  expiresUtcMs: EPOCH + 300_000, metadataUrl: STARTUP_METADATA_URL,
  maxReads: 4, perReadBodyBytes: 2_097_152, maxBodyBytes: 8_388_608,
  maxMessages: 1000, maxWallMs: 300_000, ...extra,
});
type ResponseSpec = { body?: Buffer | string; status?: number; encoding?: string;
  contentType?: string; stall?: boolean; noResponse?: boolean; error?: Error };
class FakeSocket extends EventEmitter {
  sent: string[] = [];
  pongs: Buffer[] = [];
  terminated = false;
  send(raw: string, _options: unknown, callback: (e?: Error) => void) { this.sent.push(raw); callback(); }
  pong(raw: Buffer) { this.pongs.push(raw); }
  terminate() { this.terminated = true; this.emit('close'); }
  message(raw: string | Buffer, binary = false) { this.emit('message', Buffer.from(raw), binary); }
}
function harness(extra: Partial<StartupCapturePolicy> = {}, specs: ResponseSpec[] = []) {
  const parent = mkdtempSync(path.join(ROOT, 'reports/evidence/capture-offline-test-'));
  parents.push(parent);
  const outputDir = path.join(parent, 'capture');
  const calls: { url: string; options: RequestOptions; destroyed: boolean }[] = [];
  const sockets: { url: string; options: CaptureSocketOptions; socket: FakeSocket }[] = [];
  const h = {
    skew: 0, clockThrows: false, outputDir, calls, sockets,
    clock: () => {
      if (h.clockThrows) throw Error('clock_unavailable');
      return { utc: Date.now() + h.skew, mono: Date.now() - EPOCH };
    },
    request: (url: string, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
      const spec = specs[calls.length] ?? {};
      const call = { url, options, destroyed: false }; calls.push(call);
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.destroy = () => { call.destroyed = true; };
      req.end = () => { queueMicrotask(() => {
        if (spec.error) { req.emit('error', spec.error); return; }
        if (spec.noResponse) return;
        const res = new Readable({ read() {} }) as Readable & {
          statusCode: number; headers: Record<string, string>; rawHeaders: string[]; complete: boolean;
        };
        res.statusCode = spec.status ?? 200;
        res.headers = { 'content-type': spec.contentType ?? 'application/json',
          'content-encoding': spec.encoding ?? 'identity' };
        res.rawHeaders = Object.entries(res.headers).flat(); res.complete = false;
        callback(res as unknown as IncomingMessage);
        if (res.destroyed) return;
        if (spec.body !== undefined) res.push(Buffer.from(spec.body));
        else res.push(Buffer.from('{}'));
        if (!spec.stall) { res.complete = true; res.push(null); }
      }); };
      return req as unknown as ClientRequest;
    },
    socket: (url: string, options: CaptureSocketOptions) => {
      const socket = new FakeSocket(); sockets.push({ url, options, socket });
      return socket as unknown as WebSocket;
    },
  };
  const capture = new StartupSourceCapture(policy(extra), h.clock, outputDir,
    { request: h.request, socket: h.socket });
  return { ...h, capture, control: h };
}
async function ready(h: ReturnType<typeof harness>, market = MARKET) {
  await h.capture.readMetadata(); h.capture.bindMarket(market);
  await h.capture.readMarket(); await h.capture.readBook(); await h.capture.readFee();
}
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(EPOCH);
});
afterEach(() => {
  vi.useRealTimers(); for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});

describe('finite startup capture: offline injected transports only', () => {
  it('reads exactly the frozen current-slot slug URL and retains the object response', async () => {
    const metadataUrl = currentSlotMetadataUrl(EPOCH);
    const h = harness({ metadataUrl }, [{ body: '{"slug":"btc-updown-5m-1800000000"}' }]);
    const result = await h.capture.readMetadata();
    expect(metadataUrl).toBe('https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-1800000000');
    expect(result.url).toBe(metadataUrl); expect(JSON.parse(result.raw).slug).toBe('btc-updown-5m-1800000000');
    expect(h.calls.map((x) => x.url)).toEqual([metadataUrl]);
    expect(h.capture.ledger().policy.metadataUrl).toBe(metadataUrl);
    await expect(h.capture.readMetadata()).rejects.toThrow('read_duplicate_or_concurrent');
    expect(h.calls).toHaveLength(1);
  });

  it.each([0, 240_000])('admits the exact inclusive slot boundary with at least 60s remaining (%i)', async (elapsed) => {
    const h = harness({ metadataUrl: currentSlotMetadataUrl(EPOCH) });
    await vi.advanceTimersByTimeAsync(elapsed); await h.capture.readMetadata(); expect(h.calls).toHaveLength(1);
  });

  it('rejects a future slot before any request without selecting a substitute slot', async () => {
    const h = harness({ metadataUrl: currentSlotMetadataUrl(EPOCH + 300_000) });
    await expect(h.capture.readMetadata()).rejects.toThrow('metadata_slot_not_current_or_less_than_60s');
    expect(h.calls).toHaveLength(0); expect(h.capture.ledger().status).toBe('FAILED');
  });

  it.each([240_001, 299_999])('rejects a slot with less than 60s remaining (%i), without a list fallback', async (elapsed) => {
    const h = harness({ metadataUrl: currentSlotMetadataUrl(EPOCH) });
    await vi.advanceTimersByTimeAsync(elapsed);
    await expect(h.capture.readMetadata()).rejects.toThrow('metadata_slot_not_current_or_less_than_60s');
    expect(h.calls).toHaveLength(0); expect(h.capture.ledger().policy.metadataUrl).toBe(currentSlotMetadataUrl(EPOCH));
  });

  it('rejects a current-slot recipe whose authority outlives that slot', () => {
    vi.setSystemTime(EPOCH + 1000);
    expect(() => harness({ metadataUrl: currentSlotMetadataUrl(EPOCH), expiresUtcMs: EPOCH + 300_001 }))
      .toThrow('invalid_policy_or_clock');
  });

  it.each([
    'https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-1800000001',
    'https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-1800000000?limit=1',
    'https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-1800000000#x',
    'https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-1800000000\n',
    'https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-01800000000',
    'https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-0100000200',
    'https://gamma-api.polymarket.com:443/markets/slug/btc-updown-5m-1800000000',
    'http://gamma-api.polymarket.com/markets/slug/btc-updown-5m-1800000000',
    'https://gamma-api.polymarket.com/markets/slug/eth-updown-5m-1800000000',
    'https://elsewhere.invalid/markets/slug/btc-updown-5m-1800000000',
  ])('rejects noncanonical or alternative metadata recipe %s', (metadataUrl) => {
    expect(() => harness({ metadataUrl })).toThrow('invalid_policy_or_clock');
  });

  it.each([EPOCH + 1, EPOCH + 1000, Number.NaN, Number.MAX_SAFE_INTEGER, 0])
  ('pure slot URL helper rejects noncanonical starts (%s)', (start) => {
    expect(() => currentSlotMetadataUrl(start)).toThrow('invalid_slot_start');
  });

  it.each(['v1', 'v2'] as const)('pins the four requests, %s route, body hashes and immutable market', async (protocolVersion) => {
    const h = harness({}, [{ body: '{"source":"metadata"}' }]);
    const metadata = await h.capture.readMetadata();
    expect(metadata).toMatchObject({ url: STARTUP_METADATA_URL, raw: '{"source":"metadata"}', status: 200,
      startedAt: { utc: EPOCH, mono: 0 }, at: { utc: EPOCH, mono: 0 } });
    expect(metadata.sha256).toBe(createHash('sha256').update(metadata.raw).digest('hex'));
    const market = { ...MARKET, protocolVersion }; h.capture.bindMarket(market); market.token = '999';
    await h.capture.readMarket(); await h.capture.readBook(); await h.capture.readFee();
    expect(h.calls.map((x) => x.url)).toEqual([STARTUP_METADATA_URL,
      `https://clob.polymarket.com/${protocolVersion === 'v1' ? 'markets' : 'clob-markets'}/${CONDITION}`,
      'https://clob.polymarket.com/book?token_id=123', 'https://clob.polymarket.com/fee-rate?token_id=123']);
    for (const { options } of h.calls) expect(options).toEqual({ method: 'GET', agent: false,
      maxHeaderSize: 16_384, headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', Connection: 'close' } });
    const ledger = h.capture.ledger(); ledger.bodyBytes = 0;
    expect(h.capture.ledger()).toMatchObject({ readsClaimed: 4, bodyBytes: Buffer.byteLength(metadata.raw) + 6,
      market: { ...MARKET, protocolVersion }, httpFramingBytes: null, tlsWireBytes: null, actualAccountChargesUSD: null });
    expect(readFileSync(path.join(h.outputDir, 'metadata.bin'), 'utf8')).toBe(metadata.raw);
  });

  it.each([
    { ...MARKET, protocolVersion: 'v3' }, { ...MARKET, protocolVersion: undefined },
    { ...MARKET, token: 123 }, { ...MARKET, token: '-1' },
    { ...MARKET, token: String(1n << 256n) }, { ...MARKET, condition: '../../x' },
  ])('rejects invalid market/version without a CLOB request: %j', async (value) => {
    const h = harness(); await h.capture.readMetadata();
    expect(() => h.capture.bindMarket(value as CaptureMarket)).toThrow('invalid_or_repeated_market_binding');
    expect(h.calls).toHaveLength(1); expect(h.capture.ledger().status).toBe('FAILED');
  });

  it('rejects duplicate reads and a second market binding without a retry', async () => {
    const h = harness(); await h.capture.readMetadata();
    await expect(h.capture.readMetadata()).rejects.toThrow('read_duplicate_or_concurrent');
    expect(h.calls).toHaveLength(1);
    const h2 = harness(); await h2.capture.readMetadata(); h2.capture.bindMarket(MARKET);
    expect(() => h2.capture.bindMarket(MARKET)).toThrow('invalid_or_repeated_market_binding');
    expect(h2.calls).toHaveLength(1);
  });

  it('rejects concurrent requests and incomplete recipes before opening a socket', async () => {
    const h = harness({}, [{ noResponse: true }]);
    const first = h.capture.readMetadata(); const rejected = expect(first).rejects.toThrow();
    await expect(h.capture.readMetadata()).rejects.toThrow('read_duplicate_or_concurrent');
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(h.calls).toHaveLength(1); expect(h.calls[0]!.destroyed).toBe(true);
    const h2 = harness({ expiresUtcMs: Date.now() + 100_000 });
    await h2.capture.readMetadata(); h2.capture.bindMarket(MARKET);
    await expect(h2.capture.stream({ onMessage() {}, onSample() {}, shouldStop: () => false }))
      .rejects.toThrow('four_reads_required'); expect(h2.sockets).toHaveLength(0);
  });

  it.each([
    { status: 302 }, { status: 500 }, { encoding: 'gzip' }, { contentType: 'text/html' },
    { body: Buffer.from([0xff]) }, { error: Error('transport_uncertain') },
  ])('records terminal read failure, no alternative source: %j', async (spec) => {
    const h = harness({}, [spec]); await expect(h.capture.readMetadata()).rejects.toThrow();
    expect(h.calls).toHaveLength(1); expect(h.calls[0]!.destroyed).toBe(true);
    expect(h.capture.ledger()).toMatchObject({ status: 'FAILED', readsClaimed: 1 });
    expect(existsSync(path.join(h.outputDir, 'metadata.bin'))).toBe(true);
    await expect(h.capture.readMetadata()).rejects.toThrow('capture_already_closed');
    expect(h.calls).toHaveLength(1);
  });

  it('fails at the exact 2MiB body limit with the bounded raw prefix retained', async () => {
    const h = harness({}, [{ body: Buffer.alloc(2_097_153, 65) }]);
    await expect(h.capture.readMetadata()).rejects.toThrow('application_body_limit');
    expect(readFileSync(path.join(h.outputDir, 'metadata.bin'))).toHaveLength(2_097_152);
    expect(h.capture.ledger()).toMatchObject({ bodyBytes: 2_097_152, status: 'FAILED' });
  });

  it('hard-aborts a stalled response at 10s, retaining small partial bytes', async () => {
    const h = harness({}, [{ body: '{"partial":', stall: true }]);
    const request = h.capture.readMetadata(); const check = expect(request).rejects.toThrow('https_absolute_deadline');
    await vi.advanceTimersByTimeAsync(9_999); expect(h.calls[0]!.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await check;
    expect(h.calls[0]!.destroyed).toBe(true);
    expect(readFileSync(path.join(h.outputDir, 'metadata.bin'), 'utf8')).toBe('{"partial":');
  });

  it.each([101, -1])('stops on skew/backwards time before another source request (%i)', async (skew) => {
    const h = harness(); await h.capture.readMetadata(); h.control.skew = skew;
    expect(() => h.capture.bindMarket(MARKET)).toThrow('clock_disagreement_or_backwards');
    expect(h.calls).toHaveLength(1);
  });

  it('journals a failed clock and blocks transport rather than treating time as zero', async () => {
    const h = harness(); h.control.clockThrows = true;
    await expect(h.capture.readMetadata()).rejects.toThrow('clock_error');
    expect(h.capture.ledger().status).toBe('FAILED'); expect(h.calls).toHaveLength(0);
  });

  it('fails an expired original authority before attempting any request', async () => {
    const h = harness({ expiresUtcMs: EPOCH + 1000, maxWallMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(h.capture.readMetadata()).rejects.toThrow('shared_deadline'); expect(h.calls).toHaveLength(0);
  });

  it('rejects unapproved URL, unsafe or nonexclusive output directories before networking', () => {
    const h = harness();
    const inject = { request: h.request, socket: h.socket };
    expect(() => new StartupSourceCapture(policy({ metadataUrl: 'https://elsewhere.invalid/' }), h.clock,
      path.join(h.outputDir, 'nested'), inject)).toThrow('invalid_policy');
    expect(() => new StartupSourceCapture(policy(), h.clock, '/tmp/capture-test', inject)).toThrow('isolated_evidence_path');
    expect(() => new StartupSourceCapture(policy(), h.clock, h.outputDir, inject)).toThrow();
    const alias = path.join(path.dirname(h.outputDir), 'alias'); symlinkSync(h.outputDir, alias);
    expect(() => new StartupSourceCapture(policy(), h.clock, path.join(alias, 'new'), inject)).toThrow('symlink_evidence_path');
    expect(h.calls).toHaveLength(0);
  });

  it('sends one subscription, bounded PING, and serializes messages and samples; PONG is control only', async () => {
    const h = harness(); await ready(h);
    const events: string[] = []; let stop = false; let release!: () => void;
    const pending = h.capture.stream({ onMessage: async (capture) => {
      events.push(capture.raw); if (capture.raw === 'first') await new Promise<void>((r) => { release = r; });
    }, onSample(at) { events.push(`sample:${at.mono}`); }, shouldStop: () => stop });
    const socket = h.sockets[0]!.socket; socket.emit('open');
    socket.message('PONG'); socket.emit('ping', Buffer.from([0xff])); socket.emit('pong', Buffer.from([0xff]));
    socket.message('first'); await flush(); socket.message('second');
    await vi.advanceTimersByTimeAsync(1000); expect(events).toEqual(['first']);
    release(); await flush(); expect(events).toEqual(['first', 'second', 'sample:1000']);
    await vi.advanceTimersByTimeAsync(9000); expect(socket.sent).toEqual([
      JSON.stringify({ type: 'market', assets_ids: ['123'] }), 'PING']);
    expect(socket.pongs).toEqual([Buffer.from([0xff])]);
    expect(h.sockets[0]).toMatchObject({ url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
      options: { perMessageDeflate: false, maxPayload: 2_097_152, followRedirects: false,
        handshakeTimeout: 10_000, agent: false, autoPong: false, maxHeaderSize: 16_384 } });
    stop = true; socket.message('last'); await expect(pending).resolves.toMatchObject({ reason: 'caller_stop', callbacksPending: false });
    expect(socket.terminated).toBe(true); expect(h.sockets).toHaveLength(1);
    expect(events).not.toContain('PONG');
  });

  it('stops intake at the finite message count and drains only the accepted callback', async () => {
    const h = harness({ maxMessages: 1 }); await ready(h); const messages: string[] = [];
    const pending = h.capture.stream({ onMessage: (c) => { messages.push(c.raw); }, onSample() {}, shouldStop: () => false });
    const socket = h.sockets[0]!.socket; socket.emit('open'); socket.message('one'); socket.message('two');
    await expect(pending).resolves.toMatchObject({ reason: 'message_limit', callbacksPending: false });
    expect(messages).toEqual(['one']); expect(h.capture.ledger().messages).toBe(1);
    expect(existsSync(path.join(h.outputDir, 'frame-2.bin'))).toBe(false);
  });

  it.each(['binary', 'invalid_utf8', 'disconnect', 'error', 'upgrade', 'callback', 'duplicate_open'])
  ('fails closed on %s, retaining available raw receipt without reconnecting', async (mode) => {
    const h = harness(); await ready(h);
    const pending = h.capture.stream({ onMessage() { if (mode === 'callback') throw Error('bridge_rejected'); },
      onSample() {}, shouldStop: () => false }); const check = expect(pending).rejects.toThrow();
    const socket = h.sockets[0]!.socket; socket.emit('open');
    if (mode === 'binary') socket.message('binary', true);
    if (mode === 'invalid_utf8') socket.message(Buffer.from([0xff]));
    if (mode === 'disconnect') socket.emit('close');
    if (mode === 'error') socket.emit('error', Error('uncertain'));
    if (mode === 'upgrade') socket.emit('unexpected-response', {}, { destroy() {} });
    if (mode === 'callback') socket.message('{}');
    if (mode === 'duplicate_open') socket.emit('open');
    await check; expect(socket.terminated).toBe(true); expect(h.sockets).toHaveLength(1);
    expect(h.capture.ledger().status).toBe('FAILED');
    if (['binary', 'invalid_utf8', 'callback'].includes(mode)) expect(existsSync(path.join(h.outputDir, 'frame-1.bin'))).toBe(true);
  });

  it('does not renew the original shared deadline after read preparation', async () => {
    const h = harness({ expiresUtcMs: EPOCH + 20_000, maxWallMs: 20_000 }); await ready(h);
    await vi.advanceTimersByTimeAsync(15_000);
    const pending = h.capture.stream({ onMessage() {}, onSample() {}, shouldStop: () => false });
    h.sockets[0]!.socket.emit('open');
    await vi.advanceTimersByTimeAsync(5000); await expect(pending).resolves.toMatchObject({ reason: 'shared_deadline', callbacksPending: false });
    expect(Date.now()).toBe(EPOCH + 20_000);
  });

  it('records a pending callback honestly at deadline and never starts its queued successor', async () => {
    const h = harness({ expiresUtcMs: EPOCH + 2000, maxWallMs: 2000 }); await ready(h);
    const messages: string[] = []; let release!: () => void;
    const pending = h.capture.stream({ onMessage: async (c) => { messages.push(c.raw); await new Promise<void>((r) => { release = r; }); },
      onSample() {}, shouldStop: () => false }); const check = expect(pending).rejects.toThrow('callback_pending_at_shared_deadline');
    const socket = h.sockets[0]!.socket; socket.emit('open'); socket.message('first'); socket.message('second');
    await flush(); await vi.advanceTimersByTimeAsync(2000); await check;
    expect(h.capture.ledger().termination.callbacksPending).toBe(true);
    expect(h.capture.observationFrontier()).toEqual({ sequence: 2, open: false });
    let settled = false;
    const settlement = h.capture.settleCallbacks().then(() => { settled = true; });
    await flush(); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    release(); await settlement; expect(messages).toEqual(['first']);
    expect(h.capture.ledger().callbackSettlement).toMatchObject({ elapsedMonoMs: 500, sourceWindowExtended: false });
    expect(h.capture.ledger().termination.at.utc).toBe(EPOCH + 2000);
    expect(h.calls).toHaveLength(4); expect(h.sockets).toHaveLength(1);
  });

  it('advances the live frontier on arrival before serialized delivery; close invalidates immediately', async () => {
    const h = harness(); await ready(h); const messages: string[] = []; let release!: () => void;
    const pending = h.capture.stream({ onMessage: async (c) => {
      messages.push(c.raw); await new Promise<void>((r) => { release = r; });
    }, onSample() {}, shouldStop: () => false });
    const check = expect(pending).rejects.toThrow('websocket_disconnect');
    const socket = h.sockets[0]!.socket;
    expect(h.capture.observationFrontier()).toEqual({ sequence: 0, open: false });
    socket.emit('open'); expect(h.capture.observationFrontier()).toEqual({ sequence: 0, open: true });
    socket.message('PONG'); socket.emit('ping', Buffer.from('control')); socket.emit('pong', Buffer.from('control'));
    expect(h.capture.observationFrontier()).toEqual({ sequence: 0, open: true });
    socket.message('first'); await flush(); expect(messages).toEqual(['first']);
    socket.message('second');
    expect(h.capture.observationFrontier()).toEqual({ sequence: 2, open: true });
    expect(messages).toEqual(['first']);
    socket.emit('close'); expect(h.capture.observationFrontier()).toEqual({ sequence: 2, open: false });
    await check; release(); await h.capture.settleCallbacks(); expect(messages).toEqual(['first']);
    const detached = h.capture.observationFrontier(); detached.open = true;
    expect(h.capture.observationFrontier().open).toBe(false);
  });

  it.each(['binary', 'invalid_utf8'])('invalid %s arrival advances and closes the frontier before delivery', async (mode) => {
    const h = harness(); await ready(h); const onMessage = vi.fn();
    const pending = h.capture.stream({ onMessage, onSample() {}, shouldStop: () => false });
    const check = expect(pending).rejects.toThrow(); const socket = h.sockets[0]!.socket; socket.emit('open');
    socket.message(mode === 'binary' ? 'PONG' : Buffer.from([0xff]), mode === 'binary');
    expect(h.capture.observationFrontier()).toEqual({ sequence: 1, open: false });
    await check; await h.capture.settleCallbacks(); expect(onMessage).not.toHaveBeenCalled();
  });

  it('retains and rejects the frame crossing shared body admission, reporting actual delivered bytes', async () => {
    const h = harness({}, Array.from({ length: 4 }, () => ({ body: Buffer.alloc(2_000_000, 32) })));
    await ready(h); const received: string[] = [];
    const pending = h.capture.stream({ onMessage: (c) => { received.push(c.raw); }, onSample() {}, shouldStop: () => false });
    const check = expect(pending).rejects.toThrow('stream_application_limit');
    const socket = h.sockets[0]!.socket; socket.emit('open'); socket.message(Buffer.alloc(400_000, 32)); await check;
    expect(received).toEqual([]); expect(h.capture.ledger().bodyBytes).toBe(8_400_000);
    expect(readFileSync(path.join(h.outputDir, 'frame-1.bin'))).toHaveLength(400_000);
    expect(h.capture.ledger().tlsWireBytes).toBeNull();
  });

  it('rejects an oversized injected frame with a bounded prefix and no bridge callback', async () => {
    const h = harness(); await ready(h); const onMessage = vi.fn();
    const pending = h.capture.stream({ onMessage, onSample() {}, shouldStop: () => false });
    const check = expect(pending).rejects.toThrow('stream_application_limit');
    h.sockets[0]!.socket.emit('open'); h.sockets[0]!.socket.message(Buffer.alloc(2_097_153, 65)); await check;
    expect(onMessage).not.toHaveBeenCalled();
    expect(readFileSync(path.join(h.outputDir, 'frame-1.bin'))).toHaveLength(2_097_152);
    expect(h.capture.ledger().controls[0]).toMatchObject({ bytes: 2_097_153, retainedBytes: 2_097_152, complete: false });
  });

  it('stops a socket on clock disagreement and preserves terminal accounting', async () => {
    const h = harness(); await ready(h); const onMessage = vi.fn();
    const pending = h.capture.stream({ onMessage, onSample() {}, shouldStop: () => false });
    const check = expect(pending).rejects.toThrow('clock_disagreement_or_backwards');
    const socket = h.sockets[0]!.socket; socket.emit('open'); h.control.skew = 101;
    socket.message('{}'); await check; expect(onMessage).not.toHaveBeenCalled();
    expect(socket.terminated).toBe(true); expect(h.capture.ledger().status).toBe('FAILED');
  });

  it('does not open a socket for an already satisfied caller stop', async () => {
    const h = harness(); await ready(h);
    await expect(h.capture.stream({ onMessage() {}, onSample() {}, shouldStop: () => true }))
      .resolves.toMatchObject({ reason: 'caller_stop', callbacksPending: false }); expect(h.sockets).toHaveLength(0);
  });
});
