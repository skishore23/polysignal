/** Source-bound causal paper replay. No gateway, source subscription, or forced fills. */
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, createReadStream, existsSync, fstatSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
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
  schema: 'CONSERVING_CAUSAL_CAPTURE_PAPER_V2', mode: 'CAUSAL_CAPTURE_REPLAY_PAPER',
  policy: FILL_POLICY, quoteIntervalMs: 1000, ttlMs: 5000, seed: 3737,
  queue: 'Conservative per-arrival cohorts: same-clock/source initial orders share displayed ahead; later arrivals inherit max visible/prior unconsumed external barrier. Pending visible-depth maxima and last causally known fresh book validate +100ms activation. Crossed/stale activation is rejected without retrospective uncrossing. Only opposite same-price prints deplete barriers and own FIFO orders; one conserved print budget.',
  duplicates: 'Existing source decoder refuses ambiguous repeated original trade tuples; identical committed trade id is a no-op; changed economics fails',
  timing: 'Recorded callback order; submit100ms, cancel0ms are model assumptions, not venue latency measurements',
  clockRoles: 'Activation-book receipt <= activation <= eligible print venue <= print receipt. Independently fresh current book may have a later venue timestamp; it cannot retroactively certify activation. Keep per-print venue watermark, UTC/monotonic activation, expiry and cancellation guards.',
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
      sourceBoundary, wireFrameCount, frameCount, samplesApplied: sampleIndex, withheldSamples, invalidSourceFrames,
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


type FilePin = {path:string;sha256:string};
export type FollowerCarry = {database:FilePin;result:FilePin;review:FilePin;lastEpoch:number};
export type FollowerAdmission = {schema:'CONSERVING_PAPER_FOLLOWER_ADMISSION_V2';protocolSha256:string;
  inputMode:'CLOSED_CAPTURE_FOLLOWER'|'AUTHORED_OFFLINE_FIXTURE';codeSha256:Record<string,string>;
  sourceRoot:string;firstEpoch:number;sourceAdmission:FilePin;carryFrom:FollowerCarry;
  outputDirectory:string;reviewFile:string;reviewSha256:string};
export const FOLLOWER_PROTOCOL={schema:'CONSERVING_PAPER_FOLLOWER_DRIVER_V2',paper:FILL_PROTOCOL,
  account:'mandatory independently checked closed seed; copy once, preserve exact cash/holdings/cursor, no refund or reset',
  reports:'immutable per-epoch receipts, restart compares complete source/economic projection excluding measured resources only',
  selection:'all ascending closed captures from last carried epoch+1; explicit structural-ineligible receipts are not rewards',
  waiting:'retain last source-as-of account/valuation, incomplete PnL remains null',sourceCaptureDuplicated:false} as const;
function regularPin(pin:FilePin){need(pin&&typeof pin.path==='string'&&/^[a-f0-9]{64}$/.test(pin.sha256),'file_pin');
  need(realpathSync(pin.path)===path.resolve(pin.path)&&lstatSync(pin.path).isFile()&&!lstatSync(pin.path).isSymbolicLink(),'file_pin_identity');
  const raw=readFileSync(pin.path);need(hash(raw)===pin.sha256,'file_pin_changed:'+pin.path);return raw;}
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
   }catch(error){const message=String(error);const known=['fill_paper:original_market_missing','maker_source:validated_initial_snapshot_unavailable','maker_source:validated_rest_tick_mismatch','maker_source:tick_or_minimum','maker_source:book_market_limits'];
    if(known.some(x=>message==='Error: '+x)){reason='STRUCTURAL_SOURCE_TERMS_INELIGIBLE';detail=message;}else throw error;
   }}
  if(!reason&&archive.messages===0)reason='NO_DATA_STREAM';
  return {reason,detail,archive,summarySha256:hash(readFileSync(path.join(epoch,'epoch-summary.json'))),ledgerSha256:hash(readFileSync(path.join(epoch,'source/ledger.json')))};
}
function seedFollower(a:FollowerAdmission){
  need(a.carryFrom&&Number.isSafeInteger(a.carryFrom.lastEpoch)&&a.carryFrom.lastEpoch>=1&&a.firstEpoch===a.carryFrom.lastEpoch+1,'follower_carry_lineage');
  const seedRaw=regularPin(a.carryFrom.database),resultRaw=regularPin(a.carryFrom.result),review=JSON.parse(regularPin(a.carryFrom.review).toString());
  const result=JSON.parse(resultRaw.toString());need(result.schema==='CONSERVING_PAPER_EPOCH_RESULT_V1'&&result.epoch===path.join(a.sourceRoot,'epoch-'+String(a.carryFrom.lastEpoch).padStart(6,'0')),'follower_carry_result_lineage');
  need(review.decision==='APPROVE_PAPER_FOLLOWER_CARRY_FROM_CLOSED_ACCOUNT'&&review.databaseClosed===true&&review.lastEpoch===a.carryFrom.lastEpoch&&review.paperProtocolSha256===hash(JSON.stringify(FILL_PROTOCOL))
    &&stableJSON(review.database)===stableJSON(a.carryFrom.database)&&stableJSON(review.result)===stableJSON(a.carryFrom.result),'follower_carry_review');
  for(const suffix of ['-wal','-journal'])need(!existsSync(a.carryFrom.database.path+suffix)||statSync(a.carryFrom.database.path+suffix).size===0,'seed_database_not_closed');
  const file=path.join(a.outputDirectory,'paper.sqlite'),receipt=path.join(a.outputDirectory,'carry-receipt.json');
  if(!existsSync(file)){need(!existsSync(receipt),'seed_database_missing');const tmp=file+'.'+randomUUID()+'.seed';copyFileSync(a.carryFrom.database.path,tmp,constants.COPYFILE_EXCL);
    const fd=openSync(tmp,'r');try{fsyncSync(fd)}finally{closeSync(fd)}need(hash(readFileSync(tmp))===a.carryFrom.database.sha256&&hash(seedRaw)===a.carryFrom.database.sha256,'seed_copy_changed');renameSync(tmp,file);syncDirectory(a.outputDirectory);}
  if(existsSync(receipt)){need(stableJSON(ownedJSON(receipt).carryFrom)===stableJSON(a.carryFrom),'carry_receipt_changed');}
  else {need(hash(readFileSync(file))===a.carryFrom.database.sha256,'unreceipted_seed_changed');immutable(receipt,{schema:'PAPER_FOLLOWER_CARRY_RECEIPT_V1',carryFrom:a.carryFrom,genesisNotRepeated:true});}
  const bank=lstatSync(file),original=statSync(a.carryFrom.database.path);need(bank.isFile()&&!bank.isSymbolicLink()&&bank.nlink===1&&!(bank.dev===original.dev&&bank.ino===original.ino),'carried_database_identity');
  const accountProof=path.join(a.outputDirectory,'carry-account-proof.json');
  if(existsSync(accountProof))need(stableJSON(ownedJSON(accountProof).carryFrom)===stableJSON(a.carryFrom),'carry_account_proof_changed');
  else need(hash(readFileSync(file))===a.carryFrom.database.sha256,'unverified_carried_account_changed');
  return {file,result,accountProof,needsAccountProof:!existsSync(accountProof)};
}
/** Follows closed captures only. It never starts a source connection or funds a new account. */
export async function runPaperFollower(admissionFile:string,dev?:{maxCycles?:number;wait?:(ms:number)=>Promise<void>;afterReportPublished?:(epoch:number)=>void;beforeReplay?:(epoch:number)=>void}){
  const raw=readFileSync(admissionFile),a:FollowerAdmission=JSON.parse(raw.toString());
  need(a.schema==='CONSERVING_PAPER_FOLLOWER_ADMISSION_V2'&&a.protocolSha256===hash(JSON.stringify(FOLLOWER_PROTOCOL)),'follower_protocol');
  need(['CLOSED_CAPTURE_FOLLOWER','AUTHORED_OFFLINE_FIXTURE'].includes(a.inputMode)&&(!dev||a.inputMode==='AUTHORED_OFFLINE_FIXTURE'),'follower_input_mode');
  if(dev?.maxCycles!==undefined)need(Number.isSafeInteger(dev.maxCycles)&&dev.maxCycles>0,'fixture_cycles');
  need(Number.isSafeInteger(a.firstEpoch)&&a.firstEpoch>=1&&realpathSync(a.sourceRoot)===a.sourceRoot,'follower_source');regularPin(a.sourceAdmission);
  const review=JSON.parse(regularPin({path:a.reviewFile,sha256:a.reviewSha256}).toString());
  need(review.decision==='APPROVE_CONSERVING_CAPTURE_FOLLOWER_PAPER_OPERATION'&&review.protocolSha256===a.protocolSha256&&review.inputMode===a.inputMode
    &&review.sourceRoot===a.sourceRoot&&review.firstEpoch===a.firstEpoch&&review.outputDirectory===a.outputDirectory&&stableJSON(review.codeSha256)===stableJSON(a.codeSha256)
    &&stableJSON(review.sourceAdmission)===stableJSON(a.sourceAdmission)&&stableJSON(review.carryFrom)===stableJSON(a.carryFrom),'follower_review');
  need(!a.outputDirectory.startsWith(a.sourceRoot+path.sep)&&!a.sourceRoot.startsWith(a.outputDirectory+path.sep)&&a.sourceRoot!==a.outputDirectory,'follower_source_output_overlap');
  for(const required of ['scripts/research/maker_fill_paper.ts','apps/worker/src/shadow/PaperMakerExecution.ts'])need(Object.keys(a.codeSha256).some(p=>path.resolve(p)===path.join(ROOT,required)),'follower_required_code_pin');
  const verifyCode=()=>{for(const [p,h] of Object.entries(a.codeSha256))need(hash(readFileSync(p))===h,'follower_code_drift:'+p)};
  verifyCode();verifyFollowerKernelLock(a.outputDirectory);mkdirSync(a.outputDirectory,{recursive:true,mode:0o700});need(realpathSync(a.outputDirectory)===a.outputDirectory,'follower_output_alias');
  const frozen=path.join(a.outputDirectory,'frozen-admission.json');if(existsSync(frozen)){ownedJSON(frozen);need(readFileSync(frozen).equals(raw),'follower_restart_admission');}else {const fd=openSync(frozen,'wx',0o600);try{writeFileSync(fd,raw);fsyncSync(fd)}finally{closeSync(fd)}syncDirectory(a.outputDirectory);}
  const seed=seedFollower(a),db=createPaperDatabase(seed.file);
  let config:any,lastResult:any,lastModeledEpoch=a.carryFrom.lastEpoch,lastResultPath=a.carryFrom.result.path;
  let lastClosedEpoch=a.carryFrom.lastEpoch,lastReceipt=a.carryFrom.result.path,lastDisposition='CARRIED_CLOSED_ACCOUNT';
  try {
  config=JSON.parse(readFileSync(path.join(ROOT,'configs/worker.json'),'utf8'));
  lastResult=seed.result;
  if(seed.needsAccountProof){const initial=exactAccount(db);need(seed.result?.terminal?.snapshot&&seed.result.terminal.snapshot.cashUSDC===initial.cashUSDC&&stableJSON(seed.result.terminal.snapshot.shares)===stableJSON(initial.heldShares)&&initial.reservedBuyUSDC==='0.000000000000000000'&&Object.values(initial.reservedSellShares).every(v=>decimal(v)===0n),'carried_result_account_mismatch');
  need((db.prepare("SELECT COUNT(*) n FROM shadow_orders WHERE status IN ('OPEN','PARTIAL','PENDING')").get() as any).n===0,'carried_open_orders');
   immutable(seed.accountProof,{schema:'VERIFIED_INITIAL_CARRY_ACCOUNT_V1',carryFrom:a.carryFrom,account:initial,openingNotRepeated:true});}
  db.exec('CREATE TABLE IF NOT EXISTS paper_consumed_epochs(epoch INTEGER PRIMARY KEY,source_sha TEXT NOT NULL,result_file TEXT NOT NULL,result_sha TEXT NOT NULL,disposition TEXT NOT NULL)');

  const previous=db.prepare("SELECT * FROM paper_consumed_epochs WHERE disposition='MODELLED' ORDER BY epoch DESC LIMIT 1").get() as any;
  if(previous){need(hash(readFileSync(previous.result_file))===previous.result_sha,'published_epoch_changed');lastResult=ownedJSON(previous.result_file);lastModeledEpoch=previous.epoch;lastResultPath=previous.result_file;}
  const lastClosed=db.prepare('SELECT * FROM paper_consumed_epochs ORDER BY epoch DESC LIMIT 1').get() as any;
  lastClosedEpoch=lastClosed?.epoch??a.carryFrom.lastEpoch;lastReceipt=lastClosed?.result_file??a.carryFrom.result.path;lastDisposition=lastClosed?.disposition??'CARRIED_CLOSED_ACCOUNT';
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
    const valuationMatches=lastResult?.terminal?.snapshot?.cashUSDC===account.cashUSDC&&stableJSON(lastResult?.terminal?.snapshot?.shares)===stableJSON(account.heldShares)&&lastResult?.terminal?.snapshot?.reservedBuyUSDC===account.reservedBuyUSDC;
    const complete=valuationMatches&&lastResult?.terminal?.accounting?.complete===true;
    lastState={schema:'CONSERVING_PAPER_FOLLOWER_STATE_V2',mode:FILL_PROTOCOL.mode,status,pid:process.pid,activeEpoch,
      heartbeatUTC:new Date().toISOString(),sourceRoot:a.sourceRoot,sourceCaptureDuplicated:false,...account,lastModeledEpoch,lastResultPath,lastClosedEpoch,lastReceipt,lastDisposition,
      sourceAsOfUTC:lastResult?.terminal?.accounting?.valuationTs??null,complete,modelNetPnlUSDC:complete?lastResult.terminal.accounting.netPnl:null,
      modeledFills:(db.prepare('SELECT COUNT(*) n FROM shadow_fills').get() as any).n,consumedEpochs:(db.prepare('SELECT COUNT(*) n FROM paper_consumed_epochs').get() as any).n,completedEpochs:(db.prepare("SELECT COUNT(*) n FROM paper_consumed_epochs WHERE disposition='MODELLED'").get() as any).n,skippedEpochs:(db.prepare("SELECT COUNT(*) n FROM paper_consumed_epochs WHERE disposition='SKIP_MODEL_SOURCE_INELIGIBLE'").get() as any).n,
      actualRevenue:null,realizedVenueProfit:null,actualAccountChargesUSD:null,economicAdvantage:'NOT_ESTABLISHED',...extra};atomic(path.join(a.outputDirectory,'state.json'),lastState)};
  try{
    state('WAITING_CLOSED_SOURCE');while(!stopping&&(!dev?.maxCycles||cycles++<dev.maxCycles)){
      verifyCode();verifyFollowerKernelLock(a.outputDirectory);const disk=statfsSync(a.outputDirectory,{bigint:true});need(disk.bavail*disk.bsize>=8589934592n,'disk_reserve');
      const epochs=readdirSync(a.sourceRoot).filter(n=>/^epoch-\d{6}$/.test(n)).map(n=>Number(n.slice(6))).filter(n=>n>=a.firstEpoch).sort((x,y)=>x-y);
      let advanced=false,expected=a.firstEpoch;
      for(const n of epochs){if(stopping)break;const epoch=path.join(a.sourceRoot,'epoch-'+String(n).padStart(6,'0')),summaryFile=path.join(epoch,'epoch-summary.json');if(n>expected||!existsSync(summaryFile))break;
       const consumed=db.prepare('SELECT * FROM paper_consumed_epochs WHERE epoch=?').get(n) as any;
       if(consumed){need(hash(readFileSync(summaryFile))===consumed.source_sha&&hash(readFileSync(consumed.result_file))===consumed.result_sha,'consumed_epoch_changed');expected=n+1;continue;}
       activeEpoch=n;state('CHECKING_CLOSED_SOURCE');const eligibility=await structuralDisposition(epoch,config.topN);if(stopping)break;const sourceSha=eligibility.summarySha256;
       const report=path.join(a.outputDirectory,'epoch-'+String(n).padStart(6,'0')+'.json');let result:any,disposition:string;
       if(eligibility.reason){disposition='SKIP_MODEL_SOURCE_INELIGIBLE';result={schema:'PAPER_FOLLOWER_SOURCE_INELIGIBLE_V1',disposition,epoch,reason:eligibility.reason,detail:eligibility.detail,source:eligibility,
         accountUnchanged:exactAccount(db),modelNetPnlUSDC:null,reward:null,actualRevenue:null,sourceCaptureDuplicated:false};}
       else{disposition='MODELLED';state('REPLAYING_CLOSED_SOURCE');dev?.beforeReplay?.(n);result=await replayPaperEpoch(epoch,db,config,logger);}
       verifyCode();need(hash(readFileSync(summaryFile))===sourceSha,'closed_source_mutated');
       if(existsSync(report)){const original=ownedJSON(report);need(stableJSON(economicProjection(original))===stableJSON(economicProjection(result)),'existing_epoch_projection_conflict');}
       else immutable(report,result);
       dev?.afterReportPublished?.(n);db.prepare('INSERT INTO paper_consumed_epochs VALUES(?,?,?,?,?)').run(n,sourceSha,report,hash(readFileSync(report)),disposition);
       if(disposition==='MODELLED'){lastResult=ownedJSON(report);lastModeledEpoch=n;lastResultPath=report;}
       lastClosedEpoch=n;lastReceipt=report;lastDisposition=disposition;
       state(disposition==='MODELLED'?'COMPLETED_EPOCH':'SKIPPED_MODEL_SOURCE_INELIGIBLE',{lastDisposition:disposition,lastClosedEpoch:n,lastReceipt:report,sourceBoundary:result.sourceBoundary??null});advanced=true;expected=n+1;
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
