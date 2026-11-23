/** One operating paper-source attempt. Reconnects, account state and rollover belong to its owner. */
import { createHash } from 'node:crypto';
import { closeSync, chmodSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  statfsSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { StartupSourceCapture, currentSlotMetadataUrl, verifyStartupCaptureJournal,
  type CaptureClock, type CaptureMarket, type CaptureTransports, type RawCapture } from './maker_startup_capture';

export type OperatingCapturePolicy = {
  metadataUrl: string; expiresUtcMs: number;
  segmentBodyBytes?: number; segmentMessages?: number;
  maxQueuedBytes?: number; maxQueuedMessages?: number; freeDiskReserveBytes?: number;
};
export type OperatingTransports = Partial<CaptureTransports> & { freeDiskBytes?: () => bigint };
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOCKET = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const FRAME = 2_097_152, SEGMENT = 8_388_608;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const json = (x: unknown) => JSON.stringify(x) + '\n';
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const text = (b: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(b);
const chain = (previous: string, raw: Buffer | string) => sha(Buffer.concat([Buffer.from(previous, 'hex'), Buffer.from(raw)]));
const segmentName = (n: number) => `frames-${String(n).padStart(6, '0')}.ndjson`;
const rawBuffer = (data: RawData | Buffer) => Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

/** Bounded-line streaming reader; never loads an attempt's archive or index into RAM. */
async function* lines(file: string, limit: number): AsyncGenerator<Buffer> {
  const st = lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) throw Error('operating:archive_file_identity');
  let chunks: Buffer[] = [], size = 0;
  for await (const value of createReadStream(file, { highWaterMark: 65_536 })) {
    const chunk = value as Buffer; let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start), stop = end < 0 ? chunk.length : end + 1;
      const part = chunk.subarray(start, stop); chunks.push(part); size += part.length;
      if (size > limit) throw Error('operating:archive_line_limit');
      if (end >= 0) { yield Buffer.concat(chunks, size); chunks = []; size = 0; }
      start = stop;
    }
  }
  if (size !== 0) throw Error('operating:archive_truncated');
}

/** Integrity/replay only; the archive does not authenticate venue truth or financial returns. */
export async function verifyOperatingCaptureArchive(outputDir: string, ledger: Record<string, any>) {
  const check = (ok: unknown, reason: string) => { if (!ok) throw Error(`operating:archive_${reason}`); };
  verifyStartupCaptureJournal(path.join(outputDir, 'http'), ledger.http);
  let proof = ledger.proofSeedSha256;
  for (const item of ledger.httpProofs) {
    check(ledger.http.reads.some((r: any) => r.name === item.http && r.sha256 === item.sha256), 'http_binding');
    proof = chain(proof, json(item));
  }
  if (!ledger.index) {
    check(ledger.wsMessages === 0 && !existsSync(path.join(outputDir, 'segments.ndjson')) && proof === ledger.proofHeadSha256, 'not_started');
    return { segments: 0, messages: 0, bodyBytes: 0, proofHeadSha256: proof };
  }
  check(ledger.index.closed === true, 'index_not_closed');
  const ih = createHash('sha256'); let ib = 0, segments = 0, number = 0, delivered = 0, retained = 0;
  let last: CaptureClock | null = null;
  for await (const line of lines(path.join(outputDir, 'segments.ndjson'), 4096)) {
    ih.update(line); ib += line.length;
    const entry = JSON.parse(text(line)); segments++;
    check(entry.segment === segments && entry.file === segmentName(segments), 'segment_order');
    let records = 0, bytes = 0, body = 0, original = 0;
    const h = createHash('sha256');
    for await (const frame of lines(path.join(outputDir, entry.file), Math.ceil(FRAME * 4 / 3) + 4096)) {
      h.update(frame); bytes += frame.length;
      const r = JSON.parse(text(frame)); number++; records++;
      check(r.number === number && Number.isSafeInteger(r.bytes) && Number.isSafeInteger(r.retainedBytes)
        && r.retainedBytes >= 0 && r.retainedBytes <= FRAME && r.bytes >= r.retainedBytes
        && r.complete === (r.bytes === r.retainedBytes), 'frame_count_or_length');
      const raw = Buffer.from(r.rawBase64, 'base64');
      check(raw.toString('base64') === r.rawBase64 && raw.length === r.retainedBytes && sha(raw) === r.sha256, 'frame_hash');
      check(Number.isSafeInteger(r.at.utc) && Number.isFinite(r.at.mono) &&
        (!last || r.at.utc >= last.utc && r.at.mono >= last.mono), 'clock'); last = r.at;
      proof = chain(proof, frame); body += r.retainedBytes; original += r.bytes;
    }
    check(records === entry.records && records <= ledger.policy.segmentMessages &&
      body <= ledger.policy.segmentBodyBytes && body === entry.retainedBodyBytes && original === entry.deliveredBodyBytes
      && bytes === entry.journalBytes && h.digest('hex') === entry.sha256
      && entry.firstNumber === number - records + 1 && entry.lastNumber === number, 'segment_totals');
    delivered += original; retained += body;
  }
  check(segments === ledger.index.segments && ib === ledger.index.bytes && ih.digest('hex') === ledger.index.sha256, 'index_hash');
  check(number === ledger.wsMessages && delivered === ledger.wsBodyBytes && retained === ledger.wsRetainedBytes
    && ledger.bodyBytes === ledger.http.bodyBytes + delivered && proof === ledger.proofHeadSha256, 'attempt_totals');
  return { segments, messages: number, bodyBytes: delivered, proofHeadSha256: proof };
}

export class OperatingSourceCapture {
  private readonly policy: Required<OperatingCapturePolicy>;
  private readonly origin: CaptureClock;
  private last: CaptureClock;
  private readonly http: StartupSourceCapture;
  private readonly transports: OperatingTransports;
  private state: Record<string, any>;
  private market: CaptureMarket | null = null;
  private stopped = false;
  private frontier = { sequence: 0, open: false };
  private streamStarted = false;
  private socket: WebSocket | undefined;
  private activeHttp: Promise<RawCapture> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0; private queuedBytes = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private indexFd: number | undefined;
  private indexHash = createHash('sha256');
  private segmentFd: number | undefined;
  private segmentHash = createHash('sha256');
  private resolveStream: ((x: any) => void) | undefined;
  private rejectStream: ((e: Error) => void) | undefined;
  private finalizing: Promise<void> | undefined;

  constructor(policy: OperatingCapturePolicy, private readonly clock: () => CaptureClock,
    private readonly outputDir: string, transports: OperatingTransports = {}) {
    this.origin = clone(clock()); this.last = clone(this.origin);
    if (!Number.isSafeInteger(this.origin.utc) || !Number.isFinite(this.origin.mono) || this.origin.mono < 0)
      throw Error('operating:initial_clock');
    const match = /^https:\/\/gamma-api\.polymarket\.com\/markets\/slug\/btc-updown-5m-([0-9]{10})$/.exec(policy.metadataUrl);
    const slot = match ? Number(match[1]) * 1000 : NaN;
    if (!Number.isSafeInteger(slot) || currentSlotMetadataUrl(slot) !== policy.metadataUrl ||
      this.origin.utc < slot || this.origin.utc > slot + 240_000 ||
      !Number.isSafeInteger(policy.expiresUtcMs) || policy.expiresUtcMs <= this.origin.utc || policy.expiresUtcMs > slot + 300_000)
      throw Error('operating:current_slot_policy');
    this.policy = Object.freeze({ segmentBodyBytes: SEGMENT, segmentMessages: 20_000,
      maxQueuedBytes: SEGMENT, maxQueuedMessages: 4000, freeDiskReserveBytes: 8 * 1024 ** 3, ...policy });
    for (const [key, maximum] of [['segmentBodyBytes', SEGMENT], ['segmentMessages', 20_000],
      ['maxQueuedBytes', SEGMENT], ['maxQueuedMessages', 4000]] as const)
      if (!Number.isSafeInteger(this.policy[key]) || this.policy[key] < 1 || this.policy[key] > maximum) throw Error('operating:resource_policy');
    if (!Number.isSafeInteger(this.policy.freeDiskReserveBytes) || this.policy.freeDiskReserveBytes < 0) throw Error('operating:disk_policy');
    this.outputDir = path.resolve(outputDir);
    if (!this.outputDir.startsWith(path.join(ROOT, 'reports/evidence') + path.sep)) throw Error('operating:evidence_path');
    for (let p = this.outputDir; ; p = path.dirname(p)) {
      if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw Error('operating:symlink_path');
      if (p === ROOT || p === path.dirname(p)) break;
    }
    mkdirSync(this.outputDir, { mode: 0o700 }); this.transports = transports;
    const proof = sha(json({ schema: 'OPERATING_CAPTURE_ATTEMPT_V1', policy: this.policy, startedAt: this.origin }));
    this.state = { schema: 'OPERATING_CAPTURE_ATTEMPT_V1', policy: this.policy, startedAt: this.origin,
      status: 'PREPARED', wsMessages: 0, wsBodyBytes: 0, wsRetainedBytes: 0, httpProofs: [],
      proofSeedSha256: proof, proofHeadSha256: proof, queuedMessages: 0, queuedBytes: 0,
      peakQueuedMessages: 0, peakQueuedBytes: 0, segment: null, index: null,
      byteScope: 'delivered application bodies; segment limits rotate storage, not lifetime ingress caps',
      frontierScope: 'delivered ws application events, not OS/TLS/parser arrival',
      httpFramingBytes: null, tlsWireBytes: null, actualAccountChargesUSD: null };
    this.http = new StartupSourceCapture({ metadataUrl: policy.metadataUrl, expiresUtcMs: policy.expiresUtcMs,
      maxReads: 4, perReadBodyBytes: FRAME, maxBodyBytes: SEGMENT, maxMessages: 1000, maxWallMs: 300_000 },
    clock, path.join(this.outputDir, 'http'), transports);
    try { this.capacity(); } catch (e) { this.state.status = 'FAILED'; this.state.preflightError = String(e); this.persist(); throw e; }
    this.persist();
  }

  ledger(): Record<string, any> { return clone({ ...this.state, queuedMessages: this.queued, queuedBytes: this.queuedBytes,
    http: this.http.ledger(), bodyBytes: this.http.ledger().bodyBytes + this.state.wsBodyBytes }); }
  proofHeadSha256() { return this.state.proofHeadSha256 as string; }
  observationFrontier() { return { ...this.frontier }; }
  private persist() { writeFileSync(path.join(this.outputDir, 'ledger.json'), JSON.stringify(this.ledger(), null, 2) + '\n'); }
  private capacity() {
    const stat = () => { const s = statfsSync(this.outputDir, { bigint: true }); return s.bavail * s.bsize; };
    const free = (this.transports.freeDiskBytes ?? stat)();
    if (typeof free !== 'bigint' || free < BigInt(this.policy.freeDiskReserveBytes)) throw Error('operating:disk_reserve');
  }
  private at(): CaptureClock {
    const at = clone(this.clock());
    if (!Number.isSafeInteger(at.utc) || !Number.isFinite(at.mono) || at.mono < 0 || at.utc < this.last.utc || at.mono < this.last.mono ||
      Math.abs(at.utc - this.origin.utc - (at.mono - this.origin.mono)) > 100) throw Error('operating:clock');
    this.last = at; if (at.utc >= this.policy.expiresUtcMs) throw Error('operating:slot_deadline'); return at;
  }
  private available() {
    if (this.stopped) throw Error('operating:closed');
    try { if (this.streamStarted) throw Error('operating:late_request'); this.at(); }
    catch (e) { this.stop(String(e), true); throw e; }
  }
  private async read(name: 'metadata' | 'market' | 'book' | 'fee'): Promise<RawCapture> {
    this.available(); if (this.activeHttp) { this.stop('concurrent_http', true); throw Error('operating:concurrent_http'); }
    try {
      this.capacity();
      this.activeHttp = this.http[name === 'metadata' ? 'readMetadata' : name === 'market' ? 'readMarket' : name === 'book' ? 'readBook' : 'readFee']();
      const result = await this.activeHttp;
      const item = { http: name, url: result.url, at: result.at, startedAt: result.startedAt,
        status: result.status, sha256: result.sha256, bytes: Buffer.byteLength(result.raw) };
      this.state.httpProofs.push(item); this.state.proofHeadSha256 = chain(this.state.proofHeadSha256, json(item)); this.persist();
      if (this.stopped) throw Error('operating:stopped_during_http'); this.at(); return result;
    } catch (e) { this.stop(String(e), true); throw e; }
    finally { this.activeHttp = undefined; this.persist(); }
  }
  readMetadata() { return this.read('metadata'); }
  readMarket() { return this.read('market'); }
  readBook() { return this.read('book'); }
  readFee() { return this.read('fee'); }
  bindMarket(market: CaptureMarket) {
    this.available();
    try { this.http.bindMarket(market); this.market = Object.freeze({ ...market }); this.state.market = this.market; this.persist(); }
    catch (e) { this.stop(String(e), true); throw e; }
  }

  private later(work: () => void, delay: number) {
    const timer = setTimeout(() => { this.timers.delete(timer); work(); }, delay); this.timers.add(timer);
  }
  private openSegment(number: number) {
    this.capacity();
    const segment = this.state.index.segments + 1;
    this.segmentFd = openSync(path.join(this.outputDir, segmentName(segment)), 'wx', 0o600);
    this.segmentHash = createHash('sha256');
    this.state.segment = { segment, file: segmentName(segment), firstNumber: number, lastNumber: number - 1,
      records: 0, deliveredBodyBytes: 0, retainedBodyBytes: 0, journalBytes: 0 };
  }
  private write(fd: number, raw: Buffer, h: ReturnType<typeof createHash>) {
    let offset = 0;
    while (offset < raw.length) { const n = writeSync(fd, raw, offset, raw.length - offset);
      if (n <= 0) throw Error('operating:short_write'); h.update(raw.subarray(offset, offset + n)); offset += n; }
  }
  private closeSegment() {
    if (this.segmentFd === undefined) return;
    const fd = this.segmentFd; this.segmentFd = undefined;
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const entry = { ...this.state.segment, sha256: this.segmentHash.digest('hex') };
    chmodSync(path.join(this.outputDir, entry.file), 0o400);
    const raw = Buffer.from(json(entry)); this.write(this.indexFd!, raw, this.indexHash);
    this.state.index.segments++; this.state.index.bytes += raw.length;
    this.state.index.sha256 = this.indexHash.copy().digest('hex'); this.state.segment = null; this.persist();
  }
  private retain(data: RawData | Buffer, kind: string): RawCapture {
    const raw = rawBuffer(data), kept = raw.subarray(0, FRAME);
    const number = ++this.state.wsMessages; this.state.wsBodyBytes += raw.length; this.state.wsRetainedBytes += kept.length;
    let at: CaptureClock;
    const base = { number, kind, bytes: raw.length, retainedBytes: kept.length, complete: kept.length === raw.length,
      sha256: sha(kept), rawBase64: kept.toString('base64') };
    try {
      at = this.at();
      if (kept.length > this.policy.segmentBodyBytes) throw Error('operating:frame_exceeds_segment');
      if (this.state.segment && (this.state.segment.records >= this.policy.segmentMessages ||
        this.state.segment.retainedBodyBytes + kept.length > this.policy.segmentBodyBytes)) this.closeSegment();
      if (this.segmentFd === undefined) this.openSegment(number);
      const line = Buffer.from(json({ ...base, at })); this.write(this.segmentFd!, line, this.segmentHash);
      const s = this.state.segment; s.records++; s.lastNumber = number; s.deliveredBodyBytes += raw.length;
      s.retainedBodyBytes += kept.length; s.journalBytes += line.length;
      this.state.proofHeadSha256 = chain(this.state.proofHeadSha256, line);
      if ((s.records & (s.records - 1)) === 0) this.persist();
    } catch (e) {
      this.state.unrecordedFrame = { ...base, at: null, storageOrClockError: String(e) };
      try {
        writeFileSync(path.join(this.outputDir, 'failed-frame.json'), json(this.state.unrecordedFrame), { flag: 'wx', mode: 0o600 });
        this.state.unrecordedFrame = { number, sha256: base.sha256, file: 'failed-frame.json', error: String(e) };
      } catch (failure) { this.state.failureReceiptError = String(failure); }
      throw e;
    }
    if (raw.length > FRAME) throw Error('operating:message_limit');
    return { url: SOCKET, raw: kind.startsWith('protocol_') ? '' : text(raw), at,
      startedAt: this.state.streamStartedAt, status: null, sha256: base.sha256 };
  }
  private enqueue(work: () => void | Promise<void>, bytes = 0) {
    if (this.queued + 1 > this.policy.maxQueuedMessages || this.queuedBytes + bytes > this.policy.maxQueuedBytes)
      throw Error('operating:queue_capacity');
    this.queued++; this.queuedBytes += bytes;
    this.state.peakQueuedMessages = Math.max(this.state.peakQueuedMessages, this.queued);
    this.state.peakQueuedBytes = Math.max(this.state.peakQueuedBytes, this.queuedBytes);
    this.queue = this.queue.then(async () => { if (!this.stopped) { this.at(); await work(); if (!this.stopped) this.at(); } })
      .catch(e => this.stop(String(e), true)).finally(() => { this.queued--; this.queuedBytes -= bytes; });
  }

  stream(callbacks: { onMessage: (c: RawCapture) => void | Promise<void>;
    onSample: (at: CaptureClock) => void | Promise<void>; shouldStop: () => boolean }): Promise<any> {
    this.available();
    if (!this.market || this.http.ledger().reads.filter((r: any) => r.status === 'COMPLETED').length !== 4) {
      this.stop('four_reads_required', true); throw Error('operating:four_reads_required');
    }
    this.streamStarted = true; this.state.status = 'STREAMING'; this.state.streamStartedAt = this.at();
    return new Promise((resolve, reject) => {
      this.resolveStream = resolve; this.rejectStream = reject;
      try {
        this.capacity(); this.indexFd = openSync(path.join(this.outputDir, 'segments.ndjson'), 'wx', 0o600);
        this.state.index = { file: 'segments.ndjson', segments: 0, bytes: 0, sha256: this.indexHash.copy().digest('hex'), closed: false };
        this.persist(); if (callbacks.shouldStop()) { this.stop('caller_stop'); return; }
        const socket = this.socket = this.transports.socket ? this.transports.socket(SOCKET, {
          agent: false, maxHeaderSize: 16_384, maxPayload: FRAME, perMessageDeflate: false, allowSynchronousEvents: false,
          followRedirects: false, handshakeTimeout: Math.min(10_000, this.policy.expiresUtcMs - this.last.utc), autoPong: false,
        }) : new WebSocket(SOCKET, { agent: false, maxHeaderSize: 16_384, maxPayload: FRAME,
          perMessageDeflate: false, allowSynchronousEvents: false, followRedirects: false,
          handshakeTimeout: Math.min(10_000, this.policy.expiresUtcMs - this.last.utc), autoPong: false } as unknown as ClientOptions);
        let opened = false;
        socket.on('error', e => this.stop(String(e), true));
        socket.on('close', () => { if (!this.stopped) this.stop('websocket_disconnect', true); });
        socket.on('unexpected-response', (_req, res) => { res.destroy(); this.stop('websocket_upgrade', true); });
        const after = async (work: () => void | Promise<void>) => { await work(); if (!this.stopped && callbacks.shouldStop()) this.stop('caller_stop'); };
        socket.on('open', () => {
          if (this.stopped) return;
          try {
            if (opened) throw Error('operating:repeated_open'); opened = true;
            let sampled = this.at(); this.frontier.open = true;
            const send = (raw: string) => socket.send(raw, { compress: false }, e => { if (e) this.stop(String(e), true); });
            this.state.subscription = { raw: JSON.stringify({ type: 'market', assets_ids: [this.market!.token] }), at: sampled };
            send(this.state.subscription.raw);
            const ping = () => { if (this.stopped) return; try { this.at(); send('PING'); this.later(ping, 10_000); } catch (e) { this.stop(String(e), true); } };
            const sample = () => {
              if (this.stopped) return;
              try {
                const at = this.at(), delta = at.mono - sampled.mono;
                if (delta < 1000 || at.utc <= sampled.utc) { this.later(sample, Math.max(1, Math.ceil(1000 - delta), sampled.utc - at.utc + 1)); return; }
                sampled = at;
                this.enqueue(() => after(() => callbacks.onSample(at))); this.later(sample, 1000);
              } catch (e) { this.stop(String(e), true); }
            };
            this.later(ping, 10_000); this.later(sample, 1000); this.persist();
          } catch (e) { this.stop(String(e), true); }
        });
        socket.on('message', (data: RawData, binary: boolean) => {
          if (this.stopped) return;
          try {
            const raw = rawBuffer(data); if (binary || !raw.equals(Buffer.from('PONG'))) this.frontier.sequence++;
            if (!opened) throw Error('operating:message_before_open');
            const c = this.retain(data, binary ? 'binary_rejected' : 'message');
            if (binary) throw Error('operating:binary'); if (c.raw === 'PONG') return;
            this.enqueue(() => after(() => callbacks.onMessage(c)), raw.length);
          } catch (e) { this.stop(String(e), true); }
        });
        for (const kind of ['ping', 'pong'] as const) socket.on(kind, (raw: Buffer) => {
          if (this.stopped) return;
          try { if (!opened) throw Error('operating:control_before_open'); this.retain(raw, `protocol_${kind}`); if (kind === 'ping') socket.pong(raw); }
          catch (e) { this.stop(String(e), true); }
        });
        this.later(() => this.stop('slot_deadline'), this.policy.expiresUtcMs - this.at().utc);
      } catch (e) { this.stop(String(e), true); }
    });
  }

  stop(reason = 'operator_stop', error = false) {
    if (this.stopped) return;
    this.stopped = true; this.frontier.open = false;
    for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    try { this.socket?.terminate(); } catch (e) { error = true; this.state.transportCloseError = String(e); }
    let at = this.last;
    try {
      const candidate = clone(this.clock());
      if (!Number.isSafeInteger(candidate.utc) || !Number.isFinite(candidate.mono) ||
        candidate.utc < this.last.utc || candidate.mono < this.last.mono ||
        Math.abs(candidate.utc - this.origin.utc - (candidate.mono - this.origin.mono)) > 100) throw Error('operating:termination_clock');
      at = candidate; this.last = candidate;
    } catch (e) { error = true; this.state.terminationClockError = String(e); }
    this.state.status = error ? 'FAILED' : 'STOPPED';
    this.state.termination = { reason, at, callbacksPending: this.queued > 0,
      httpPending: !!this.activeHttp, sourceWindowExtended: false };
    if (!this.streamStarted) { this.persist(); return; }
    this.finalizing = (async () => {
      try { this.closeSegment(); }
      catch (e) { error = true; this.state.status = 'FAILED'; this.state.archiveError = String(e); }
      try {
        if (this.indexFd !== undefined) { const fd = this.indexFd; this.indexFd = undefined;
          try { fsyncSync(fd); } finally { closeSync(fd); } this.state.index.closed = true;
          chmodSync(path.join(this.outputDir, 'segments.ndjson'), 0o400); }
        this.state.archiveVerification = await verifyOperatingCaptureArchive(this.outputDir, this.ledger());
      } catch (e) { error = true; this.state.status = 'FAILED'; this.state.archiveError = String(e); }
      try { this.persist(); } catch (e) { error = true; this.state.persistenceError = String(e); }
      if (error) this.rejectStream?.(Error(`operating:${reason}:${this.state.archiveError ?? ''}`));
      else this.resolveStream?.(clone(this.state.termination));
    })();
  }
  async settleCallbacks() {
    const readClock = () => { try { return clone(this.clock()); } catch { return null; } };
    const startedAt = readClock();
    if (this.activeHttp) await this.activeHttp.catch(() => {});
    await this.queue; await this.finalizing;
    this.state.callbackSettlement = { startedAt, completedAt: readClock(), sourceWindowExtended: false };
    this.state.queuedMessages = this.queued; this.state.queuedBytes = this.queuedBytes; this.persist();
  }
}
