/** Source-bound causal paper replay. No gateway, source subscription, or forced fills. */
import Database from 'better-sqlite3';
import {spawn} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, createReadStream, existsSync, fstatSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MakerLoop } from '../../apps/worker/src/maker/MakerLoop';
import { BeliefEngine, MicrostructureBeliefProvider } from '../../apps/worker/src/belief';
import { RegimeGate } from '../../apps/worker/src/regime/RegimeGate';
import { PaperMakerExecution, type PaperBook, type PaperClock, type PaperMakerPolicy } from '../../apps/worker/src/shadow/PaperMakerExecution';
import { createOperatingSourceState, type OperatingSourceMetadata } from './maker_operating_source_bridge';
import { verifyOperatingCaptureArchive } from './maker_operating_capture';
import { selectCurrentBtcMarket, syncEngineInputs } from './maker_paper_startup';
import type { RawCapture } from './maker_startup_capture';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
// Every byte is freshly hashed. The shared synchronous scratch buffer is bounded,
// independently of report/history length; there is deliberately no digest cache.
const FILE_HASH_SCRATCH=Buffer.allocUnsafe(64*1024);
export function hashFileSync(file:string){const fd=openSync(file,'r');try{const before=fstatSync(fd);need(before.isFile(),'file_hash_regular:'+file);const digest=createHash('sha256');let length=0,n:number;
 while((n=readSync(fd,FILE_HASH_SCRATCH,0,FILE_HASH_SCRATCH.length,null))>0){digest.update(FILE_HASH_SCRATCH.subarray(0,n));length+=n;}
 const after=fstatSync(fd),named=statSync(file);need(length===before.size&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&before.dev===named.dev&&before.ino===named.ino,'file_hash_changed:'+file);return digest.digest('hex');
 }finally{closeSync(fd)}}
export function retainedResultProjection(value:any){if(!value?.terminal)return {schema:value?.schema,epoch:value?.epoch};const snapshot=value.terminal.snapshot,accounting=value.terminal.accounting;
 return {schema:value.schema,epoch:value.epoch,terminal:{snapshot:snapshot?{cashUSDC:snapshot.cashUSDC,shares:structuredClone(snapshot.shares),reservedBuyUSDC:snapshot.reservedBuyUSDC,reservedSellShares:structuredClone(snapshot.reservedSellShares)}:undefined,accounting:accounting?{complete:accounting.complete,netPnl:accounting.netPnl,valuationTs:accounting.valuationTs}:undefined}};
}
function retainedApplicationProjection(value:any){return value?{...retainedResultProjection(value),registry:structuredClone(value.registry),policy:structuredClone(value.policy),at:structuredClone(value.at),file:value.file}:null;}
const save = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
function need(v: unknown, why: string): asserts v { if (!v) throw Error('fill_paper:' + why); }
const SCALE = 1_000_000_000n;
const decimal = (v: unknown) => { const s = String(v); need(/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(s), 'decimal'); const [a, b = ''] = s.split('.'); return BigInt(a!) * SCALE + BigInt(b.padEnd(9, '0')); };
const cashText = (v: bigint) => { const sign = v < 0n ? '-' : ''; if (v < 0n) v = -v;
  return `${sign}${v / (SCALE * SCALE)}.${(v % (SCALE * SCALE)).toString().padStart(18, '0')}`; };
export const FILL_POLICY: PaperMakerPolicy = {
  accountKey: 'wallet:1', walletId: 1, openingCash: '100', perOrder: '20', maxExposure: '40',
  maxInventoryShares: '200', submitLatencyMs: 100, cancelLatencyMs: 0, feeModel: 'paper-maker-zero-fee-v1',
};
export const FILL_PROTOCOL = {
  schema: 'CONSERVING_CAUSAL_CAPTURE_PAPER_V3', mode: 'CAUSAL_CAPTURE_REPLAY_PAPER',
  policy: FILL_POLICY, quoteIntervalMs: 1000, ttlMs: 5000, seed: 3737,
  queue: 'Conservative per-arrival cohorts: same-clock/source initial orders share displayed ahead; later arrivals inherit max visible/prior unconsumed external barrier. Pending visible-depth maxima and last causally known fresh book validate +100ms activation. Crossed/stale activation is rejected without retrospective uncrossing. Only opposite same-price prints deplete barriers and own FIFO orders; one conserved print budget.',
  duplicates: 'Existing source decoder refuses ambiguous repeated original trade tuples; identical committed trade id is a no-op; changed economics fails',
  timing: 'Recorded callback order; submit100ms, cancel0ms are model assumptions, not venue latency measurements',
  clockRoles: 'Activation-book receipt <= activation <= eligible print venue <= print receipt. Independently fresh current book may have a later venue timestamp; it cannot retroactively certify activation. Keep per-print venue watermark, UTC/monotonic activation, expiry and cancellation guards.',
  settlement: 'Only an explicit independently reviewed observed binary-payout registry at the source-origin boundary can credit whole held positions, with zero active obligations and exact microcollateral representability. Named zero-redemption-cost paper scenario; actual redemption/gas remain unknown. No retrospective credit.',
  printApplicability: 'The core1000ms execution-age guard stays strict. A schema-valid public observation older than1000ms is atomically recorded as a refusal, never allocated or used to advance an execution watermark. Invalid/future/other guard failures remain errors.',
  fills: 'SIMULATED, supported by original-token public prints under the named queue model; never observed maker execution',
  ordinaryPolicy: 'Existing MakerLoop, canonical features/microstructure belief/regime; funded bids and held-inventory asks',
  fee: 'Named zero-maker-fee paper scenario; rebate0; no claimed paid fee or actual revenue',
  terminal: 'Cancel unfilled remainder, preserve held inventory/cash; fresh model marks or null/bounds; never flatten or reset',
  markoutHorizonsMs: [1000, 5000, 30000], markoutMaximumDelayMs: 1000,
  inference: 'Engineering and model-defined paper accounting only; no novelty, discovery, learning, unseen transfer, or economic advantage',
} as const;

export function applyOriginalPrint(execution: PaperMakerExecution, event: any, identity: { token: string; condition: string }, at: PaperClock, sourceFrameSha256: string | null = null) {
  if (event.event_type !== 'last_trade_price' || event.asset_id !== identity.token || event.market !== identity.condition) return null;
  const sourceId = hash(JSON.stringify([identity.token, Number(event.timestamp), event.side, decimal(event.price).toString(), decimal(event.size).toString(), event.transaction_hash ?? null]));
  const venueUtc=Number(event.timestamp);
  try {return execution.processTrade({sourceId,token:identity.token,side:event.side,price:String(event.price),size:String(event.size),at,venueUtc});}
  catch(error){
    // Reaching this exact guard proves earlier core value/book checks passed.
    // This is an observed old print, not an executable present opportunity.
    if(error instanceof Error&&error.message==='paper_execution:trade_clock'&&Number.isSafeInteger(venueUtc)&&venueUtc<=at.utc&&at.utc-venueUtc>1000)
      return {modelRefusal:true as const,reason:'STALE_PUBLIC_PRINT' as const,sourceId,token:identity.token,condition:identity.condition,
        venueUtc,at:{...at},ageMs:at.utc-venueUtc,event:structuredClone(event),sourceFrameSha256};
    throw error;
  }
}

/** Warm decoding may restore in-memory book custody, never recommit activation/account changes. */
export function restorePaperBook(db: Database.Database, execution: PaperMakerExecution, book: PaperBook) {
  db.exec('SAVEPOINT paper_replay_warm_book');
  try { execution.observeBook(book); }
  finally { db.exec('ROLLBACK TO paper_replay_warm_book'); db.exec('RELEASE paper_replay_warm_book'); }
}

/** Single-purpose account/session using the actual existing ordinary maker. */
export class PaperFillSession {
  readonly execution: PaperMakerExecution;
  private gate: RegimeGate;
  private engine: MakerLoop;
  private seen = new Set<string>();
  private lastTick = -Infinity;
  private terms = new Map<string, any>();
  constructor(readonly db: Database.Database, config: any, readonly clock: () => PaperClock, logger: any) {
    this.execution = new PaperMakerExecution(db, FILL_POLICY, clock);
    db.exec('CREATE TABLE IF NOT EXISTS paper_replay_print_refusals(epoch TEXT NOT NULL,source_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(epoch,source_id))');
    for (const row of db.prepare("SELECT payload_json FROM clob_events WHERE conn_id='isolated-startup-capture'").all() as any[]) {
      const t = JSON.parse(row.payload_json); this.seen.add(t.rawSha256 + ':' + t.venueUtc + ':' + t.token);
    }
    this.gate = new RegimeGate(config.regimeGating, logger);
    try {
      need(config.regimeGating.enabled && this.gate.getLoadDiagnostics().loaded && !this.gate.getLoadDiagnostics().usingLastGood, 'ordinary_regime_not_loaded');
      const belief = new BeliefEngine([new MicrostructureBeliefProvider()], config.belief, { sqlite: db, logger });
      this.engine = new MakerLoop({ ...config.makerEv, ...config.fees, executionMode: 'PAPER',
        intervalMs: 10000, orderTtlMs: 5000, marketScope: 'PROFILE_KNOWN_ONLY',
        regimeModulation: config.regimeGating.modulation, maxInventoryAbs: 200,
        inventoryPenaltyCapacityShares: 200, maxNotionalPerOrderUsd: 20,
        enableBidQuotes: true, enableAskQuotes: true, rebateShareAssumption: 0, liquidityRewardBpsWhenScoring: 0,
      }, { sqlite: db, logger, belief, regimeGate: this.gate, quoteConstraints: (token, market, context) => {
        const row = db.prepare('SELECT minimum_order_size FROM markets WHERE id=?').get(market) as any;
        const snap = this.execution.snapshot();
        const old = context?.replacementOrderId == null ? null : db.prepare("SELECT * FROM shadow_orders WHERE id=? AND status IN ('OPEN','PARTIAL')").get(context.replacementOrderId) as any;
        let liability = snap.availableBuyUSDC;
        if (context?.side === 'SELL') {
          const held = decimal(snap.shares[token] ?? '0');
          const reserved = decimal(snap.reservedSellShares[token] ?? '0');
          const replacing = old?.side === 'SELL' ? decimal(old.size) - decimal(old.filled_size ?? 0) : 0n;
          const available = held - reserved + replacing;
          const feature = db.prepare('SELECT best_bid FROM latest_features WHERE token_id=?').get(token) as any;
          // Every post-only ask exceeds the current bid, so this liability cap sizes at most the held shares.
          liability = cashText((available > 0n ? available : 0n) * decimal(feature?.best_bid ?? 0));
        } else if (old?.side === 'BUY') {
          const [whole, fraction = ''] = liability.split('.');
          liability = cashText(BigInt(whole!) * SCALE * SCALE + BigInt(fraction.padEnd(18, '0'))
            + decimal(old.price) * (decimal(old.size) - decimal(old.filled_size ?? 0)));
        }
        // The strict execution sink remains the precommit authority, including held shares and remaining reservations.
        const terms = this.terms.get(token);
        return { minimumShares: terms?.minimumShares ?? String(row?.minimum_order_size ?? 0),
          minimumNotionalUSDC: terms?.minimumUnit === 'USDC_NOTIONAL' ? terms.minimum : '0', shareIncrement: terms?.lot ?? '0.000000001',
          budgetUSDC: 20, availableLiabilityUSDC: liability,
          feePerShareUSDC: '0', reservedShares: 0, inventoryLimitShares: 200 };
      } });
    } catch (error) { try { this.gate.dispose(); } finally { this.execution.releaseSourceContext(); } throw error; }
  }
  cancelAll(at: PaperClock) {
    const rows = this.db.prepare("SELECT id FROM shadow_orders WHERE status IN ('OPEN','PARTIAL') ORDER BY id").all() as any[];
    for (const r of rows) this.execution.cancel(r.id, at);
    return rows.length;
  }
  async sample(d: ReturnType<ReturnType<typeof createOperatingSourceState>['snapshot']>) {
    const at = this.clock();
    for (const r of this.db.prepare("SELECT id FROM shadow_orders WHERE status IN ('OPEN','PARTIAL') AND expected_cancel_ts<=? ORDER BY id").all(at.utc) as any[]) this.execution.cancel(r.id, at);
    if (d.missing.length) { this.cancelAll(at); return; }
    if (at.mono - this.lastTick < 1000) return;
    this.terms.set(d.identity.token, d.book);
    syncEngineInputs(this.db, d, this.seen);
    this.db.prepare('INSERT OR IGNORE INTO features SELECT * FROM latest_features WHERE token_id=?').run(d.identity.token);
    // Only the admitted current market supplies decisions; previous positions/marks remain in the ledger.
    this.db.prepare('UPDATE wallets SET market_filter_json=? WHERE id=1').run(JSON.stringify({ version: 1, includeMarketIds: [d.identity.market], requireActive: true }));
    try { await (this.engine as any).tick(); }
    catch (error) {
      if (!String(error).includes('paper_execution:') && !String(error).includes('user-defined function')) throw error;
      this.db.prepare('INSERT INTO paper_replay_rejections(ts,reason) VALUES(?,?)').run(at.utc, String(error));
    }
    this.lastTick = at.mono;
    this.execution.reconcileOrders(at);
  }
  close() { try { this.engine.stop(); } finally { try { this.gate.dispose(); } finally { this.execution.releaseSourceContext(); } } }
}

export function createPaperDatabase(file: string): Database.Database {
  const fresh = !existsSync(file);
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = ON');
    if (fresh) {
      db.exec(readFileSync(path.join(ROOT, 'tests/maker/fixtures/startup-canonical-schema.sql'), 'utf8'));
      db.exec(readFileSync(path.join(ROOT, 'packages/storage/migrations/0048_accounting_events.sql'), 'utf8'));
      db.exec(readFileSync(path.join(ROOT, 'packages/storage/migrations/0049_accounting_reports.sql'), 'utf8'));
      db.exec('CREATE TABLE features AS SELECT * FROM latest_features WHERE 0; CREATE UNIQUE INDEX paper_features_identity ON features(token_id,ts);');
      db.prepare("INSERT INTO wallets(id,name,starting_balance,created_at,maker_enabled,auto_trade_enabled,maker_inventory_max_abs) VALUES(1,'Conserving simulated paper account',100,0,1,0,200)").run();
    }
    db.exec('CREATE TABLE IF NOT EXISTS paper_replay_cursor(epoch TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, random_state INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS paper_replay_rejections(ts INTEGER,reason TEXT);');
    return db;
  } catch (error) { db.close(); throw error; }
}

async function* lines(file: string): AsyncGenerator<any> {
  const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of input) { need(Buffer.byteLength(line) <= 2_900_000, 'line_capacity'); yield JSON.parse(line); }
}
function metadata(epoch: string, ledger: any, topN: number): OperatingSourceMetadata {
  const read = (name: string): RawCapture => {
    const row = ledger.http.reads.find((r: any) => r.name === name); need(row, 'metadata_receipt:' + name);
    const raw = readFileSync(path.join(epoch, 'source/http', name + '.bin'), 'utf8');
    need(hash(raw) === row.sha256, 'metadata_hash:' + name);
    need(row.status === 'COMPLETED' && row.httpStatus === 200, 'metadata_not_successful:' + name);
    return { ...row, status: row.httpStatus, raw, at: row.at, startedAt: row.startedAt };
  };
  const gamma = read('metadata'), selection = selectCurrentBtcMarket(gamma), selected = selection.selected;
  need(selected, 'original_market_missing');
  return { gamma, selection, clobMarket: read('market'), clobBook: read('book'), tokenFee: read('fee'),
    originalLabel: selected.outcomes[0]!.label, topKLevels: topN, decision: read('fee').at };
}

/** Complete full-depth maps for queue admission. The existing decoder validates the same raw frame first. */
class OriginalBook {
  private bids = new Map<string, string>(); private asks = new Map<string, string>();
  process(e: any, token: string) {
    if (e.event_type === 'book' && e.asset_id === token) {
      this.bids = new Map(e.bids.map((l: any) => [String(l.price), String(l.size)]));
      this.asks = new Map(e.asks.map((l: any) => [String(l.price), String(l.size)]));
    } else if (e.event_type === 'price_change') for (const l of e.price_changes) {
      if (l.asset_id !== token) continue;
      const side = l.side === 'BUY' ? this.bids : this.asks;
      // Canonicalize numerically identical decimal prices, retaining original decimal quantities.
      const prior = [...side.keys()].find(k => Number(k) === Number(l.price)); if (prior) side.delete(prior);
      if (Number(l.size) > 0) side.set(String(l.price), String(l.size));
    }
  }
  observation(d: any): PaperBook | null {
    if (!this.bids.size || !this.asks.size) return null;
    const bids = [...this.bids].map(([price, size]) => ({ price, size }));
    const asks = [...this.asks].map(([price, size]) => ({ price, size }));
    need(Math.max(...bids.map(l => Number(l.price))) === Number(d.book.bid) && Math.min(...asks.map(l => Number(l.price))) === Number(d.book.ask), 'independent_full_book_disagreement');
    return { sourceId: d.book.rawSha256, token: d.book.token, market: d.identity.market, bids, asks,
      tick: d.book.tick, lot: d.book.lot, minimumShares: d.book.minimumShares, minimumNotionalUSDC: d.book.minimumUnit === 'USDC_NOTIONAL' ? d.book.minimum : '0',
      at: d.book.receipt, venueUtc: d.book.venueUtc };
  }
}

export async function replayPaperEpoch(epoch: string, db: Database.Database, config: any, logger: any,
  devHooks?: { afterCommit?: (state: { ordinal: number; at: PaperClock; randomState: number }) => void }) {
  need(realpathSync(epoch) === path.resolve(epoch), 'source_alias');
  const summary = JSON.parse(readFileSync(path.join(epoch, 'epoch-summary.json'), 'utf8'));
  need(summary.reconciled === true && summary.cleanupFailure === null, 'capture_not_closed');
  const ledger = JSON.parse(readFileSync(path.join(epoch, 'source/ledger.json'), 'utf8'));
  need(JSON.stringify(summary.source) === JSON.stringify(ledger), 'closed_ledger_disagreement');
  const verification = await verifyOperatingCaptureArchive(path.join(epoch, 'source'), ledger);
  const input = metadata(epoch, ledger, config.topN), source = createOperatingSourceState(input, { maxTradesPerSlot: 20000 });
  const identity = source.snapshot(input.decision).identity;
  const samples: any[] = []; for await (const row of lines(path.join(epoch, 'samples.ndjson'))) samples.push(row);
  let at = { ...input.gamma.at }, randomState = FILL_PROTOCOL.seed, ordinal = 0, sampleIndex = 0, frameCount = 0, wireFrameCount = 0;
  const wantedHeads = new Set(samples.map(s => s.proofHeadSha256));
  const sampleHeads = new Map<string, { dataFrames: number; at: PaperClock }>();
  let proof = ledger.proofSeedSha256;
  const chain = (line: string) => { proof = hash(Buffer.concat([Buffer.from(proof, 'hex'), Buffer.from(line)])); };
  for (const receipt of ledger.httpProofs) {
    chain(JSON.stringify(receipt) + '\n');
    if (wantedHeads.has(proof)) { sampleHeads.set(proof, { dataFrames: 0, at: receipt.at }); wantedHeads.delete(proof); }
  }
  let retainedDataFrames = 0;
  // This scan establishes retention vs applied-frontier custody, never a policy input from the future.
  for await (const index of lines(path.join(epoch, 'source/segments.ndjson'))) {
    const inputLines = createInterface({ input: createReadStream(path.join(epoch, 'source', index.file)), crlfDelay: Infinity });
    for await (const rawLine of inputLines) {
      const frame = JSON.parse(rawLine); chain(rawLine + '\n');
      if (frame.kind === 'message' && frame.rawBase64 !== 'UE9ORw==') retainedDataFrames++;
      if (wantedHeads.has(proof)) { sampleHeads.set(proof, { dataFrames: retainedDataFrames, at: frame.at }); wantedHeads.delete(proof); }
    }
  }
  need(wantedHeads.size === 0, 'sample_proof_head_missing');
  const saved = db.prepare('SELECT * FROM paper_replay_cursor WHERE epoch=?').get(epoch) as any;
  const cursor = saved?.ordinal ?? -1;
  const originalNow = Date.now, originalRandom = Math.random;
  Date.now = () => at.utc;
  Math.random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return (randomState >>> 0) / 4294967296; };
  let session: PaperFillSession | undefined; const fullBook = new OriginalBook();
  let sourceBoundary: string | null = null, withheldSamples = 0, invalidSourceFrames = 0;
  const commit = async (fn: () => unknown | Promise<unknown>, hydrate?: () => void, force = true) => {
    const current = ordinal++; if (current <= cursor) { if (current === cursor) { randomState = saved.random_state; hydrate?.(); } return; }
    if (!db.inTransaction) db.exec('BEGIN IMMEDIATE');
    try {
      await fn();
      if (force || (current + 1) % 500 === 0) {
        db.prepare('INSERT INTO paper_replay_cursor VALUES(?,?,?) ON CONFLICT(epoch) DO UPDATE SET ordinal=excluded.ordinal,random_state=excluded.random_state').run(epoch, current, randomState);
        db.exec('COMMIT'); devHooks?.afterCommit?.({ ordinal: current, at: { ...at }, randomState });
      }
    } catch (error) { if (db.inTransaction) db.exec('ROLLBACK'); throw error; }
  };
  const sample = async (s: any) => {
    need(s.processedFrames === frameCount, 'sample_frontier'); at = s.at;
    source.process({ kind: 'sample', at }); const d = source.snapshot(at);
    const book = d.bookInvalidation || d.missing.includes('FRESH_AUTHORITATIVE_ORIGINAL_BOOK') ? null : fullBook.observation(d);
    const observe = () => { if (book && !d.bookInvalidation) session!.execution.observeBook(book); };
    const head = sampleHeads.get(s.proofHeadSha256);
    need(head && head.dataFrames >= s.processedFrames, 'sample_retention_prefix');
    const current = head.dataFrames === s.processedFrames && head.at.utc <= at.utc && head.at.mono <= at.mono;
    if (!current) withheldSamples++;
    await commit(async () => { observe(); if (current) await session!.sample(d); else session!.cancelAll(at); }, () => { if (book && !d.bookInvalidation) restorePaperBook(db, session!.execution, book); });
  };
  const started = performance.now(), cpu = process.cpuUsage();
  try {
    session = new PaperFillSession(db, config, () => at, logger);
    for await (const index of lines(path.join(epoch, 'source/segments.ndjson'))) {
      for await (const frame of lines(path.join(epoch, 'source', index.file))) {
        need(frame.number === ++wireFrameCount && frame.complete === true, 'frame_sequence');
        const raw = Buffer.from(frame.rawBase64, 'base64').toString('utf8');
        if (frame.kind.startsWith('protocol_') || raw === 'PONG') continue;
        need(frame.kind === 'message', 'non_message_frame');
        while (sampleIndex < samples.length && samples[sampleIndex].processedFrames <= frameCount) await sample(samples[sampleIndex++]);
        frameCount++; at = frame.at;
        try { source.process({ kind: 'frame', at, raw }); }
        catch (error) { sourceBoundary = String(error); await commit(() => { session!.cancelAll(at); db.prepare('UPDATE latest_features SET mid=NULL').run(); }); break; }
        if (raw !== 'PONG') {
          const payload = JSON.parse(raw), events = Array.isArray(payload) ? payload : [payload];
          // Frame reads must not clone growing feature/trade history (the canonical decoder exposes a constant-history status read).
          const status = source.bookStatus(at), d = { identity, book: status.book, bookInvalidation: status.bookInvalidation };
          // The canonical decoder can invalidate an applied delta and retain its LAST valid BBO.
          // Do not apply that invalid delta to a second map or compare it as if authoritative.
          // Only the canonical full-snapshot reanchor can make a later map usable again.
          if (status.bookInvalidation) {
            invalidSourceFrames++;
            await commit(() => session!.cancelAll(at));
            continue;
          }
          // A later book in the same delivered array cannot validate an earlier trade.
          let tradeSeen = false;
          if (events.some((e: any) => { if (e.event_type === 'last_trade_price') tradeSeen = true;
            return tradeSeen && (e.event_type === 'book' || e.event_type === 'price_change'); })) {
            sourceBoundary = 'MODEL_INAPPLICABLE_LATER_BOOK_IN_TRADE_FRAME';
            await commit(() => { session!.cancelAll(at); db.prepare('UPDATE latest_features SET mid=NULL').run(); }); break;
          }
          for (const e of events) fullBook.process(e, d.identity.token);
          // A valid but stale update still changes the canonical chain; keep its full-depth map,
          // while withholding observation/allocation until freshness returns.
          const book = status.fresh ? fullBook.observation(d) : null;
          const observe = () => { if (book && status.fresh && !status.bookInvalidation) session!.execution.observeBook(book); };
          await commit(() => {
            observe();
            if (!status.fresh || status.bookInvalidation || !book) { session!.cancelAll(at); return; }
            for (const e of events){const applied=applyOriginalPrint(session!.execution,e,d.identity,at,frame.sha256);
              if(applied&&'modelRefusal' in applied){
                const previous=db.prepare('SELECT payload_json FROM paper_replay_print_refusals WHERE epoch=? AND source_id=?').get(epoch,applied.sourceId) as any;
                if(previous)need(stableJSON(JSON.parse(previous.payload_json))===stableJSON(applied),'print_refusal_identity_conflict');
                else db.prepare('INSERT INTO paper_replay_print_refusals VALUES(?,?,?)').run(epoch,applied.sourceId,JSON.stringify(applied));
              }
            }
          }, () => { if (book && status.fresh && !status.bookInvalidation) restorePaperBook(db, session!.execution, book); }, events.some((e: any) => e.event_type === 'last_trade_price'));
        }
      }
      if (sourceBoundary) break;
    }
    if (!sourceBoundary) {
      while (sampleIndex < samples.length) await sample(samples[sampleIndex++]);
    }
    await commit(() => session!.cancelAll(at));
    const terminal = session!.execution.terminalReport({ valuationTs: at.utc, asOfReceiptTs: at.utc });
    const [cashWhole, cashFraction = ''] = terminal.snapshot.cashUSDC.split('.');
    const exactCash = BigInt(cashWhole!) * SCALE * SCALE + BigInt(cashFraction);
    const held = Object.values(terminal.snapshot.shares).reduce<bigint>((total, v) => total + decimal(v), 0n);
    const markouts = (db.prepare('SELECT f.id,f.ts,f.price,f.size,o.side,o.token_id FROM shadow_fills f JOIN shadow_orders o ON o.id=f.order_id ORDER BY f.id').all() as any[]).flatMap(fill =>
      FILL_PROTOCOL.markoutHorizonsMs.map(horizonMs => {
        const mark = db.prepare('SELECT ts,mid FROM features WHERE token_id=? AND ts>=? AND ts<=? AND mid IS NOT NULL ORDER BY ts LIMIT 1').get(fill.token_id, fill.ts + horizonMs, fill.ts + horizonMs + FILL_PROTOCOL.markoutMaximumDelayMs) as any;
        return { fillId: fill.id, horizonMs, markTs: mark?.ts ?? null, reference: 'execution-price',
          modeledMarkoutBps: mark ? (fill.side === 'BUY' ? 1 : -1) * 10000 * (mark.mid - fill.price) / fill.price : null };
      }));
    const output = { schema: 'CONSERVING_PAPER_EPOCH_RESULT_V1', mode: FILL_PROTOCOL.mode, epoch, sourceVerification: verification,
      sourceBoundary, wireFrameCount, frameCount, samplesApplied: sampleIndex, withheldSamples, invalidSourceFrames,
      frozenSourceLedgerSha256: hashFileSync(path.join(epoch, 'source/ledger.json')),
      terminal, markouts, terminalNoSettlementPnlBoundsUSDC: {
        lower: cashText(exactCash - 100n * SCALE * SCALE), upper: cashText(exactCash + held * SCALE - 100n * SCALE * SCALE),
        meaning: 'Model cash plus binary holdings valued in [0,1]; not a settlement forecast or realized profit' },
      printRefusals: db.prepare('SELECT * FROM paper_replay_print_refusals WHERE epoch=? ORDER BY rowid').all(epoch),
      fills: db.prepare('SELECT * FROM shadow_fills ORDER BY id').all(), accountingEvents: db.prepare('SELECT * FROM accounting_events ORDER BY id').all(),
      resources: { cpuMicroseconds: process.cpuUsage(cpu), wallMilliseconds: performance.now() - started, nestedInHostReceipt: true },
      actualAccountChargesUSD: null, actualRevenue: null, realizedVenueProfit: null, economicAdvantage: 'NOT_ESTABLISHED' };
    return output;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    if (error && typeof error === 'object') Object.assign(error, { paperCheckpoint: {
      status: 'INCOMPLETE_RECOVERABLE', epoch, attemptedClock: { ...at },
      committedCursor: db.prepare('SELECT * FROM paper_replay_cursor WHERE epoch=?').get(epoch) ?? null,
      accountState: session?.execution.snapshot() ?? null, terminalComplete: false, modelNetPnlUSDC: null,
      explanation: 'Committed funds, holdings and reservations retained. In-transaction failures roll back; committed boundaries remain. No terminal-zero assertion.',
    } });
    throw error;
  } finally { try { session?.close(); } finally { Date.now = originalNow; Math.random = originalRandom; } }
}

type Admission = { schema: 'CONSERVING_PAPER_REPLAY_ADMISSION_V1'; codeSha256: Record<string, string>; protocolSha256: string;
  source: { epoch: string; files: Record<string, string> }; outputDirectory: string; reviewFile: string; reviewSha256: string };
export async function runFrozenPaperReplay(admissionFile: string) {
  const admission: Admission = JSON.parse(readFileSync(admissionFile, 'utf8'));
  need(admission.schema === 'CONSERVING_PAPER_REPLAY_ADMISSION_V1' && admission.protocolSha256 === hash(JSON.stringify(FILL_PROTOCOL)), 'admission_protocol');
  for (const [p, digest] of Object.entries({ ...admission.codeSha256, ...admission.source.files })) need(hashFileSync(p) === digest, 'frozen_input_changed:' + p);
  const reviewRaw = readFileSync(admission.reviewFile); need(hash(reviewRaw) === admission.reviewSha256, 'review_hash');
  const review = JSON.parse(reviewRaw.toString()); need(review.decision === 'APPROVE_FROZEN_ONE_CAPTURE_PAPER_ENGINEERING' && review.protocolSha256 === admission.protocolSha256 && review.outputDirectory === admission.outputDirectory && JSON.stringify(review.codeSha256) === JSON.stringify(admission.codeSha256) && JSON.stringify(review.source) === JSON.stringify(admission.source), 'independent_source_review');
  need(!existsSync(admission.outputDirectory), 'frozen_run_already_started'); mkdirSync(admission.outputDirectory, { recursive: true, mode: 0o700 });
  save(path.join(admission.outputDirectory, 'frozen-admission.json'), admission);
  const db = createPaperDatabase(path.join(admission.outputDirectory, 'paper.sqlite'));
  const log: any[] = [], logger: any = Object.fromEntries(['info','warn','error','debug','trace','fatal'].map(k => [k, (...args: any[]) => log.push({ level: k, args })]));
  try {
    const config = JSON.parse(readFileSync(path.join(ROOT, 'configs/worker.json'), 'utf8'));
    const output = await replayPaperEpoch(admission.source.epoch, db, config, logger);
    save(path.join(admission.outputDirectory, 'result.json'), output); save(path.join(admission.outputDirectory, 'engine-log.json'), log);
    return output;
  } catch (error) { save(path.join(admission.outputDirectory, 'failure.json'), { error: String(error), paperCheckpoint: (error as any)?.paperCheckpoint ?? null, actualAccountChargesUSD: null }); throw error; }
  finally { db.close(); }
}


type FilePin = {path:string;sha256:string};
export type IncompleteFollowerCheckpoint = {mode:'INCOMPLETE_EPOCH';receipt:FilePin;resumeEpoch:number;lastModeledEpoch:number;resumeSource:{summary:FilePin;ledger:FilePin}};
export type ClosedPrefixFollowerCheckpoint = {mode:'CLOSED_PREFIX';receipt:FilePin;lastModeledEpoch:number};
export type FollowerCarry = {database:FilePin;result:FilePin;review:FilePin;lastEpoch:number;checkpoint?:IncompleteFollowerCheckpoint|ClosedPrefixFollowerCheckpoint};
export type FollowerSourceCutover = {afterEpoch:number;sourceRoot:string;sourceAdmission:FilePin};
export type FollowerAdmission = {schema:'CONSERVING_PAPER_FOLLOWER_ADMISSION_V2';protocolSha256:string;
  inputMode:'CLOSED_CAPTURE_FOLLOWER'|'AUTHORED_OFFLINE_FIXTURE';codeSha256:Record<string,string>;
  sourceRoot:string;firstEpoch:number;sourceAdmission:FilePin;carryFrom:FollowerCarry;sourceCutover?:FollowerSourceCutover;payoutRegistry?:FilePin;standingPayoutRefresh?:FilePin;
  outputDirectory:string;reviewFile:string;reviewSha256:string};
export const FOLLOWER_PROTOCOL={schema:'CONSERVING_PAPER_FOLLOWER_DRIVER_V5',paper:FILL_PROTOCOL,
  account:'mandatory independently checked closed DB: terminal account or explicitly reviewed incomplete-epoch checkpoint; copy once, preserve exact cash/holdings/orders/reservations/cursor/RNG, no refund or reset',
  sourceCutover:'optional single pinned epoch boundary; consume every old epoch first, no active orders at origin change, persist raw new process mono origin with nondecreasing UTC; no clock offsets',
  reports:'immutable per-epoch receipts, restart compares complete source/economic projection excluding measured resources only',
  payoutCustody:'boundary application JSON/SHA and exact canonical prefix commit atomically with settlement; warm restart verifies retained boundary evidence and never revalues it from current funds',
  selection:'all ascending closed captures from last carried epoch+1; explicit structural-ineligible receipts are not rewards',
  standingValuation:'Optional separately admitted own-held-token source refresh, >=300000ms pending polls, independently verified raw result, permanent finalized certificates, no fund effect on unavailable/unsupported; apply whole holdings only at later source-epoch receipt with zero obligations',
  memory:'Fresh bounded-chunk SHA256 without a digest cache; retain only runtime valuation projection, preserve complete published reports and comparisons; release completed source-clock contexts with fail-closed callbacks',
  waiting:'retain last source-as-of account/valuation, incomplete PnL remains null',sourceCaptureDuplicated:false} as const;
function regularPin(pin:FilePin){need(pin&&typeof pin.path==='string'&&/^[a-f0-9]{64}$/.test(pin.sha256),'file_pin');
  need(realpathSync(pin.path)===path.resolve(pin.path)&&lstatSync(pin.path).isFile()&&!lstatSync(pin.path).isSymbolicLink(),'file_pin_identity');
  const raw=readFileSync(pin.path);need(hash(raw)===pin.sha256,'file_pin_changed:'+pin.path);return raw;}
function verifyPin(pin:FilePin){need(pin&&typeof pin.path==='string'&&/^[a-f0-9]{64}$/.test(pin.sha256),'file_pin');need(realpathSync(pin.path)===path.resolve(pin.path)&&lstatSync(pin.path).isFile()&&!lstatSync(pin.path).isSymbolicLink(),'file_pin_identity');need(hashFileSync(pin.path)===pin.sha256,'file_pin_changed:'+pin.path);}
function syncDirectory(dir:string){const fd=openSync(dir,'r');try{fsyncSync(fd)}finally{closeSync(fd)}}
const atomic=(file:string,value:unknown)=>{const tmp=file+'.'+randomUUID()+'.tmp';const fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd)}finally{closeSync(fd)}renameSync(tmp,file);syncDirectory(path.dirname(file));};
function immutable(file:string,value:unknown){const tmp=file+'.'+randomUUID()+'.publishing';const fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd)}finally{closeSync(fd)}
  try{linkSync(tmp,file);syncDirectory(path.dirname(file));}finally{unlinkSync(tmp);}syncDirectory(path.dirname(file));}
function ownedJSON(file:string){need(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink()&&realpathSync(file)===file,'published_file_identity');return JSON.parse(readFileSync(file,'utf8'));}
export function verifyFollowerKernelLock(outputDirectory:string){
  const allowed=path.join(ROOT,'reports/evidence'),resolved=path.resolve(outputDirectory);
  need(resolved===outputDirectory&&resolved.startsWith(allowed+path.sep),'follower_output_scope');
  for(let p=resolved;p!==path.resolve(ROOT);p=path.dirname(p)){if(existsSync(p))need(!lstatSync(p).isSymbolicLink(),'follower_output_alias');need(p!==path.dirname(p),'follower_output_scope');}
  const lock=path.join(allowed,'maker-fill-paper-account.lock'),fd=Number(process.env.PAPER_FILL_LOCK_FD);
  need(process.env.PAPER_FILL_LOCK_PATH===lock&&Number.isSafeInteger(fd)&&fd>=3,'follower_kernel_lock_required');
  need(realpathSync(lock)===lock&&lstatSync(lock).isFile()&&!lstatSync(lock).isSymbolicLink(),'follower_kernel_lock_identity');
  const held=fstatSync(fd),named=statSync(lock);need(held.isFile()&&held.dev===named.dev&&held.ino===named.ino,'follower_kernel_lock_identity');
}
function economicProjection(value:any){const {resources:_resources,...retained}=value;return retained;}
function stableJSON(value:any):string {if(Array.isArray(value))return '['+value.map(stableJSON).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableJSON(value[k])).join(',')+'}';return JSON.stringify(value);}
function exactAccount(db:Database.Database){
  const account=db.prepare('SELECT * FROM paper_execution_account WHERE id=1').get() as any;need(account,'carried_account_missing');need(stableJSON(JSON.parse(account.policy))===stableJSON(FILL_POLICY),'carried_policy_mismatch');
  const shares=Object.fromEntries((db.prepare('SELECT * FROM paper_execution_positions ORDER BY token').all() as any[]).map(r=>{const n=BigInt(r.shares);return [r.token,`${n/SCALE}.${(n%SCALE).toString().padStart(9,'0')}`]}));
  let reserved=0n;const sells:Record<string,bigint>={};for(const r of db.prepare("SELECT * FROM paper_execution_orders WHERE status='ACTIVE'").all() as any[]){if(r.side==='BUY')reserved+=decimal(r.price)*decimal(r.remaining);else sells[r.token]=(sells[r.token]??0n)+decimal(r.remaining);}
  return {cashUSDC:cashText(BigInt(account.cash)),heldShares:shares,reservedBuyUSDC:cashText(reserved),reservedSellShares:Object.fromEntries(Object.entries(sells).map(([k,n])=>[k,`${n/SCALE}.${(n%SCALE).toString().padStart(9,'0')}`])),ledgerLastTradeUTC:account.last_utc};
}
export function isStructuralSourceIneligible(error:unknown){
  return error instanceof Error&&['maker_source:empty_book_side','fill_paper:original_market_missing','maker_source:validated_initial_snapshot_unavailable','maker_source:validated_rest_tick_mismatch','maker_source:validated_metadata_tick_mismatch','maker_source:tick_or_minimum','maker_source:book_market_limits'].includes(error.message);
}
async function structuralDisposition(epoch:string,topN:number){
  need(realpathSync(epoch)===epoch,'closed_source_alias');
  const summary=ownedJSON(path.join(epoch,'epoch-summary.json'));
  need(summary.reconciled===true&&summary.cleanupFailure===null,'capture_not_closed');
  const ledger=ownedJSON(path.join(epoch,'source/ledger.json'));need(JSON.stringify(summary.source)===JSON.stringify(ledger),'closed_ledger_disagreement');
  const archive=await verifyOperatingCaptureArchive(path.join(epoch,'source'),ledger);
  const completed=['metadata','market','book','fee'].every(name=>ledger.http?.reads?.some((r:any)=>r.name===name&&r.status==='COMPLETED'&&r.httpStatus===200));
  let reason:string|null=!completed?'MISSING_COMPLETED_HTTP_INPUTS':null,detail:any=null;
  if(!reason){try{const input=metadata(epoch,ledger,topN),source=createOperatingSourceState(input,{maxTradesPerSlot:20000});
    const dynamic=new Set(['FRESH_AUTHORITATIVE_ORIGINAL_BOOK','CURRENT_CANONICAL_FEATURE_SAMPLE','OBSERVED_VOLATILITY_HISTORY','OBSERVED_ORIGINAL_TOKEN_TRADE_FLOW']);
    const missing=source.snapshot(input.decision).missing.filter(r=>!dynamic.has(r));if(missing.length){reason='STATIC_MODEL_INPUTS_MISSING';detail=missing;}
   }catch(error){if(isStructuralSourceIneligible(error)){reason='STRUCTURAL_SOURCE_TERMS_INELIGIBLE';detail=String(error);}else throw error;
   }}
  if(!reason&&archive.messages===0)reason='NO_DATA_STREAM';
  return {reason,detail,archive,summarySha256:hashFileSync(path.join(epoch,'epoch-summary.json')),ledgerSha256:hashFileSync(path.join(epoch,'source/ledger.json'))};
}
function readPayoutRegistry(pin:FilePin){const registry=JSON.parse(regularPin(pin).toString()),result=JSON.parse(regularPin(registry.sourceResult).toString()),review=JSON.parse(regularPin(registry.sourceReview).toString());
  need(registry.schema==='PAPER_OBSERVED_BINARY_PAYOUT_REGISTRY_V1'&&registry.costScenario==='paper-zero-redemption-cost-v1'&&Number.isSafeInteger(registry.observedReceiptUTC)&&registry.observedReceiptUTC>=0,'payout_registry');
  need(result.schema==='PAPER_CTF_CHECKPOINT_VALUATION_V1'&&result.completeHeldPositionValuation===true&&result.accountCashCredited===false&&review.verified===true&&review.resultSha256===registry.sourceResult.sha256,'payout_registry_source');
  need(Array.isArray(registry.entries)&&registry.entries.length===4&&new Set(registry.entries.map((e:any)=>e.token)).size===4,'payout_registry_entries');
  for(const e of registry.entries){need(typeof e.token==='string'&&/^\d+$/.test(e.token)&&typeof e.market==='string'&&e.market.length>0&&typeof e.condition==='string'&&/^0x[a-fA-F0-9]{64}$/.test(e.condition)&&(e.payout===0||e.payout===1),'payout_registry_entry');
    const original=result.positions.find((p:any)=>p.token===e.token&&p.condition===e.condition),vector=result.providers?.[0]?.vectors?.[e.condition];
    need(original&&vector?.status==='FINALIZED_PROVIDER_ATTESTED'&&/^[1-9]\d*$/.test(vector.denominator)&&Array.isArray(vector.numerators)&&vector.numerators.length===2&&vector.numerators[0]===String(BigInt(vector.denominator)*BigInt(e.payout)),'payout_registry_original_binding');
  }return registry;
}
function checkedPayoutApplication(db:Database.Database,registry:FilePin,at?:PaperClock){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_replay_payout_application'").get())return null;
  const retained=db.prepare('SELECT * FROM paper_replay_payout_application WHERE registry_sha=?').get(registry.sha256) as any;if(!retained)return null;
  need(hash(retained.payload_json)===retained.payload_sha,'payout_application_custody');const applied=JSON.parse(retained.payload_json);
  need(applied.schema==='PAPER_OBSERVED_PAYOUT_APPLICATION_V2'&&stableJSON(applied.registry)===stableJSON(registry)&&(!at||stableJSON(applied.at)===stableJSON(at))&&applied.costScenario==='paper-zero-redemption-cost-v1','payout_application_binding');
  const settlements=(db.prepare('SELECT * FROM paper_execution_settlements ORDER BY rowid').all() as any[]).filter(r=>JSON.parse(r.payload).registrySha256===registry.sha256);
  need(stableJSON(applied.terminal.snapshot.settlements)===stableJSON(settlements),'payout_application_settlements');
  const prefix=applied.canonicalPrefix;need(Array.isArray(prefix)&&prefix.length>0&&Number.isSafeInteger(prefix[prefix.length-1].id),'payout_application_canonical_prefix');
  need(stableJSON(db.prepare('SELECT * FROM accounting_events WHERE id<=? ORDER BY id').all(prefix[prefix.length-1].id))===stableJSON(prefix),'payout_application_canonical_prefix');return applied;
}
type PayoutCommand=(argv:string[],deadline:number,log:string)=>Promise<number>;
function standingPolicy(pin:FilePin,a?:FollowerAdmission){const p=JSON.parse(regularPin(pin).toString());
 need(p.schema==='PAPER_OWN_HELD_PAYOUT_REFRESH_POLICY_V1'&&p.enabled===true&&Number.isSafeInteger(p.minIntervalMs)&&p.minIntervalMs>=300000&&Number.isSafeInteger(p.maxWallMs)&&p.maxWallMs>0&&p.maxPositionsPerBatch===10&&p.maxRequestsPerBatch===60,'standing_payout_policy');
 need(stableJSON(p.allowedOrigins)===stableJSON(['https://polygon-bor-rpc.publicnode.com'])&&p.requestTimeoutSeconds===12&&p.maxResponseBodyBytes===1048576,'standing_payout_source_scope');
 for(const file of [p.pythonExecutable,p.collector,p.verifier,...p.helperFilePins])verifyPin(file);
 need((statSync(p.pythonExecutable.path).mode&0o111)!==0&&Array.isArray(p.identitySources)&&p.identitySources.length>0,'standing_payout_runtime');
 for(const source of p.identitySources){need(realpathSync(source.sourceRoot)===source.sourceRoot,'standing_identity_source');verifyPin(source.sourceAdmission);}
 if(a)need(p.allowedAccountRoots.includes(a.outputDirectory)&&p.allowedOperationReviewFiles.includes(a.reviewFile),'standing_payout_owner_scope');return p;
}
function installStandingPayoutTables(db:Database.Database){db.exec(`
 CREATE TABLE IF NOT EXISTS paper_payout_refresh_quarantine(source_key TEXT PRIMARY KEY,payload_json TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS paper_payout_refresh_quarantine_update BEFORE UPDATE ON paper_payout_refresh_quarantine BEGIN SELECT RAISE(ABORT,'fill_paper:immutable_payout_quarantine'); END;
 CREATE TRIGGER IF NOT EXISTS paper_payout_refresh_quarantine_delete BEFORE DELETE ON paper_payout_refresh_quarantine BEGIN SELECT RAISE(ABORT,'fill_paper:immutable_payout_quarantine'); END;
 CREATE TABLE IF NOT EXISTS paper_payout_refresh_due(token TEXT PRIMARY KEY,condition TEXT NOT NULL,policy_sha TEXT NOT NULL,last_utc INTEGER NOT NULL,status TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS paper_payout_refresh_attempts(id TEXT PRIMARY KEY,at_utc INTEGER NOT NULL,payload_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS paper_payout_refresh_certificates(token TEXT PRIMARY KEY,condition TEXT NOT NULL,payload_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS paper_payout_refresh_applications(id INTEGER PRIMARY KEY,payload_sha TEXT NOT NULL,payload_json TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS paper_payout_refresh_certificate_update BEFORE UPDATE ON paper_payout_refresh_certificates BEGIN SELECT RAISE(ABORT,'fill_paper:immutable_payout_certificate'); END;
 CREATE TRIGGER IF NOT EXISTS paper_payout_refresh_certificate_delete BEFORE DELETE ON paper_payout_refresh_certificates BEGIN SELECT RAISE(ABORT,'fill_paper:immutable_payout_certificate'); END;
 CREATE TRIGGER IF NOT EXISTS paper_payout_refresh_application_update BEFORE UPDATE ON paper_payout_refresh_applications BEGIN SELECT RAISE(ABORT,'fill_paper:immutable_payout_application'); END;
 CREATE TRIGGER IF NOT EXISTS paper_payout_refresh_application_delete BEFORE DELETE ON paper_payout_refresh_applications BEGIN SELECT RAISE(ABORT,'fill_paper:immutable_payout_application'); END;`);}
function filePin(file:string):FilePin{return {path:file,sha256:hashFileSync(file)};}
function payoutIdentity(db:Database.Database,policy:any,token:string,dir:string){
 const canonical=db.prepare('SELECT t.market_id,t.outcome,m.condition_id,m.slug FROM tokens t JOIN markets m ON m.id=t.market_id WHERE t.id=?').get(token) as any;need(canonical&&/^0x[a-fA-F0-9]{64}$/.test(canonical.condition_id),'payout_identity_canonical_missing');
 const epochs=db.prepare("SELECT epoch,source_sha FROM paper_consumed_epochs WHERE disposition='MODELLED' ORDER BY epoch DESC").all() as any[];
 for(const n of epochs)for(const admitted of policy.identitySources){const epoch=path.join(admitted.sourceRoot,'epoch-'+String(n.epoch).padStart(6,'0')),summary=path.join(epoch,'epoch-summary.json');if(!existsSync(summary)||hashFileSync(summary)!==n.source_sha)continue;
  const ledger=ownedJSON(path.join(epoch,'source/ledger.json')),raw=path.join(epoch,'source/http/metadata.bin');if(!existsSync(raw))continue;const original=JSON.parse(readFileSync(raw,'utf8'));if(original.id!==canonical.market_id)continue;
  const pins:Record<string,FilePin>={};for(const name of ['metadata','market','book']){const file=path.join(epoch,'source/http',name+'.bin'),receipt=ledger.http.reads.find((r:any)=>r.name===name);need(receipt?.status==='COMPLETED'&&receipt.httpStatus===200&&receipt.sha256===filePin(file).sha256,'payout_identity_receipt');pins[name]=filePin(file);regularPin(pins[name]!);}
  need(stableJSON(ownedJSON(summary).source)===stableJSON(ledger),'payout_identity_ledger');
  const label=canonical.outcome,labels=typeof original.outcomes==='string'?JSON.parse(original.outcomes):original.outcomes,version=original.version;need(version==='v1'||version==='v2','payout_identity_version');
  const ids=version==='v1'?(typeof original.clobTokenIds==='string'?JSON.parse(original.clobTokenIds):original.clobTokenIds):original.positionIds;
  need(original.conditionId===canonical.condition_id&&original.slug===canonical.slug&&Array.isArray(labels)&&Array.isArray(ids)&&labels.indexOf(label)>=0&&ids[labels.indexOf(label)]===token,'payout_identity_original_token');
  const identity={metadata:pins.metadata,market:pins.market,book:pins.book,token,marketId:canonical.market_id,condition:canonical.condition_id,protocolVersion:version,outcome:label,sourceAdmission:admitted.sourceAdmission};const evidence=path.join(dir,'identity-'+token+'.json');immutable(evidence,identity);return {token,market:canonical.market_id,condition:canonical.condition_id,protocolVersion:version,identityEvidence:filePin(evidence)};
 }throw Error('fill_paper:payout_identity_original_capture_missing');
}
async function payoutCommand(argv:string[],deadline:number,log:string){const fd=openSync(log,'wx',0o600);try{return await new Promise<number>((resolve,reject)=>{
 const child=spawn(argv[0]!,argv.slice(1),{stdio:['ignore',fd,fd],env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',PYTHONNOUSERSITE:'1'}});let timedOut=false,kill:ReturnType<typeof setTimeout>|undefined;
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');kill=setTimeout(()=>child.kill('SIGKILL'),2000)},Math.max(1,deadline-performance.now()));
 child.once('error',error=>{clearTimeout(timer);if(kill)clearTimeout(kill);reject(error)});child.once('close',code=>{clearTimeout(timer);if(kill)clearTimeout(kill);resolve(timedOut?-1:code??-1)});
 });}finally{fsyncSync(fd);closeSync(fd)}}
const PAYOUT_SOURCE_KEY='https://polygon-bor-rpc.publicnode.com|137|0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
function payoutAccessDenied(result:any){return result?.retryDisposition==='ACCESS_DENIED_REQUIRES_REVIEW'||(result?.terminalAccessFailure!=null&&result.terminalAccessFailure!==false)||result?.sourceErrors?.some((e:any)=>e.httpStatus===401||e.httpStatus===403)===true;}
function embargoFromRetainedAttempt(db:Database.Database,attempt:string,policy:FilePin,now:number){const output=path.join(attempt,'capture');if(!existsSync(output))return false;
 need(realpathSync(output)===output,'payout_orphan_output_alias');for(const name of readdirSync(output).filter(n=>n==='result.json'||/^rpc-\d{3}\.json$/.test(n))){const file=path.join(output,name);need(statSync(file).size<=7340032,'payout_orphan_receipt_size');const receipt=filePin(file),r=JSON.parse(regularPin(receipt).toString());const rawDenied=r.origin==='https://polygon-bor-rpc.publicnode.com'&&((r.httpStatus===401||r.httpStatus===403)||(typeof r.error==='string'&&/^HTTP Error (401|403):/.test(r.error)));
  if(rawDenied||payoutAccessDenied(r)){const embargo={schema:'PAPER_PAYOUT_SOURCE_ACCESS_QUARANTINE_V1',sourceKey:PAYOUT_SOURCE_KEY,atUTC:now,attempt,receipt,policy,automaticRetryAllowed:false,basis:'RETAINED_ACCESS_REJECTION_NO_CREDIT',actualRevenue:null};db.prepare('INSERT OR IGNORE INTO paper_payout_refresh_quarantine VALUES(?,?)').run(PAYOUT_SOURCE_KEY,JSON.stringify(embargo));return true;}
 }return false;
}
function reconcilePreparedPayouts(db:Database.Database,now:number){for(const row of db.prepare("SELECT id,payload_json FROM paper_payout_refresh_attempts WHERE json_extract(payload_json,'$.status')='PREPARED'").all() as any[]){const p=JSON.parse(row.payload_json);embargoFromRetainedAttempt(db,row.id,p.policy,now);db.prepare('UPDATE paper_payout_refresh_attempts SET payload_json=? WHERE id=?').run(JSON.stringify({...p,status:'ORPHANED_UNAVAILABLE',reconciledUTC:now,actualRevenue:null}),row.id);}}
function unfinishedPaperEpoch(db:Database.Database){const last=(db.prepare('SELECT MAX(epoch) n FROM paper_consumed_epochs').get() as any).n??0;return (db.prepare('SELECT epoch FROM paper_replay_cursor').all() as any[]).some(r=>Number(String(r.epoch).slice(-6))>last);}
export function selectPayoutRefreshPositions(rows:{r:any;due:any;final:boolean}[],now:number,minInterval:number,policySha:string){return rows.filter(({r,final,due})=>BigInt(r.shares)>0n&&!final&&(!due||(now-due.last_utc>=minInterval&&(due.status!=='UNSUPPORTED'||due.policy_sha!==policySha)))).sort((a,b)=>(a.due?.last_utc??-Infinity)-(b.due?.last_utc??-Infinity)||a.r.token.localeCompare(b.r.token)).slice(0,10).map(({r})=>r);}
function standingPayoutSummary(db:Database.Database){if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='paper_payout_refresh_attempts'").get())return null;const row=db.prepare('SELECT id,payload_json FROM paper_payout_refresh_attempts ORDER BY at_utc DESC,id DESC LIMIT 1').get() as any,latest=row?JSON.parse(row.payload_json):null;
 const assets=(db.prepare("SELECT token,shares FROM paper_execution_positions WHERE shares!='0' ORDER BY token").all() as any[]).filter(p=>BigInt(p.shares)>0n).map(p=>{const due=db.prepare('SELECT * FROM paper_payout_refresh_due WHERE token=?').get(p.token) as any,cert=db.prepare('SELECT payload_json FROM paper_payout_refresh_certificates WHERE token=?').get(p.token) as any,observed=cert?JSON.parse(cert.payload_json).item:null,item=[...(latest?.positions??[]),...(latest?.localUnavailable??[])].find((v:any)=>v.token===p.token);return {token:p.token,quantityShares:`${BigInt(p.shares)/SCALE}.${(BigInt(p.shares)%SCALE).toString().padStart(9,'0')}`,status:observed?'FINALIZED_WAITING_FOR_LATER_SOURCE_CLOCK':due?.status??'NOT_ATTEMPTED',lastAttemptUTC:due?.last_utc??null,observedReceiptUTC:observed?.observedReceiptUTC??null,reason:String(item?.reason??item?.error??observed?.reason??'').slice(0,300)||null};});
 return {lastAttempt:latest?{path:path.join(row.id,'attempt.json'),atUTC:latest.atUTC,status:latest.status,error:String(latest.error??'').slice(0,500)||null,input:latest.input}:null,assets};
}
export async function refreshHeldPayouts(db:Database.Database,a:FollowerAdmission,now:number,command:PayoutCommand=payoutCommand){
 if(!a.standingPayoutRefresh||unfinishedPaperEpoch(db))return;need(Number.isSafeInteger(now)&&now>=0,'payout_refresh_clock');need(!db.inTransaction,'payout_refresh_transaction');const policy=standingPolicy(a.standingPayoutRefresh,a);installStandingPayoutTables(db);
 reconcilePreparedPayouts(db,now);
 if(db.prepare('SELECT 1 FROM paper_payout_refresh_quarantine WHERE source_key=?').get(PAYOUT_SOURCE_KEY))return;
 const held=db.prepare("SELECT token,shares FROM paper_execution_positions WHERE shares!='0' ORDER BY token").all() as any[];
 const candidates=selectPayoutRefreshPositions(held.map(r=>({r,final:!!db.prepare('SELECT 1 FROM paper_payout_refresh_certificates WHERE token=?').get(r.token),due:db.prepare('SELECT * FROM paper_payout_refresh_due WHERE token=?').get(r.token)})),now,policy.minIntervalMs,a.standingPayoutRefresh.sha256);if(!candidates.length)return;
 const folder=path.join(a.outputDirectory,'payout-refresh');mkdirSync(folder,{recursive:true,mode:0o700});const dir=path.join(folder,now+'-'+randomUUID());mkdirSync(dir,{mode:0o700});const ownerAdmission=filePin(path.join(a.outputDirectory,'frozen-admission.json'));
 const checkpoint={schema:'PAPER_OWN_HELD_PAYOUT_CHECKPOINT_V1',asOfUTC:now,ownerAdmissionSha256:ownerAdmission.sha256,account:exactAccount(db),canonicalEventHash:hash(stableJSON(db.prepare('SELECT * FROM accounting_events ORDER BY id').all()))};const checkpointFile=path.join(dir,'account-checkpoint.json');immutable(checkpointFile,checkpoint);
 const positions:any[]=[],localUnavailable:any[]=[];for(const r of candidates){try{positions.push({...payoutIdentity(db,policy,r.token,dir),quantityShares:`${BigInt(r.shares)/SCALE}.${(BigInt(r.shares)%SCALE).toString().padStart(9,'0')}`})}catch(error){localUnavailable.push({token:r.token,status:'UNAVAILABLE',error:String(error)})}}
 const input={schema:'PAPER_OWN_HELD_PAYOUT_REFRESH_INPUT_V1',asOfUTC:now,policy:a.standingPayoutRefresh,ownerAdmission,accountCheckpoint:filePin(checkpointFile),accountCheckpointSha256:hashFileSync(checkpointFile),sourceAdmissions:policy.identitySources.map((s:any)=>s.sourceAdmission),positions};const inputFile=path.join(dir,'input.json');immutable(inputFile,input);const output=path.join(dir,'capture');const prepared={schema:'PAPER_OWN_HELD_PAYOUT_REFRESH_ATTEMPT_V1',status:'PREPARED',atUTC:now,policy:a.standingPayoutRefresh,input:filePin(inputFile),positions:candidates.map(r=>r.token),actualRevenue:null};immutable(path.join(dir,'prepared.json'),prepared);
 db.transaction(()=>{db.prepare('INSERT INTO paper_payout_refresh_attempts VALUES(?,?,?)').run(dir,now,JSON.stringify(prepared));for(const r of candidates)db.prepare('INSERT INTO paper_payout_refresh_due VALUES(?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET policy_sha=excluded.policy_sha,last_utc=excluded.last_utc,status=excluded.status').run(r.token,'',a.standingPayoutRefresh!.sha256,now,'PREPARED')})();
 let status='UNAVAILABLE',error:string|null=null,resultPin:FilePin|null=null,verificationPin:FilePin|null=null,observed:any[]=[];
 try{if(positions.length){const deadline=performance.now()+policy.maxWallMs;const argv=(script:FilePin)=>[policy.pythonExecutable.path,script.path,'--input',inputFile,'--output',output,'--policy',a.standingPayoutRefresh!.path];
   need(await command(argv(policy.collector),deadline,path.join(dir,'collector.log'))===0,'payout_collector_unavailable');standingPolicy(a.standingPayoutRefresh,a);need(await command(argv(policy.verifier),deadline,path.join(dir,'verifier.log'))===0,'payout_verifier_unavailable');standingPolicy(a.standingPayoutRefresh,a);
   resultPin=filePin(path.join(output,'result.json'));verificationPin=filePin(path.join(output,'verification.json'));const result=JSON.parse(regularPin(resultPin).toString()),verification=JSON.parse(regularPin(verificationPin).toString());
   need(verification.decision==='VERIFIED_OWN_HELD_PAYOUT_REFRESH'&&verification.inputSha256===filePin(inputFile).sha256&&verification.policySha256===a.standingPayoutRefresh.sha256&&verification.resultSha256===resultPin.sha256,'payout_verification');
   need(result.schema==='PAPER_OWN_HELD_PAYOUT_REFRESH_RESULT_V1'&&result.inputSha256===filePin(inputFile).sha256&&result.policySha256===a.standingPayoutRefresh.sha256&&Array.isArray(result.positions)&&result.positions.length===positions.length,'payout_result');
   need(stableJSON(checkpoint.account)===stableJSON(exactAccount(db))&&checkpoint.canonicalEventHash===hash(stableJSON(db.prepare('SELECT * FROM accounting_events ORDER BY id').all())),'payout_account_changed');
   const seen=new Set<string>();for(const item of result.positions){const original=positions.find(p=>p.token===item.token);need(original&&!seen.has(item.token)&&item.condition===original.condition&&item.market===original.market&&['FINALIZED_BINARY','PENDING','UNAVAILABLE','UNSUPPORTED'].includes(item.status),'payout_result_identity');seen.add(item.token);
     if(item.status==='FINALIZED_BINARY')need(original.protocolVersion==='v1'&&(item.payout===0||item.payout===1)&&Number.isSafeInteger(item.observedReceiptUTC)&&item.observedReceiptUTC>=now&&item.sourceAssurance==='SINGLE_PROVIDER_ATTESTED','payout_certificate');else need(item.payout===null,'payout_nonfinal_cash');}
   need(!payoutAccessDenied(result),'payout_access_denied_requires_review');observed=result.positions;status='VERIFIED';db.transaction(()=>{for(const item of observed)if(item.status==='FINALIZED_BINARY')db.prepare('INSERT INTO paper_payout_refresh_certificates VALUES(?,?,?)').run(item.token,item.condition,JSON.stringify({item,input:filePin(inputFile),policy:a.standingPayoutRefresh,result:resultPin,verification:verificationPin}));})();
  }}catch(failure){error=String(failure);status='UNAVAILABLE';observed=[];}
 if(existsSync(path.join(output,'result.json'))){try{const rawPin=filePin(path.join(output,'result.json')),raw=JSON.parse(regularPin(rawPin).toString());if(payoutAccessDenied(raw)){const embargo={schema:'PAPER_PAYOUT_SOURCE_ACCESS_QUARANTINE_V1',sourceKey:PAYOUT_SOURCE_KEY,atUTC:now,attempt:dir,result:rawPin,policy:a.standingPayoutRefresh,sourceErrors:raw.sourceErrors??null,terminalAccessFailure:raw.terminalAccessFailure??null,automaticRetryAllowed:false,actualRevenue:null};db.prepare('INSERT OR IGNORE INTO paper_payout_refresh_quarantine VALUES(?,?)').run(PAYOUT_SOURCE_KEY,JSON.stringify(embargo));status='QUARANTINED_ACCESS_DENIED';}}catch(parseError){error=(error??'')+'; access_receipt:'+String(parseError);}}
 if(embargoFromRetainedAttempt(db,dir,a.standingPayoutRefresh,now))status='QUARANTINED_ACCESS_DENIED';
 const receipt={schema:'PAPER_OWN_HELD_PAYOUT_REFRESH_ATTEMPT_V1',atUTC:now,status,error,input:filePin(inputFile),result:resultPin,verification:verificationPin,positions:observed,localUnavailable,actualRevenue:null,actualCharges:null};immutable(path.join(dir,'attempt.json'),receipt);
 db.transaction(()=>{db.prepare('UPDATE paper_payout_refresh_attempts SET payload_json=? WHERE id=?').run(JSON.stringify(receipt),dir);for(const r of candidates){const item=observed.find(p=>p.token===r.token);db.prepare('INSERT INTO paper_payout_refresh_due VALUES(?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET condition=excluded.condition,policy_sha=excluded.policy_sha,last_utc=excluded.last_utc,status=excluded.status').run(r.token,item?.condition??'',a.standingPayoutRefresh!.sha256,now,item?.status??'UNAVAILABLE')}})();
}
export function applyStandingPayouts(db:Database.Database,a:FollowerAdmission,at:PaperClock){if(!a.standingPayoutRefresh)return null;standingPolicy(a.standingPayoutRefresh,a);installStandingPayoutTables(db);need(!db.inTransaction,'payout_application_transaction');
 const ready=(db.prepare('SELECT * FROM paper_payout_refresh_certificates ORDER BY token').all() as any[]).map(r=>JSON.parse(r.payload_json)).filter(c=>c.item.observedReceiptUTC<=at.utc&&BigInt((db.prepare('SELECT shares FROM paper_execution_positions WHERE token=?').get(c.item.token) as any)?.shares??'0')>0n);if(!ready.length)return null;
 const core=new PaperMakerExecution(db,FILL_POLICY,()=>at);const file=path.join(a.outputDirectory,'payout-refresh','application-'+at.utc+'-'+randomUUID()+'.json');let application:any;
 db.transaction(()=>{for(const c of ready){const result=JSON.parse(regularPin(c.result).toString()),verification=JSON.parse(regularPin(c.verification).toString());verifyPin(c.input);verifyPin(c.policy);need(verification.decision==='VERIFIED_OWN_HELD_PAYOUT_REFRESH'&&verification.resultSha256===c.result.sha256&&verification.inputSha256===c.input.sha256&&verification.policySha256===c.policy.sha256&&result.positions.some((p:any)=>stableJSON(p)===stableJSON(c.item)),'cached_payout_certificate');
   core.settleBinaryHolding({token:c.item.token,market:c.item.market,condition:c.item.condition,payout:c.item.payout,at,observedReceiptUTC:c.item.observedReceiptUTC,registrySha256:hash(stableJSON(c)),sourceResultSha256:c.result.sha256,sourceReviewSha256:c.verification.sha256,costScenario:'paper-zero-redemption-cost-v1'});}
   application={schema:'PAPER_STANDING_PAYOUT_APPLICATION_V1',at,policy:a.standingPayoutRefresh,certificates:ready,terminal:core.terminalReport({valuationTs:at.utc,asOfReceiptTs:at.utc}),canonicalPrefix:db.prepare('SELECT * FROM accounting_events ORDER BY id').all(),file,costScenario:'paper-zero-redemption-cost-v1',actualGas:null,actualRedemption:null,actualRevenue:null};const payload=JSON.stringify(application);db.prepare('INSERT INTO paper_payout_refresh_applications(payload_sha,payload_json) VALUES(?,?)').run(hash(payload),payload);
 })();immutable(file,application);return application;
}
function latestStandingPayout(db:Database.Database,outputDirectory:string){if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='paper_payout_refresh_applications'").get())return null;const r=db.prepare('SELECT * FROM paper_payout_refresh_applications ORDER BY id DESC LIMIT 1').get() as any;if(!r)return null;need(hash(r.payload_json)===r.payload_sha,'standing_payout_custody');const p=JSON.parse(r.payload_json),prefix=p.canonicalPrefix;need(stableJSON(db.prepare('SELECT * FROM accounting_events WHERE id<=? ORDER BY id').all(prefix[prefix.length-1].id))===stableJSON(prefix),'standing_payout_prefix');if(existsSync(p.file))need(stableJSON(ownedJSON(p.file))===stableJSON(p),'standing_payout_file');else{need(path.dirname(path.dirname(p.file))===outputDirectory,'standing_payout_historical_file_missing');immutable(p.file,p);}return p;}

/** Pure read-only custody for an already quiescent, fully consumed paper prefix. */
export function closedPrefixCheckpoint(db:Database.Database){need(!db.inTransaction,'closed_prefix_transaction');const account=exactAccount(db);
  need(account.reservedBuyUSDC==='0.000000000000000000'&&Object.values(account.reservedSellShares).every(v=>decimal(v)===0n)&&(db.prepare("SELECT COUNT(*) n FROM shadow_orders WHERE status IN ('OPEN','PARTIAL','PENDING')").get() as any).n===0&&(db.prepare("SELECT COUNT(*) n FROM paper_execution_orders WHERE status='ACTIVE'").get() as any).n===0,'closed_prefix_open_orders');
  const last=db.prepare('SELECT * FROM paper_consumed_epochs ORDER BY epoch DESC LIMIT 1').get() as any,modeled=db.prepare("SELECT * FROM paper_consumed_epochs WHERE disposition='MODELLED' ORDER BY epoch DESC LIMIT 1").get() as any;need(last&&modeled,'closed_prefix_consumption');
  const cursors=db.prepare('SELECT * FROM paper_replay_cursor ORDER BY epoch').all() as any[];need(cursors.every(c=>/epoch-\d{6}$/.test(c.epoch)&&Number(c.epoch.slice(-6))<=last.epoch),'closed_prefix_incomplete_cursor');
  const tables:Record<string,{rows:number;sha256:string}>={};for(const table of ['shadow_orders','shadow_fills','accounting_events','paper_execution_account','paper_execution_positions','paper_execution_queues','paper_execution_orders','paper_execution_trades','paper_execution_allocations','paper_execution_terms','paper_execution_watermarks','paper_execution_clock_origins','paper_execution_settlements','paper_replay_cursor','paper_consumed_epochs','paper_replay_payout_application','paper_replay_print_refusals','paper_payout_refresh_due','paper_payout_refresh_attempts','paper_payout_refresh_certificates','paper_payout_refresh_applications','paper_payout_refresh_quarantine']){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
    const rows=db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all();tables[table]={rows:rows.length,sha256:hash(stableJSON(rows))};
  }need(hashFileSync(modeled.result_file)===modeled.result_sha,'closed_prefix_result_changed');const sourceEpoch=ownedJSON(modeled.result_file).epoch;need(typeof sourceEpoch==='string'&&path.basename(sourceEpoch)==='epoch-'+String(modeled.epoch).padStart(6,'0'),'closed_prefix_result_lineage');
  return {schema:'PAPER_FOLLOWER_CLOSED_PREFIX_CHECKPOINT_V1',status:'CLOSED_PREFIX',lastConsumedEpoch:last.epoch,lastModeledEpoch:modeled.epoch,lastModeledResult:{path:modeled.result_file,sha256:modeled.result_sha,sourceEpoch},account,tables};
}
function seedFollower(a:FollowerAdmission){
  need(a.carryFrom&&Number.isSafeInteger(a.carryFrom.lastEpoch)&&a.carryFrom.lastEpoch>=1&&a.firstEpoch===a.carryFrom.lastEpoch+1,'follower_carry_lineage');
  verifyPin(a.carryFrom.database);const resultRaw=regularPin(a.carryFrom.result),review=JSON.parse(regularPin(a.carryFrom.review).toString());
  const checkpoint=a.carryFrom.checkpoint;
  const checkpointReceipt:any=checkpoint?JSON.parse(regularPin(checkpoint.receipt).toString()):null;
  const modeledEpoch=checkpoint?.lastModeledEpoch??a.carryFrom.lastEpoch;
  const result=JSON.parse(resultRaw.toString());need(Number.isSafeInteger(modeledEpoch)&&modeledEpoch>=1&&modeledEpoch<=a.carryFrom.lastEpoch&&result.schema==='CONSERVING_PAPER_EPOCH_RESULT_V1'&&result.epoch===(checkpoint?.mode==='CLOSED_PREFIX'?checkpointReceipt?.lastModeledResult?.sourceEpoch:path.join(a.sourceRoot,'epoch-'+String(modeledEpoch).padStart(6,'0'))),'follower_carry_result_lineage');
  need(review.decision===(checkpoint?(checkpoint.mode==='INCOMPLETE_EPOCH'?'APPROVE_PAPER_FOLLOWER_CARRY_FROM_INCOMPLETE_CHECKPOINT':'APPROVE_PAPER_FOLLOWER_CARRY_FROM_CLOSED_PREFIX'):'APPROVE_PAPER_FOLLOWER_CARRY_FROM_CLOSED_ACCOUNT')&&review.databaseClosed===true&&review.lastEpoch===a.carryFrom.lastEpoch&&review.paperProtocolSha256===hash(JSON.stringify(FILL_PROTOCOL))
    &&stableJSON(review.database)===stableJSON(a.carryFrom.database)&&stableJSON(review.result)===stableJSON(a.carryFrom.result)&&stableJSON(review.checkpoint)===stableJSON(checkpoint),'follower_carry_review');
  if(checkpoint){need(['INCOMPLETE_EPOCH','CLOSED_PREFIX'].includes(checkpoint.mode),'follower_checkpoint_lineage');
    if(checkpoint.mode==='INCOMPLETE_EPOCH'){need(checkpoint.resumeEpoch===a.firstEpoch,'follower_checkpoint_lineage');
    const epoch=path.join(a.sourceRoot,'epoch-'+String(a.firstEpoch).padStart(6,'0'));
    need(checkpoint.resumeSource.summary.path===path.join(epoch,'epoch-summary.json')&&checkpoint.resumeSource.ledger.path===path.join(epoch,'source/ledger.json'),'follower_checkpoint_source');
    verifyPin(checkpoint.resumeSource.summary);verifyPin(checkpoint.resumeSource.ledger);
    need(checkpointReceipt.schema==='PAPER_FOLLOWER_RECOVERABLE_FAILURE_V2'&&checkpointReceipt.activeEpoch===a.firstEpoch&&checkpointReceipt.lastModeledEpoch===modeledEpoch&&checkpointReceipt.complete===false
      &&checkpointReceipt.paperCheckpoint?.status==='INCOMPLETE_RECOVERABLE'&&checkpointReceipt.paperCheckpoint.epoch===epoch&&checkpointReceipt.paperCheckpoint.terminalComplete===false,'follower_checkpoint_receipt');
    }else need(checkpointReceipt.schema==='PAPER_FOLLOWER_CLOSED_PREFIX_CHECKPOINT_V1'&&checkpointReceipt.status==='CLOSED_PREFIX'&&checkpointReceipt.lastConsumedEpoch===a.carryFrom.lastEpoch&&checkpointReceipt.lastModeledEpoch===modeledEpoch&&checkpointReceipt.lastModeledResult?.path===a.carryFrom.result.path&&checkpointReceipt.lastModeledResult.sha256===a.carryFrom.result.sha256&&path.basename(result.epoch)==='epoch-'+String(modeledEpoch).padStart(6,'0'),'follower_checkpoint_receipt');
  }
  for(const suffix of ['-wal','-journal'])need(!existsSync(a.carryFrom.database.path+suffix)||statSync(a.carryFrom.database.path+suffix).size===0,'seed_database_not_closed');
  const file=path.join(a.outputDirectory,'paper.sqlite'),receipt=path.join(a.outputDirectory,'carry-receipt.json');
  if(!existsSync(file)){need(!existsSync(receipt),'seed_database_missing');const tmp=file+'.'+randomUUID()+'.seed';copyFileSync(a.carryFrom.database.path,tmp,constants.COPYFILE_EXCL);
    const fd=openSync(tmp,'r');try{fsyncSync(fd)}finally{closeSync(fd)}need(hashFileSync(tmp)===a.carryFrom.database.sha256&&hashFileSync(a.carryFrom.database.path)===a.carryFrom.database.sha256,'seed_copy_changed');renameSync(tmp,file);syncDirectory(a.outputDirectory);}
  if(existsSync(receipt)){need(stableJSON(ownedJSON(receipt).carryFrom)===stableJSON(a.carryFrom),'carry_receipt_changed');}
  else {need(hashFileSync(file)===a.carryFrom.database.sha256,'unreceipted_seed_changed');immutable(receipt,{schema:'PAPER_FOLLOWER_CARRY_RECEIPT_V1',carryFrom:a.carryFrom,genesisNotRepeated:true});}
  const bank=lstatSync(file),original=statSync(a.carryFrom.database.path);need(bank.isFile()&&!bank.isSymbolicLink()&&bank.nlink===1&&!(bank.dev===original.dev&&bank.ino===original.ino),'carried_database_identity');
  const accountProof=path.join(a.outputDirectory,'carry-account-proof.json');
  if(existsSync(accountProof))need(stableJSON(ownedJSON(accountProof).carryFrom)===stableJSON(a.carryFrom),'carry_account_proof_changed');
  else need(hashFileSync(file)===a.carryFrom.database.sha256,'unverified_carried_account_changed');
  return {file,result:retainedResultProjection(result),accountProof,checkpointReceipt,needsAccountProof:!existsSync(accountProof)};
}
/** Follows closed captures only. It never starts a source connection or funds a new account. */
export async function runPaperFollower(admissionFile:string,dev?:{maxCycles?:number;wait?:(ms:number)=>Promise<void>;afterReportPublished?:(epoch:number)=>void;beforeReplay?:(epoch:number)=>void;payoutClock?:()=>number;runPayoutCommand?:PayoutCommand;afterReplayCommit?:(epoch:number,state:{ordinal:number;at:PaperClock;randomState:number})=>void}){
  const raw=readFileSync(admissionFile),a:FollowerAdmission=JSON.parse(raw.toString());
  need(a.schema==='CONSERVING_PAPER_FOLLOWER_ADMISSION_V2'&&a.protocolSha256===hash(JSON.stringify(FOLLOWER_PROTOCOL)),'follower_protocol');
  need(['CLOSED_CAPTURE_FOLLOWER','AUTHORED_OFFLINE_FIXTURE'].includes(a.inputMode)&&(!dev||a.inputMode==='AUTHORED_OFFLINE_FIXTURE'),'follower_input_mode');
  if(dev?.maxCycles!==undefined)need(Number.isSafeInteger(dev.maxCycles)&&dev.maxCycles>0,'fixture_cycles');
  need(Number.isSafeInteger(a.firstEpoch)&&a.firstEpoch>=1&&realpathSync(a.sourceRoot)===a.sourceRoot,'follower_source');verifyPin(a.sourceAdmission);
  if(a.sourceCutover){const c=a.sourceCutover;need(Number.isSafeInteger(c.afterEpoch)&&c.afterEpoch>=a.firstEpoch&&realpathSync(c.sourceRoot)===c.sourceRoot&&c.sourceRoot!==a.sourceRoot,'follower_cutover');verifyPin(c.sourceAdmission);
    need(!c.sourceRoot.startsWith(a.sourceRoot+path.sep)&&!a.sourceRoot.startsWith(c.sourceRoot+path.sep),'follower_cutover_alias');}
  if(a.payoutRegistry){need(a.sourceCutover,'payout_registry_requires_cutover');readPayoutRegistry(a.payoutRegistry);}
  if(a.standingPayoutRefresh){need(a.carryFrom.checkpoint?.mode!=='INCOMPLETE_EPOCH','standing_payout_requires_closed_prefix');standingPolicy(a.standingPayoutRefresh,a);}
  const review=JSON.parse(regularPin({path:a.reviewFile,sha256:a.reviewSha256}).toString());
  need(review.decision==='APPROVE_CONSERVING_CAPTURE_FOLLOWER_PAPER_OPERATION'&&review.protocolSha256===a.protocolSha256&&review.inputMode===a.inputMode
    &&review.sourceRoot===a.sourceRoot&&review.firstEpoch===a.firstEpoch&&review.outputDirectory===a.outputDirectory&&stableJSON(review.codeSha256)===stableJSON(a.codeSha256)
    &&stableJSON(review.sourceAdmission)===stableJSON(a.sourceAdmission)&&stableJSON(review.carryFrom)===stableJSON(a.carryFrom)&&stableJSON(review.sourceCutover)===stableJSON(a.sourceCutover)&&stableJSON(review.payoutRegistry)===stableJSON(a.payoutRegistry)&&stableJSON(review.standingPayoutRefresh)===stableJSON(a.standingPayoutRefresh),'follower_review');
  need(!a.outputDirectory.startsWith(a.sourceRoot+path.sep)&&!a.sourceRoot.startsWith(a.outputDirectory+path.sep)&&a.sourceRoot!==a.outputDirectory,'follower_source_output_overlap');
  if(a.sourceCutover)need(!a.outputDirectory.startsWith(a.sourceCutover.sourceRoot+path.sep)&&!a.sourceCutover.sourceRoot.startsWith(a.outputDirectory+path.sep)&&a.sourceCutover.sourceRoot!==a.outputDirectory,'follower_source_output_overlap');
  for(const required of ['scripts/research/maker_fill_paper.ts','apps/worker/src/shadow/PaperMakerExecution.ts'])need(Object.keys(a.codeSha256).some(p=>path.resolve(p)===path.join(ROOT,required)),'follower_required_code_pin');
  const verifyCode=()=>{for(const [p,h] of Object.entries(a.codeSha256))need(hashFileSync(p)===h,'follower_code_drift:'+p)};
  verifyCode();verifyFollowerKernelLock(a.outputDirectory);mkdirSync(a.outputDirectory,{recursive:true,mode:0o700});need(realpathSync(a.outputDirectory)===a.outputDirectory,'follower_output_alias');
  const frozen=path.join(a.outputDirectory,'frozen-admission.json');if(existsSync(frozen)){ownedJSON(frozen);need(readFileSync(frozen).equals(raw),'follower_restart_admission');}else {const fd=openSync(frozen,'wx',0o600);try{writeFileSync(fd,raw);fsyncSync(fd)}finally{closeSync(fd)}syncDirectory(a.outputDirectory);}
  const seed=seedFollower(a),db=createPaperDatabase(seed.file);
  let config:any,lastResult:any,lastModeledEpoch=a.carryFrom.checkpoint?.lastModeledEpoch??a.carryFrom.lastEpoch,lastResultPath=a.carryFrom.result.path;
  let lastClosedEpoch=a.carryFrom.lastEpoch,lastReceipt=a.carryFrom.result.path,lastDisposition='CARRIED_CLOSED_ACCOUNT';
  const payoutReportFile=path.join(a.outputDirectory,'observed-payout-application.json');let payoutApplication:any=null,payoutApplicationPath=payoutReportFile;
  try {
  config=JSON.parse(readFileSync(path.join(ROOT,'configs/worker.json'),'utf8'));
  lastResult=seed.result;
  if(seed.needsAccountProof){const initial=exactAccount(db);
   if(a.carryFrom.checkpoint?.mode==='CLOSED_PREFIX'){need(stableJSON(closedPrefixCheckpoint(db))===stableJSON(seed.checkpointReceipt),'carried_closed_prefix_mismatch');}
   else if(a.carryFrom.checkpoint?.mode==='INCOMPLETE_EPOCH'){const cp=seed.checkpointReceipt,expected=cp.paperCheckpoint.accountState;
    need(expected&&stableJSON(initial)===stableJSON(cp.account)&&expected.cashUSDC===initial.cashUSDC&&stableJSON(expected.shares)===stableJSON(initial.heldShares)&&expected.reservedBuyUSDC===initial.reservedBuyUSDC&&stableJSON(expected.reservedSellShares)===stableJSON(initial.reservedSellShares),'carried_checkpoint_account_mismatch');
    if(expected.settlements!==undefined)need(stableJSON(db.prepare('SELECT * FROM paper_execution_settlements ORDER BY rowid').all())===stableJSON(expected.settlements),'carried_checkpoint_settlements');
    const tables=[['orders','SELECT * FROM shadow_orders ORDER BY id'],['queues','SELECT * FROM paper_execution_queues ORDER BY token,side,price'],['trades','SELECT * FROM paper_execution_trades ORDER BY rowid'],['allocations','SELECT * FROM paper_execution_allocations ORDER BY rowid']];
    for(const [key,sql] of tables)need(stableJSON(db.prepare(sql!).all())===stableJSON(expected[key!]),'carried_checkpoint_state_mismatch:'+key);
    const cursors=db.prepare('SELECT * FROM paper_replay_cursor ORDER BY epoch').all();need(stableJSON(cursors)===stableJSON(cp.committedCursors),'carried_checkpoint_cursors');
    const cursor=db.prepare('SELECT * FROM paper_replay_cursor WHERE epoch=?').get(cp.paperCheckpoint.epoch);need(stableJSON(cursor)===stableJSON(cp.paperCheckpoint.committedCursor)&&Number.isSafeInteger((cursor as any)?.ordinal)&&Number.isSafeInteger((cursor as any)?.random_state),'carried_checkpoint_cursor');
    const closed=db.prepare('SELECT * FROM paper_consumed_epochs ORDER BY epoch DESC LIMIT 1').get() as any,modeled=db.prepare("SELECT * FROM paper_consumed_epochs WHERE disposition='MODELLED' ORDER BY epoch DESC LIMIT 1").get() as any;
    need(closed?.epoch===a.carryFrom.lastEpoch&&modeled?.epoch===a.carryFrom.checkpoint.lastModeledEpoch&&modeled.result_file===a.carryFrom.result.path&&modeled.result_sha===a.carryFrom.result.sha256,'carried_checkpoint_consumption');
   }else{need(seed.result?.terminal?.snapshot&&seed.result.terminal.snapshot.cashUSDC===initial.cashUSDC&&stableJSON(seed.result.terminal.snapshot.shares)===stableJSON(initial.heldShares)&&initial.reservedBuyUSDC==='0.000000000000000000'&&Object.values(initial.reservedSellShares).every(v=>decimal(v)===0n),'carried_result_account_mismatch');
    need((db.prepare("SELECT COUNT(*) n FROM shadow_orders WHERE status IN ('OPEN','PARTIAL','PENDING')").get() as any).n===0,'carried_open_orders');}
   immutable(seed.accountProof,{schema:'VERIFIED_INITIAL_CARRY_ACCOUNT_V1',carryFrom:a.carryFrom,account:initial,openingNotRepeated:true});}
  db.exec('CREATE TABLE IF NOT EXISTS paper_consumed_epochs(epoch INTEGER PRIMARY KEY,source_sha TEXT NOT NULL,result_file TEXT NOT NULL,result_sha TEXT NOT NULL,disposition TEXT NOT NULL)');

  const previous=db.prepare("SELECT * FROM paper_consumed_epochs WHERE disposition='MODELLED' ORDER BY epoch DESC LIMIT 1").get() as any;
  if(previous){need(hashFileSync(previous.result_file)===previous.result_sha,'published_epoch_changed');lastResult=retainedResultProjection(ownedJSON(previous.result_file));lastModeledEpoch=previous.epoch;lastResultPath=previous.result_file;}
  const lastClosed=db.prepare('SELECT * FROM paper_consumed_epochs ORDER BY epoch DESC LIMIT 1').get() as any;
  lastClosedEpoch=lastClosed?.epoch??a.carryFrom.lastEpoch;lastReceipt=lastClosed?.result_file??a.carryFrom.result.path;lastDisposition=lastClosed?.disposition??'CARRIED_CLOSED_ACCOUNT';
  payoutApplication=a.payoutRegistry?checkedPayoutApplication(db,a.payoutRegistry):null;
  if(existsSync(payoutReportFile))need(payoutApplication&&stableJSON(ownedJSON(payoutReportFile))===stableJSON(payoutApplication),'payout_application_conflict');
  else if(payoutApplication)immutable(payoutReportFile,payoutApplication);
  const standing=latestStandingPayout(db,a.outputDirectory);if(standing){payoutApplication=standing;payoutApplicationPath=standing.file;}
  payoutApplication=retainedApplicationProjection(payoutApplication);
  } catch(error) {
    const failure:any=error instanceof Error?error:new Error(String(error));
    let account:ReturnType<typeof exactAccount>|null=null,accountReadError:string|null=null,cursors:any[]|null=null,cursorReadError:string|null=null;
    try {account=exactAccount(db);}catch(readError){accountReadError=String(readError);}
    try {cursors=db.prepare('SELECT * FROM paper_replay_cursor ORDER BY epoch').all();}catch(readError){cursorReadError=String(readError);}
    const checkpoint={schema:'PAPER_FOLLOWER_STARTUP_CHECKPOINT_V2',status:'CHECKPOINTED_STARTUP_FAILURE',mode:FILL_PROTOCOL.mode,
      error:String(error),activeEpoch:null,account,accountReadError,committedCursors:cursors,cursorReadError,carryFrom:a.carryFrom,
      complete:false,modelNetPnlUSDC:null,actualRevenue:null,actualAccountChargesUSD:null,sourceCaptureDuplicated:false};
    failure.paperCheckpoint=checkpoint;
    try {immutable(path.join(a.outputDirectory,'failure-'+randomUUID()+'.json'),checkpoint);atomic(path.join(a.outputDirectory,'state.json'),checkpoint);}
    catch(writeError){failure.checkpointWriteError=String(writeError);}
    finally {try {db.close();}catch(closeError){failure.accountCloseError=String(closeError);}}
    throw failure;
  }
  let stopping=false,activeEpoch:number|null=null,cycles=0,lastState:any;
  const stop=()=>{stopping=true};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  const logger:any=Object.fromEntries(['info','warn','error','debug','trace','fatal'].map(level=>[level,(...args:any[])=>{if(level==='error'||level==='warn')console.log(JSON.stringify({level,args}))}]));
  const state=(status:string,extra:any={})=>{const account=exactAccount(db);
    const matches=(r:any)=>r?.terminal?.snapshot?.cashUSDC===account.cashUSDC&&stableJSON(r?.terminal?.snapshot?.shares)===stableJSON(account.heldShares)&&r?.terminal?.snapshot?.reservedBuyUSDC===account.reservedBuyUSDC&&stableJSON(r?.terminal?.snapshot?.reservedSellShares)===stableJSON(account.reservedSellShares);
    const valuation=matches(lastResult)?lastResult:matches(payoutApplication)?payoutApplication:null;
    const complete=valuation?.terminal?.accounting?.complete===true;
    lastState={schema:'CONSERVING_PAPER_FOLLOWER_STATE_V2',mode:FILL_PROTOCOL.mode,status,pid:process.pid,activeEpoch,
      heartbeatUTC:new Date().toISOString(),sourceRoot:a.sourceRoot,sourceCutover:a.sourceCutover??null,sourceCaptureDuplicated:false,...account,lastModeledEpoch,lastResultPath,lastClosedEpoch,lastReceipt,lastDisposition,
      sourceAsOfUTC:valuation?.terminal?.accounting?.valuationTs??lastResult?.terminal?.accounting?.valuationTs??null,complete,modelNetPnlUSDC:complete?valuation.terminal.accounting.netPnl:null,
      observedPayoutApplication:payoutApplication?{path:payoutApplicationPath,registry:payoutApplication.registry??null,policy:payoutApplication.policy??null,at:payoutApplication.at,costScenario:'paper-zero-redemption-cost-v1',actualGas:null,actualRedemption:null}:null,
      modeledFills:(db.prepare('SELECT COUNT(*) n FROM shadow_fills').get() as any).n,consumedEpochs:(db.prepare('SELECT COUNT(*) n FROM paper_consumed_epochs').get() as any).n,completedEpochs:(db.prepare("SELECT COUNT(*) n FROM paper_consumed_epochs WHERE disposition='MODELLED'").get() as any).n,skippedEpochs:(db.prepare("SELECT COUNT(*) n FROM paper_consumed_epochs WHERE disposition='SKIP_MODEL_SOURCE_INELIGIBLE'").get() as any).n,
      payoutRefresh:standingPayoutSummary(db),
      payoutRefreshQuarantine:db.prepare("SELECT 1 FROM sqlite_master WHERE name='paper_payout_refresh_quarantine'").get()?(db.prepare('SELECT payload_json FROM paper_payout_refresh_quarantine WHERE source_key=?').get(PAYOUT_SOURCE_KEY) as any)?.payload_json??null:null,
      actualRevenue:null,realizedVenueProfit:null,actualAccountChargesUSD:null,economicAdvantage:'NOT_ESTABLISHED',...extra};atomic(path.join(a.outputDirectory,'state.json'),lastState)};
  try{
    state('WAITING_CLOSED_SOURCE');while(!stopping&&(!dev?.maxCycles||cycles++<dev.maxCycles)){
      verifyCode();verifyPin(a.sourceAdmission);if(a.sourceCutover)verifyPin(a.sourceCutover.sourceAdmission);if(a.payoutRegistry)readPayoutRegistry(a.payoutRegistry);verifyFollowerKernelLock(a.outputDirectory);const disk=statfsSync(a.outputDirectory,{bigint:true});need(disk.bavail*disk.bsize>=8589934592n,'disk_reserve');
      if(a.standingPayoutRefresh&&!stopping)await refreshHeldPayouts(db,a,dev?.payoutClock?.()??Date.now(),dev?.runPayoutCommand);
      const roots=a.sourceCutover?[{root:a.sourceRoot,min:a.firstEpoch,max:a.sourceCutover.afterEpoch},{root:a.sourceCutover.sourceRoot,min:a.sourceCutover.afterEpoch+1,max:Infinity}]:[{root:a.sourceRoot,min:a.firstEpoch,max:Infinity}];
      const epochs=roots.flatMap(r=>readdirSync(r.root).filter(n=>/^epoch-\d{6}$/.test(n)).map(n=>Number(n.slice(6))).filter(n=>n>=r.min&&n<=r.max)).sort((x,y)=>x-y);
      const sourceRootFor=(n:number)=>a.sourceCutover&&n>a.sourceCutover.afterEpoch?a.sourceCutover.sourceRoot:a.sourceRoot;
      let advanced=false,expected=a.firstEpoch;
      for(const n of epochs){if(stopping)break;const epoch=path.join(sourceRootFor(n),'epoch-'+String(n).padStart(6,'0')),summaryFile=path.join(epoch,'epoch-summary.json');if(n>expected||!existsSync(summaryFile))break;
       const consumed=db.prepare('SELECT * FROM paper_consumed_epochs WHERE epoch=?').get(n) as any;
       if(consumed){need(hashFileSync(summaryFile)===consumed.source_sha&&hashFileSync(consumed.result_file)===consumed.result_sha,'consumed_epoch_changed');expected=n+1;continue;}
       activeEpoch=n;if(a.carryFrom.checkpoint?.mode==='INCOMPLETE_EPOCH'&&n===a.carryFrom.checkpoint.resumeEpoch){verifyPin(a.carryFrom.checkpoint.resumeSource.summary);verifyPin(a.carryFrom.checkpoint.resumeSource.ledger);}
       state('CHECKING_CLOSED_SOURCE');const eligibility=await structuralDisposition(epoch,config.topN);if(stopping)break;const sourceSha=eligibility.summarySha256;
       if(a.sourceCutover&&n===a.sourceCutover.afterEpoch+1){
        const priorEpoch=path.join(a.sourceRoot,'epoch-'+String(a.sourceCutover.afterEpoch).padStart(6,'0'));
        const prior=db.prepare('SELECT * FROM paper_consumed_epochs WHERE epoch=?').get(a.sourceCutover.afterEpoch) as any;need(prior&&hashFileSync(path.join(priorEpoch,'epoch-summary.json'))===prior.source_sha,'follower_cutover_prior');
        const old=await structuralDisposition(priorEpoch,config.topN),oldLedger=ownedJSON(path.join(priorEpoch,'source/ledger.json')),nextLedger=ownedJSON(path.join(epoch,'source/ledger.json'));
        verifyPin(a.sourceAdmission);verifyPin(a.sourceCutover.sourceAdmission);
        const core=new PaperMakerExecution(db,FILL_POLICY,()=>nextLedger.startedAt);
        core.beginSourceClockOrigin({fromAdmissionSha256:a.sourceAdmission.sha256,toAdmissionSha256:a.sourceCutover.sourceAdmission.sha256,afterEpoch:a.sourceCutover.afterEpoch,firstEpoch:n,oldFinalReceipt:oldLedger.termination.at,newFirstReceipt:nextLedger.startedAt,oldSummarySha256:old.summarySha256,newLedgerSha256:eligibility.ledgerSha256});
        if(a.payoutRegistry){const registry=readPayoutRegistry(a.payoutRegistry);need(registry.observedReceiptUTC<=nextLedger.startedAt.utc,'payout_registry_not_yet_observed');
          db.exec(`CREATE TABLE IF NOT EXISTS paper_replay_payout_application(registry_sha TEXT PRIMARY KEY,payload_sha TEXT NOT NULL,payload_json TEXT NOT NULL);
            CREATE TRIGGER IF NOT EXISTS paper_replay_payout_application_update BEFORE UPDATE ON paper_replay_payout_application BEGIN SELECT RAISE(ABORT,'fill_paper:immutable_payout_application'); END;
            CREATE TRIGGER IF NOT EXISTS paper_replay_payout_application_delete BEFORE DELETE ON paper_replay_payout_application BEGIN SELECT RAISE(ABORT,'fill_paper:immutable_payout_application'); END;`);
          let retained=db.prepare('SELECT * FROM paper_replay_payout_application WHERE registry_sha=?').get(a.payoutRegistry.sha256) as any;
          if(!retained){
            need(!existsSync(payoutReportFile)&&!db.prepare('SELECT 1 FROM paper_replay_cursor WHERE epoch=?').get(epoch),'payout_application_missing_custody');
            db.transaction(()=>{for(const entry of registry.entries){const prior=db.prepare('SELECT 1 FROM paper_execution_settlements WHERE token=?').get(entry.token),position=db.prepare('SELECT shares FROM paper_execution_positions WHERE token=?').get(entry.token) as any;
              if(prior||position&&BigInt(position.shares)>0n)core.settleBinaryHolding({...entry,at:nextLedger.startedAt,observedReceiptUTC:registry.observedReceiptUTC,registrySha256:a.payoutRegistry!.sha256,sourceResultSha256:registry.sourceResult.sha256,sourceReviewSha256:registry.sourceReview.sha256,costScenario:registry.costScenario});
            }
              const applied={schema:'PAPER_OBSERVED_PAYOUT_APPLICATION_V2',registry:a.payoutRegistry,at:nextLedger.startedAt,terminal:core.terminalReport({valuationTs:nextLedger.startedAt.utc,asOfReceiptTs:nextLedger.startedAt.utc}),canonicalPrefix:db.prepare('SELECT * FROM accounting_events ORDER BY id').all(),costScenario:'paper-zero-redemption-cost-v1',actualGas:null,actualRedemption:null,actualRevenue:null};
              const payload=JSON.stringify(applied);db.prepare('INSERT INTO paper_replay_payout_application VALUES(?,?,?)').run(a.payoutRegistry!.sha256,hash(payload),payload);
            })();
            retained=db.prepare('SELECT * FROM paper_replay_payout_application WHERE registry_sha=?').get(a.payoutRegistry.sha256) as any;
          }
          const applied=checkedPayoutApplication(db,a.payoutRegistry,nextLedger.startedAt);need(applied,'payout_application_custody');
          if(existsSync(payoutReportFile))need(stableJSON(ownedJSON(payoutReportFile))===stableJSON(applied),'payout_application_conflict');else immutable(payoutReportFile,applied);payoutApplication=retainedApplicationProjection(applied);
        }
       }
       if(a.standingPayoutRefresh&&!db.prepare('SELECT 1 FROM paper_replay_cursor WHERE epoch=?').get(epoch)){const applied=applyStandingPayouts(db,a,ownedJSON(path.join(epoch,'source/ledger.json')).startedAt);if(applied){payoutApplication=retainedApplicationProjection(applied);payoutApplicationPath=applied.file;}}
       const report=path.join(a.outputDirectory,'epoch-'+String(n).padStart(6,'0')+'.json');let result:any,disposition:string;
       if(eligibility.reason){disposition='SKIP_MODEL_SOURCE_INELIGIBLE';result={schema:'PAPER_FOLLOWER_SOURCE_INELIGIBLE_V1',disposition,epoch,reason:eligibility.reason,detail:eligibility.detail,source:eligibility,
         accountUnchanged:exactAccount(db),modelNetPnlUSDC:null,reward:null,actualRevenue:null,sourceCaptureDuplicated:false};}
       else{disposition='MODELLED';state('REPLAYING_CLOSED_SOURCE');dev?.beforeReplay?.(n);result=await replayPaperEpoch(epoch,db,config,logger,{afterCommit:state=>dev?.afterReplayCommit?.(n,state)});}
       result.sourceClockOrigins=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_execution_clock_origins'").get()?db.prepare('SELECT payload FROM paper_execution_clock_origins ORDER BY sequence').all().map((r:any)=>JSON.parse(r.payload)):[];
       verifyCode();need(hashFileSync(summaryFile)===sourceSha,'closed_source_mutated');
       if(existsSync(report)){const original=ownedJSON(report);need(stableJSON(economicProjection(original))===stableJSON(economicProjection(result)),'existing_epoch_projection_conflict');}
       else immutable(report,result);
       dev?.afterReportPublished?.(n);db.prepare('INSERT INTO paper_consumed_epochs VALUES(?,?,?,?,?)').run(n,sourceSha,report,hashFileSync(report),disposition);
       if(disposition==='MODELLED'){lastResult=retainedResultProjection(ownedJSON(report));lastModeledEpoch=n;lastResultPath=report;}
       lastClosedEpoch=n;lastReceipt=report;lastDisposition=disposition;
       state(disposition==='MODELLED'?'COMPLETED_EPOCH':'SKIPPED_MODEL_SOURCE_INELIGIBLE',{lastDisposition:disposition,lastClosedEpoch:n,lastReceipt:report,sourceBoundary:result.sourceBoundary??null});advanced=true;expected=n+1;
       if(a.standingPayoutRefresh&&!stopping)await refreshHeldPayouts(db,a,dev?.payoutClock?.()??Date.now(),dev?.runPayoutCommand);
      }
      activeEpoch=null;if(!advanced)state('WAITING_CLOSED_SOURCE');if(!stopping&&(!dev?.maxCycles||cycles<dev.maxCycles))await(dev?.wait?.(3000)??new Promise(r=>setTimeout(r,3000)));
    }
    if(stopping)state('STOPPED');return lastState;
  }catch(error){const checkpoint={schema:'PAPER_FOLLOWER_RECOVERABLE_FAILURE_V2',activeEpoch,error:String(error),paperCheckpoint:(error as any)?.paperCheckpoint??null,
      account:exactAccount(db),committedCursors:db.prepare('SELECT * FROM paper_replay_cursor ORDER BY epoch').all(),lastModeledEpoch,actualRevenue:null,modelNetPnlUSDC:null,complete:false};
    immutable(path.join(a.outputDirectory,'failure-'+randomUUID()+'.json'),checkpoint);state('CHECKPOINTED_FAILURE',{error:String(error),failureCheckpoint:checkpoint,committedCursors:checkpoint.committedCursors,modelNetPnlUSDC:null,complete:false});throw error;
  }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);db.close();}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const p = process.argv.indexOf('--admission'); need(p >= 0 && process.argv[p + 1], 'admission_argument_required');
  const execution = process.argv.includes('--follow') ? runPaperFollower(process.argv[p + 1]!) : runFrozenPaperReplay(process.argv[p + 1]!).then(r => console.log(JSON.stringify({ mode: r.mode, sourceBoundary: r.sourceBoundary, cash: r.terminal.snapshot.cashUSDC, fills: r.fills.length, economicAdvantage: r.economicAdvantage })));
  execution.catch(e => { console.error(e); process.exitCode = 1; });
}
