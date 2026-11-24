/** Source-bound causal paper replay. No gateway, source subscription, or forced fills. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
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
  schema: 'CONSERVING_CAUSAL_CAPTURE_PAPER_V1', mode: 'CAUSAL_CAPTURE_REPLAY_PAPER',
  policy: FILL_POLICY, quoteIntervalMs: 1000, ttlMs: 5000, seed: 3737,
  queue: 'Conservative per-arrival cohorts: same-clock/source initial orders share displayed ahead; later arrivals inherit max visible/prior unconsumed external barrier. Pending visible-depth maxima and last causally known fresh book validate +100ms activation. Crossed/stale activation is rejected without retrospective uncrossing. Only opposite same-price prints deplete barriers and own FIFO orders; one conserved print budget.',
  duplicates: 'Existing source decoder refuses ambiguous repeated original trade tuples; identical committed trade id is a no-op; changed economics fails',
  timing: 'Recorded callback order; submit100ms, cancel0ms are model assumptions, not venue latency measurements',
  fills: 'SIMULATED, supported by original-token public prints under the named queue model; never observed maker execution',
  ordinaryPolicy: 'Existing MakerLoop, canonical features/microstructure belief/regime; funded bids and held-inventory asks',
  fee: 'Named zero-maker-fee paper scenario; rebate0; no claimed paid fee or actual revenue',
  terminal: 'Cancel unfilled remainder, preserve held inventory/cash; fresh model marks or null/bounds; never flatten or reset',
  markoutHorizonsMs: [1000, 5000, 30000], markoutMaximumDelayMs: 1000,
  inference: 'Engineering and model-defined paper accounting only; no novelty, discovery, learning, unseen transfer, or economic advantage',
} as const;

export function applyOriginalPrint(execution: PaperMakerExecution, event: any, identity: { token: string; condition: string }, at: PaperClock) {
  if (event.event_type !== 'last_trade_price' || event.asset_id !== identity.token || event.market !== identity.condition) return null;
  const sourceId = hash(JSON.stringify([identity.token, Number(event.timestamp), event.side, decimal(event.price).toString(), decimal(event.size).toString(), event.transaction_hash ?? null]));
  return execution.processTrade({ sourceId, token: identity.token, side: event.side, price: String(event.price), size: String(event.size), at, venueUtc: Number(event.timestamp) });
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
    } catch (error) { this.gate.dispose(); throw error; }
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
  close() { try { this.engine.stop(); } finally { this.gate.dispose(); } }
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
  let sourceBoundary: string | null = null, withheldSamples = 0;
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
    const book = fullBook.observation(d);
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
          // A later book in the same delivered array cannot validate an earlier trade.
          let tradeSeen = false;
          if (events.some((e: any) => { if (e.event_type === 'last_trade_price') tradeSeen = true;
            return tradeSeen && (e.event_type === 'book' || e.event_type === 'price_change'); })) {
            sourceBoundary = 'MODEL_INAPPLICABLE_LATER_BOOK_IN_TRADE_FRAME';
            await commit(() => { session!.cancelAll(at); db.prepare('UPDATE latest_features SET mid=NULL').run(); }); break;
          }
          for (const e of events) fullBook.process(e, d.identity.token);
          const book = fullBook.observation(d);
          const observe = () => { if (book && status.fresh && !status.bookInvalidation) session!.execution.observeBook(book); };
          await commit(() => {
            observe();
            if (!status.fresh || status.bookInvalidation || !book) { session!.cancelAll(at); return; }
            for (const e of events) applyOriginalPrint(session!.execution, e, d.identity, at);
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
      sourceBoundary, wireFrameCount, frameCount, samplesApplied: sampleIndex, withheldSamples,
      frozenSourceLedgerSha256: hash(readFileSync(path.join(epoch, 'source/ledger.json'))),
      terminal, markouts, terminalNoSettlementPnlBoundsUSDC: {
        lower: cashText(exactCash - 100n * SCALE * SCALE), upper: cashText(exactCash + held * SCALE - 100n * SCALE * SCALE),
        meaning: 'Model cash plus binary holdings valued in [0,1]; not a settlement forecast or realized profit' },
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
  for (const [p, digest] of Object.entries({ ...admission.codeSha256, ...admission.source.files })) need(hash(readFileSync(p)) === digest, 'frozen_input_changed:' + p);
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

type FollowerAdmission = { schema: 'CONSERVING_PAPER_FOLLOWER_ADMISSION_V1'; protocolSha256: string;
  codeSha256: Record<string,string>; sourceRoot: string; firstEpoch: number; sourceAdmission: { path: string; sha256: string };
  outputDirectory: string; reviewFile: string; reviewSha256: string };
const atomic = (file: string, value: unknown) => {
  const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, file);
};
/** One ordinary counterfactual account follows new CLOSED captures; it never starts a capture connection. */
export async function runPaperFollower(admissionFile: string) {
  const raw = readFileSync(admissionFile), a: FollowerAdmission = JSON.parse(raw.toString());
  need(a.schema === 'CONSERVING_PAPER_FOLLOWER_ADMISSION_V1' && a.protocolSha256 === hash(JSON.stringify(FILL_PROTOCOL)), 'follower_protocol');
  need(Number.isSafeInteger(a.firstEpoch) && a.firstEpoch >= 1 && realpathSync(a.sourceRoot) === a.sourceRoot, 'follower_source');
  need(hash(readFileSync(a.sourceAdmission.path)) === a.sourceAdmission.sha256, 'source_owner_admission_changed');
  const reviewRaw = readFileSync(a.reviewFile); need(hash(reviewRaw) === a.reviewSha256, 'follower_review_hash');
  const review = JSON.parse(reviewRaw.toString());
  need(review.decision === 'APPROVE_CONSERVING_CAPTURE_FOLLOWER_PAPER_OPERATION' && review.protocolSha256 === a.protocolSha256
    && review.sourceRoot === a.sourceRoot && review.firstEpoch === a.firstEpoch && review.outputDirectory === a.outputDirectory
    && JSON.stringify(review.codeSha256) === JSON.stringify(a.codeSha256) && JSON.stringify(review.sourceAdmission) === JSON.stringify(a.sourceAdmission), 'follower_review');
  const verifyCode = () => { for (const [p, digest] of Object.entries(a.codeSha256)) need(hash(readFileSync(p)) === digest, 'follower_code_drift:' + p); };
  verifyCode(); mkdirSync(a.outputDirectory, { recursive: true, mode: 0o700 });
  const frozen = path.join(a.outputDirectory, 'frozen-admission.json');
  if (existsSync(frozen)) need(readFileSync(frozen).equals(raw), 'follower_restart_admission'); else writeFileSync(frozen, raw, { flag: 'wx', mode: 0o600 });
  const lockPath = path.join(ROOT, 'reports/evidence/maker-fill-paper-account.lock');
  need(process.env.PAPER_FILL_LOCK_PATH === lockPath && Number(process.env.PAPER_FILL_LOCK_FD) >= 3, 'follower_kernel_lock_required');
  const db = createPaperDatabase(path.join(a.outputDirectory, 'paper.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS paper_consumed_epochs(epoch INTEGER PRIMARY KEY,source_sha TEXT NOT NULL,result_file TEXT NOT NULL)');
  const config = JSON.parse(readFileSync(path.join(ROOT, 'configs/worker.json'), 'utf8'));
  let stopping = false, activeEpoch: number | null = null;
  const stop = () => { stopping = true; }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const logger: any = Object.fromEntries(['info','warn','error','debug','trace','fatal'].map(level => [level, (...args: any[]) => {
    // Compact diagnostics only. Full money/source provenance remains in the account/epoch receipts.
    if (level === 'error' || level === 'warn') console.log(JSON.stringify({ level, args }));
  }]));
  const state = (status: string, extra: any = {}) => atomic(path.join(a.outputDirectory, 'state.json'), {
    schema: 'CONSERVING_PAPER_FOLLOWER_STATE_V1', mode: FILL_PROTOCOL.mode, status, pid: process.pid,
    activeEpoch, heartbeatUTC: new Date().toISOString(), sourceRoot: a.sourceRoot, sourceCaptureDuplicated: false,
    modeledFills: (db.prepare('SELECT COUNT(*) n FROM shadow_fills').get() as any).n,
    completedEpochs: (db.prepare('SELECT COUNT(*) n FROM paper_consumed_epochs').get() as any).n,
    actualRevenue: null, realizedVenueProfit: null, actualAccountChargesUSD: null, economicAdvantage: 'NOT_ESTABLISHED', ...extra,
  });
  try {
    state('WAITING_CLOSED_SOURCE');
    while (!stopping) {
      verifyCode(); const disk = statfsSync(a.outputDirectory, { bigint: true }); need(disk.bavail * disk.bsize >= 8_589_934_592n, 'disk_reserve');
      const epochs = readdirSync(a.sourceRoot).filter(n => /^epoch-\d{6}$/.test(n)).map(n => Number(n.slice(6))).filter(n => n >= a.firstEpoch).sort((x,y) => x-y);
      let advanced = false;
      for (const n of epochs) {
        if (stopping) break;
        if (db.prepare('SELECT 1 FROM paper_consumed_epochs WHERE epoch=?').get(n)) continue;
        const epoch = path.join(a.sourceRoot, 'epoch-' + String(n).padStart(6,'0')), summaryFile = path.join(epoch, 'epoch-summary.json');
        if (!existsSync(summaryFile)) break; // Never overtake an owned capture still being written.
        activeEpoch = n; state('REPLAYING_CLOSED_SOURCE');
        const sourceSha = hash(readFileSync(summaryFile)), report = path.join(a.outputDirectory, 'epoch-' + String(n).padStart(6,'0') + '.json');
        const result = await replayPaperEpoch(epoch, db, config, logger);
        verifyCode(); need(hash(readFileSync(summaryFile)) === sourceSha, 'closed_source_mutated');
        atomic(report, result);
        db.prepare('INSERT INTO paper_consumed_epochs VALUES(?,?,?)').run(n, sourceSha, report);
        state('COMPLETED_EPOCH', { lastResult: report, cashUSDC: result.terminal.snapshot.cashUSDC, heldShares: result.terminal.snapshot.shares,
          modelNetPnlUSDC: result.terminal.accounting.netPnl, complete: result.terminal.accounting.complete, sourceBoundary: result.sourceBoundary });
        advanced = true;
      }
      activeEpoch = null; if (!advanced) state('WAITING_CLOSED_SOURCE');
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 3000));
    }
    state('STOPPED');
  } catch (error) { state('CHECKPOINTED_FAILURE', { error: String(error), paperCheckpoint: (error as any)?.paperCheckpoint ?? null, modelNetPnlUSDC: null, complete: false }); throw error; }
  finally { process.off('SIGINT',stop); process.off('SIGTERM',stop); db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const p = process.argv.indexOf('--admission'); need(p >= 0 && process.argv[p + 1], 'admission_argument_required');
  const execution = process.argv.includes('--follow') ? runPaperFollower(process.argv[p + 1]!) : runFrozenPaperReplay(process.argv[p + 1]!).then(r => console.log(JSON.stringify({ mode: r.mode, sourceBoundary: r.sourceBoundary, cash: r.terminal.snapshot.cashUSDC, fills: r.fills.length, economicAdvantage: r.economicAdvantage })));
  execution.catch(e => { console.error(e); process.exitCode = 1; });
}
