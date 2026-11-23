/** Finite public capture transport only. This module does not grant source/run permission. */
import https, { type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { type ClientOptions, type RawData } from 'ws';

export type CaptureClock = { utc: number; mono: number };
export type StartupCapturePolicy = {
  expiresUtcMs: number;
  metadataUrl: string;
  maxReads: number;
  perReadBodyBytes: number;
  maxBodyBytes: number;
  maxMessages: number;
  maxWallMs: number;
};
export type RawCapture = {
  url: string; raw: string; at: CaptureClock; startedAt: CaptureClock;
  status: number | null; sha256: string;
};
// ws forwards these to https.request; @types/ws omits Node's supported agent:false
// and maxHeaderSize options. Keep the required values explicit at our boundary.
export type CaptureSocketOptions = Omit<ClientOptions, 'agent'> & { agent: false; maxHeaderSize: number };
export type CaptureTransports = {
  request: (url: string, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
  socket: (url: string, options: CaptureSocketOptions) => WebSocket;
};
export type CaptureMarket = { condition: string; token: string; protocolVersion: 'v1' | 'v2' };
export const STARTUP_METADATA_URL = 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=endDate&ascending=true';
const SOCKET_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const decode = (raw: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(raw);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export class StartupSourceCapture {
  private readonly policy: Readonly<StartupCapturePolicy>;
  private readonly clock: () => CaptureClock;
  private readonly transports: CaptureTransports;
  private readonly outputDir: string;
  private readonly origin: CaptureClock;
  private last: CaptureClock;
  private market: Readonly<CaptureMarket> | null = null;
  private activeRead = false;
  private streamed = false;
  private failed = false;
  private activeAbort: (() => void) | undefined;
  private activeStreamAbort: ((reason: string) => void) | undefined;
  private callbackQueue: Promise<void> = Promise.resolve();
  private frontier = { sequence: 0, open: false };
  private readonly attempted = new Set<string>();
  private readonly completed = new Set<string>();
  private state: Record<string, any>;

  constructor(policy: StartupCapturePolicy, clock: () => CaptureClock, outputDir: string,
    transports: Partial<CaptureTransports> = {}) {
    this.clock = clock;
    this.origin = copy(clock());
    this.last = copy(this.origin);
    if (!Number.isSafeInteger(this.origin.utc) || this.origin.utc < 0 || !Number.isFinite(this.origin.mono) || this.origin.mono < 0 ||
      policy.metadataUrl !== STARTUP_METADATA_URL || policy.maxReads !== 4 ||
      policy.perReadBodyBytes !== 2_097_152 || policy.maxBodyBytes !== 8_388_608 ||
      !Number.isSafeInteger(policy.maxMessages) || policy.maxMessages < 1 || policy.maxMessages > 1000 ||
      !Number.isSafeInteger(policy.maxWallMs) || policy.maxWallMs < 1 || policy.maxWallMs > 300_000 ||
      !Number.isSafeInteger(policy.expiresUtcMs) || policy.expiresUtcMs <= this.origin.utc ||
      policy.expiresUtcMs - this.origin.utc > policy.maxWallMs) throw Error('capture:invalid_policy_or_clock');
    this.policy = Object.freeze({ ...policy });
    this.transports = {
      request: (url, options, callback) => https.request(url, options, callback),
      socket: (url, options) => new WebSocket(url, options as unknown as ClientOptions),
      ...transports,
    };
    const allowed = path.join(ROOT, 'reports/evidence');
    this.outputDir = path.resolve(outputDir);
    if (!this.outputDir.startsWith(allowed + path.sep)) throw Error('capture:isolated_evidence_path');
    // Check every existing ancestor; never follow an alias into a user's database/service tree.
    for (let p = this.outputDir; ; p = path.dirname(p)) {
      if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw Error('capture:symlink_evidence_path');
      if (p === ROOT || p === path.dirname(p)) break;
    }
    mkdirSync(this.outputDir, { mode: 0o700 }); // Exclusive persistent claim, including failed attempts.
    this.state = {
      schema: 'PROSPECTIVE_FOUR_READ_BODY_CAPTURE_V1', policy: this.policy,
      startedAt: this.origin, status: 'PREPARED', readsClaimed: 0, bodyBytes: 0,
      messages: 0, reads: [], controls: [], failures: [],
      byteScope: 'inbound application bodies; no HTTP/TLS/framing measurement',
      httpFramingBytes: null, tlsWireBytes: null, actualAccountChargesUSD: null,
    };
    this.persist();
  }

  ledger() { return copy(this.state); }
  observationFrontier(): { sequence: number; open: boolean } { return { ...this.frontier }; }
  /** Cleanup join only: never extends the source window or restarts queued callbacks. */
  async settleCallbacks(): Promise<void> {
    const readClock = () => { try { return copy(this.clock()); } catch { return null; } };
    const startedAt = readClock();
    await this.callbackQueue;
    const completedAt = readClock();
    this.state.callbackSettlement = { startedAt, completedAt,
      elapsedMonoMs: startedAt && completedAt && completedAt.mono >= startedAt.mono
        ? completedAt.mono - startedAt.mono : null,
      sourceWindowExtended: false };
    this.persist();
  }
  private persist() { writeFileSync(path.join(this.outputDir, 'ledger.json'), JSON.stringify(this.state, null, 2) + '\n'); }
  private fail(reason: string): Error {
    this.failed = true;
    this.frontier.open = false;
    this.state.status = 'FAILED';
    this.state.failures.push(reason);
    this.persist();
    this.activeAbort?.();
    this.activeStreamAbort?.(reason);
    return Error(`capture:${reason}`);
  }
  private at(): CaptureClock {
    let at: CaptureClock;
    try { at = copy(this.clock()); }
    catch (e) { throw this.fail(`clock_error:${String(e)}`); }
    if (!Number.isSafeInteger(at.utc) || !Number.isFinite(at.mono) ||
      at.utc < this.last.utc || at.mono < this.last.mono ||
      Math.abs(at.utc - this.origin.utc - (at.mono - this.origin.mono)) > 100) throw this.fail('clock_disagreement_or_backwards');
    this.last = at;
    if (at.utc >= this.policy.expiresUtcMs || at.mono - this.origin.mono >= this.policy.maxWallMs) throw this.fail('shared_deadline');
    return at;
  }
  private available() { if (this.failed || this.streamed) throw this.fail('capture_already_closed'); }

  bindMarket(value: CaptureMarket) {
    this.available(); this.at();
    if (this.market || !this.completed.has('metadata') || this.activeRead ||
      typeof value.condition !== 'string' || typeof value.token !== 'string' ||
      (value.protocolVersion !== 'v1' && value.protocolVersion !== 'v2') ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.condition) || !/^[0-9]{1,78}$/.test(value.token) ||
      BigInt(value.token) > (1n << 256n) - 1n) throw this.fail('invalid_or_repeated_market_binding');
    this.market = Object.freeze({ condition: value.condition, token: value.token, protocolVersion: value.protocolVersion });
    this.state.market = this.market; this.persist();
  }
  readMetadata() { return this.read('metadata', STARTUP_METADATA_URL); }
  readMarket() { return this.boundRead('market', (m) => `https://clob.polymarket.com/${m.protocolVersion === 'v2' ? 'clob-markets' : 'markets'}/${m.condition}`); }
  readBook() { return this.boundRead('book', (m) => `https://clob.polymarket.com/book?token_id=${m.token}`); }
  readFee() { return this.boundRead('fee', (m) => `https://clob.polymarket.com/fee-rate?token_id=${m.token}`); }
  private boundRead(name: string, url: (m: CaptureMarket) => string) {
    if (!this.market) return Promise.reject(this.fail('market_not_bound'));
    return this.read(name, url(this.market));
  }

  private async read(name: string, url: string): Promise<RawCapture> {
    this.available(); const startedAt = this.at();
    if (this.activeRead || this.attempted.has(name) || this.state.readsClaimed >= this.policy.maxReads) throw this.fail('read_duplicate_or_concurrent');
    this.attempted.add(name); this.activeRead = true;
    const entry: Record<string, any> = { name, url, startedAt, status: 'CLAIMED', bodyBytes: 0 };
    this.state.reads.push(entry); this.state.readsClaimed++; this.persist();
    const file = path.join(this.outputDir, `${name}.bin`);
    let fd: number | undefined;
    const chunks: Buffer[] = [];
    const remainingMs = Math.min(10_000, this.policy.expiresUtcMs - startedAt.utc,
      this.policy.maxWallMs - (startedAt.mono - this.origin.mono));
    try {
      fd = openSync(file, 'wx', 0o600);
      const result = await new Promise<RawCapture>((resolve, reject) => {
        let request: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return; settled = true; clearTimeout(timer);
          if (error) {
            entry.status = 'FAILED'; entry.error = String(error);
            response?.destroy(); request?.destroy();
            reject(this.fail(String(error)));
          } else {
            try {
              const at = this.at(); const raw = Buffer.concat(chunks);
              const text = decode(raw);
              entry.status = 'COMPLETED'; entry.at = at; entry.sha256 = sha(raw);
              this.completed.add(name); this.persist();
              resolve({ url, raw: text, at, startedAt, status: entry.httpStatus, sha256: entry.sha256 });
            } catch (e) {
              entry.status = 'FAILED'; entry.error = String(e);
              response?.destroy(); request?.destroy(); reject(this.fail(String(e)));
            }
          }
        };
        this.activeAbort = () => finish('capture_terminal_failure');
        const timer = setTimeout(() => finish('https_absolute_deadline'), remainingMs);
        try {
          this.at();
          request = this.transports.request(url, {
            method: 'GET', agent: false, maxHeaderSize: 16_384,
            headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', Connection: 'close' },
          }, (res) => {
            response = res;
            if (settled) { res.destroy(); return; }
            entry.httpStatus = res.statusCode;
            entry.headers = res.rawHeaders;
            try {
              this.at();
              if (res.statusCode !== 200) throw Error('http_status_no_redirect_or_retry');
              if (String(res.headers['content-encoding'] ?? 'identity').trim().toLowerCase() !== 'identity') throw Error('compressed_body_forbidden');
              if (String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') throw Error('json_content_type_required');
            } catch (e) { finish(e); return; }
            res.on('error', finish);
            res.on('aborted', () => finish('http_body_aborted'));
            res.on('readable', () => {
              if (settled) return;
              try {
                this.at();
                let chunk: Buffer | null;
                while ((chunk = res.read(Math.min(65_536,
                  Math.max(1, res.readableLength), this.policy.perReadBodyBytes - entry.bodyBytes))) !== null) {
                  writeSync(fd!, chunk); chunks.push(chunk); entry.bodyBytes += chunk.length; this.state.bodyBytes += chunk.length;
                  if (entry.bodyBytes >= this.policy.perReadBodyBytes || this.state.bodyBytes >= this.policy.maxBodyBytes) throw Error('application_body_limit');
                }
              } catch (e) { finish(e); }
            });
            res.on('end', () => finish());
            res.on('close', () => { if (!res.complete) finish('http_incomplete_close'); });
          });
          request.on('error', finish);
          this.at(); request.end();
        } catch (e) { finish(e); }
      });
      return result;
    } catch (e) {
      if (!this.failed) { entry.status = 'FAILED'; entry.error = String(e); throw this.fail(String(e)); }
      throw e;
    } finally {
      if (fd !== undefined) closeSync(fd);
      this.activeRead = false; this.activeAbort = undefined;
      entry.sha256 = sha(Buffer.concat(chunks));
      this.persist();
    }
  }

  async stream(callbacks: {
    onMessage: (capture: RawCapture) => void | Promise<void>;
    onSample: (at: CaptureClock) => void | Promise<void>;
    shouldStop: () => boolean;
  }): Promise<{ reason: string; at: CaptureClock; callbacksPending: boolean }> {
    this.available(); const startedAt = this.at();
    if (!this.market || this.activeRead || this.completed.size !== 4) throw this.fail('four_reads_required_before_stream');
    this.streamed = true;
    this.state.status = 'STREAMING'; this.state.streamStartedAt = startedAt; this.persist();
    return new Promise((resolve, reject) => {
      let socket: WebSocket | undefined;
      let finished = false;
      let accepting = true;
      let opened = false;
      let pending = 0;
      let queue = Promise.resolve();
      const timers: ReturnType<typeof setTimeout>[] = [];
      const stop = (reason: string, error = false) => {
        if (finished) return; finished = true;
        this.frontier.open = false;
        this.activeStreamAbort = undefined;
        for (const timer of timers) clearTimeout(timer);
        let at = copy(this.last);
        try { at = copy(this.clock()); }
        catch (e) { error = true; this.state.terminationClockError = String(e); }
        try { socket?.terminate(); }
        catch (e) { error = true; this.state.terminationTransportError = String(e); }
        this.state.status = error ? 'FAILED' : 'STOPPED';
        this.state.termination = { reason, at, callbacksPending: pending > 0 };
        if (error) { this.failed = true; this.state.failures.push(reason); }
        this.persist();
        if (error) reject(Error(`capture:${reason}`)); else resolve(copy(this.state.termination));
      };
      this.activeStreamAbort = (reason) => stop(reason, true);
      const enqueue = (work: () => void | Promise<void>) => {
        pending++;
        queue = queue.then(async () => {
          if (finished) return;
          this.at(); await work(); if (!finished) this.at();
        }).catch((e) => stop(String(e), true)).finally(() => {
          pending--;
          if (!finished) {
            try {
              if (callbacks.shouldStop()) stop('caller_stop');
              else if (!accepting && pending === 0) stop('message_limit');
            } catch (e) { stop(String(e), true); }
          }
        });
        this.callbackQueue = queue;
      };
      const retain = (data: RawData | Buffer, kind: string): RawCapture | null => {
        if (finished || !accepting) return null;
        const at = this.at();
        const raw = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        this.state.messages++; this.state.bodyBytes += raw.length;
        const n = this.state.messages;
        // ws bounds each delivered message. A rejected frame retains a bounded prefix;
        // observed bodyBytes still records all bytes actually delivered to this handler.
        const retained = raw.subarray(0, this.policy.perReadBodyBytes);
        writeFileSync(path.join(this.outputDir, `frame-${n}.bin`), retained, { flag: 'wx', mode: 0o600 });
        this.state.controls.push({ number: n, kind, at, bytes: raw.length, retainedBytes: retained.length,
          sha256: sha(retained), complete: retained.length === raw.length }); this.persist();
        if (raw.length > this.policy.perReadBodyBytes || this.state.bodyBytes >= this.policy.maxBodyBytes) throw Error('stream_application_limit');
        const capture = { url: SOCKET_URL,
          raw: kind === 'protocol_ping' || kind === 'protocol_pong' ? '' : decode(raw),
          at, startedAt, status: null, sha256: sha(raw) };
        return capture;
      };
      const budgetAfter = () => {
        if (this.state.messages < this.policy.maxMessages) return;
        // Stop accepting immediately, then finish already accepted callbacks within
        // the original deadline. No 1001st delivered message enters the journal.
        accepting = false;
        this.frontier.open = false;
        socket?.terminate();
        if (pending === 0) stop('message_limit');
      };
      try {
        if (callbacks.shouldStop()) { stop('caller_stop'); return; }
        socket = this.transports.socket(SOCKET_URL, {
          perMessageDeflate: false, maxPayload: this.policy.perReadBodyBytes,
          followRedirects: false, handshakeTimeout: Math.min(10_000, this.policy.expiresUtcMs - startedAt.utc),
          agent: false, autoPong: false, maxHeaderSize: 16_384,
        });
        socket.on('error', (e) => stop(String(e), true));
        socket.on('unexpected-response', (_req, res) => { res.destroy(); stop('websocket_upgrade_rejected', true); });
        socket.on('close', () => { if (!finished && accepting) stop('websocket_disconnect', true); });
        socket.on('open', () => {
          try {
            if (finished) return;
            if (opened) throw Error('repeated_websocket_open');
            opened = true;
            this.at();
            this.frontier.open = true;
            const send = (raw: string) => {
              this.state.outbound ??= [];
              this.state.outbound.push({ raw, at: copy(this.clock()) }); this.persist();
              socket!.send(raw, { compress: false }, (error) => { if (error) stop(String(error), true); });
            };
            send(JSON.stringify({ type: 'market', assets_ids: [this.market!.token] }));
            const ping = () => {
              if (finished || !accepting) return;
              try { this.at(); send('PING'); timers.push(setTimeout(ping, 10_000)); }
              catch (e) { stop(String(e), true); }
            };
            const sample = () => {
              if (finished || !accepting) return;
              try {
                const at = this.at(); enqueue(() => callbacks.onSample(at));
                timers.push(setTimeout(sample, 1000));
              } catch (e) { stop(String(e), true); }
            };
            timers.push(setTimeout(ping, 10_000), setTimeout(sample, 1000));
          } catch (e) { stop(String(e), true); }
        });
        socket.on('message', (data: RawData, binary: boolean) => {
          if (finished || !accepting) return;
          try {
            // Arrival invalidates a pending quote before serialized bridge delivery.
            // Only the exact text PONG heartbeat is excluded from market ordering.
            const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            if (binary || !bytes.equals(Buffer.from('PONG'))) this.frontier.sequence++;
            if (!opened) throw Error('source_message_before_open');
            const capture = retain(data, binary ? 'binary_rejected' : 'message');
            if (!capture) return;
            if (binary) throw Error('binary_source_frame_forbidden');
            if (capture.raw === 'PONG') { budgetAfter(); return; }
            enqueue(() => callbacks.onMessage(capture)); budgetAfter();
          } catch (e) { stop(String(e), true); }
        });
        socket.on('ping', (data: Buffer) => {
          if (finished || !accepting) return;
          try { if (!opened) throw Error('source_control_before_open'); retain(data, 'protocol_ping'); socket!.pong(data); budgetAfter(); }
          catch (e) { stop(String(e), true); }
        });
        socket.on('pong', (data: Buffer) => {
          if (finished || !accepting) return;
          try { if (!opened) throw Error('source_control_before_open'); retain(data, 'protocol_pong'); budgetAfter(); }
          catch (e) { stop(String(e), true); }
        });
        timers.push(setTimeout(() => {
          try {
            const now = copy(this.clock());
            if (!Number.isSafeInteger(now.utc) || !Number.isFinite(now.mono) ||
              now.utc < this.last.utc || now.mono < this.last.mono ||
              Math.abs(now.utc - this.origin.utc - (now.mono - this.origin.mono)) > 100) {
              stop('clock_disagreement_or_backwards', true); return;
            }
            stop(pending > 0 ? 'callback_pending_at_shared_deadline' : 'shared_deadline', pending > 0);
          } catch (e) { stop(String(e), true); }
        }, Math.min(
          this.policy.expiresUtcMs - startedAt.utc,
          this.policy.maxWallMs - (startedAt.mono - this.origin.mono),
        )));
      } catch (e) { stop(String(e), true); }
    });
  }
}
