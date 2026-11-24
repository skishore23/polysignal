import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { OPERATING_PROTOCOL, isUnavailableEmptyBook, operatingUnavailableReason, operatingInputHashes, reconcileOperatingDatabase, runOperatingMaker, sha, validateOperatingAdmission,
  type OperatingAdmission } from '../../scripts/research/maker_operating';
import { installStartupSink, newIsolatedStartupDatabase, type StartupContract } from '../../scripts/research/maker_quote_startup';
import { currentSlotMetadataUrl, type RawCapture } from '../../scripts/research/maker_startup_capture';

const START = 1_800_000_000_000, CONDITION = `0x${'a'.repeat(64)}`;
const OWNER = path.resolve('../Emergent/docs/research/plans/ongoing-owner-2026-11-18/28-continuous-paper-operation-and-burst.txt');
const json = (x: unknown) => JSON.stringify(x, null, 2) + '\n';
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(options: { slots?: number; samples?: number; minimum?: number; faultAt?: number; stopAt?: number;
  badSampleAt?: number; afterSample?: (out: string) => void; emptyBookFirstAttempt?: boolean; malformedBookFirstAttempt?: boolean;
  mixedArchiveFaultFirstAttempt?: boolean; mixedBookSidesFirstAttempt?: boolean; missingMetadataAttempts?: number;
  noEligibleAttempts?: number; malformedGammaIdentity?: boolean; tickChangeFirstAttempt?: boolean;
  restTickMismatchAttempts?: number; restTickMismatchNegRisk?: boolean;
  backdatedDeltaFirstAttempt?: boolean; mixedBackdatedFirstAttempt?: boolean; duplicateBackdatedFirstAttempt?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const out = mkdtempSync(path.resolve('reports/evidence/maker-operating-test-')); dirs.push(out);
  const runName = path.basename(out), hashes = operatingInputHashes(), protocolSha256 = sha(json(OPERATING_PROTOCOL));
  const owner28Sha256 = sha(readFileSync(OWNER)), reviewFile = path.join(out, 'authored-offline-review.json');
  writeFileSync(reviewFile, json({ decision: 'APPROVE_STANDING_PAPER_OPERATION', runName, inputMode: 'OFFLINE_FIXTURE',
    protocolSha256, inputSha256: hashes, owner28Sha256 }));
  const admission: OperatingAdmission = { schema: 'STANDING_PAPER_MAKER_ADMISSION_V1', runName, inputMode: 'OFFLINE_FIXTURE',
    notBeforeUtcMs: START, protocolSha256, inputSha256: hashes, owner28Sha256, reviewFile, reviewSha256: sha(readFileSync(reviewFile)) };
  const file = path.join(out, 'authored-admission.json'); writeFileSync(file, json(admission));
  let utc = START; const clock = () => ({ utc, mono: utc - START });
  const captures: { slot: number; attempt: number; startedUtc: number; streamCalls: number; bound: unknown;
    calls: string[]; stopped: boolean; settled: boolean }[] = [];
  const http = (url: string, body: unknown): RawCapture => { const raw = JSON.stringify(body);
    return { url, raw, at: clock(), startedAt: clock(), status: 200, sha256: sha(raw) }; };
  const config = { ...JSON.parse(readFileSync('configs/worker.json', 'utf8')), executionMode: 'PAPER' };
  const makeCapture = (slot: number, attempt: number, dir: string) => {
    mkdirSync(dir, { mode: 0o700 });
    const capture = { slot, attempt, startedUtc: utc, streamCalls: 0, bound: null as unknown,
      calls: [] as string[], stopped: false, settled: false }; captures.push(capture);
    const offset = utc - slot; let sequence = 0, open = false, priorBid = '0.49';
    const minimum = options.minimum ?? .1;
    const tick = (options.tickChangeFirstAttempt && attempt > 1)
      || (options.restTickMismatchAttempts && attempt > options.restTickMismatchAttempts) ? .001 : .01;
    const gamma = { version: 'v2', id: '123', conditionId: options.malformedGammaIdentity ? 'invalid-condition' : CONDITION, slug: `btc-updown-5m-${slot / 1000}`,
      question: 'Bitcoin Up or Down, five minutes', description: 'Authored offline operating fixture',
      eventStartTime: new Date(slot).toISOString(), endDate: new Date(slot + 300000).toISOString(),
      active: attempt > (options.noEligibleAttempts ?? 0), closed: false, archived: false, acceptingOrders: true, enableOrderBook: true, negRisk: false,
      outcomes: '["Up","Down"]', clobTokenIds: '["999","888"]', positionIds: ['111', '222'],
      orderPriceMinTickSize: tick, orderMinSize: minimum,
      volume: attempt <= (options.missingMetadataAttempts ?? 0) ? null : '100',
      liquidity: attempt <= (options.missingMetadataAttempts ?? 0) ? null : '100',
      feesEnabled: true, feeSchedule: { rate: .25, exponent: 1, takerOnly: true, rebateRate: 0 } };
    const book = () => ({ version: 'v2', market: CONDITION, asset_id: '111', timestamp: String(utc),
      bids: [{ price: priorBid, size: '900' }], asks: [{ price: '0.51', size: '100' }], hash: `fixture-${utc}`,
      tick_size: String(tick), min_order_size: String(minimum), neg_risk: false });
    const frame = async (hooks: any, body: unknown) => { sequence++; await hooks.onMessage({ ...http('wss://ws-subscriptions-clob.polymarket.com/ws/market', body), status: null }); };
    return {
      readMetadata: async () => { capture.calls.push('metadata'); return http(currentSlotMetadataUrl(slot), gamma); },
      bindMarket: (x: unknown) => { capture.bound = x; },
      readMarket: async () => { capture.calls.push('market'); utc++;
        return http(`https://clob.polymarket.com/clob-markets/${CONDITION}`, { t: [{ t: '111', o: 'Up' }, { t: '222', o: 'Down' }],
          mos: minimum, mts: tick, mbf: 0, tbf: 10, fd: { r: .25, e: 1, to: true }, oas: 0 }); },
      readBook: async () => { capture.calls.push('book'); utc++; const row = book();
        if (attempt <= (options.restTickMismatchAttempts ?? 0)) {
          row.tick_size = '0.001';
          if (options.restTickMismatchNegRisk) row.neg_risk = true;
        }
        return http('https://clob.polymarket.com/book?token_id=111', row); },
      readFee: async () => { capture.calls.push('fee'); utc++; return http('https://clob.polymarket.com/fee-rate?token_id=111', { base_fee: 2500 }); },
      proofHeadSha256: () => sha(json({ slot, attempt, sequence })),
      observationFrontier: () => ({ sequence, open }),
      ledger: () => ({ inputMode: 'OFFLINE_FIXTURE', httpRequests: capture.calls.length, deliveredFrames: sequence,
        tlsWireBytes: null, actualAccountChargesUSD: null }),
      stop: () => { capture.stopped = true; open = false; },
      settleCallbacks: async () => { capture.settled = true; },
      stream: async (hooks: any) => {
        capture.streamCalls++;
        open = true;
        for (let s = 1; s <= (options.samples ?? 30); s++) {
          if (capture.stopped || hooks.shouldStop()) break;
          utc = slot + offset + s * 1000;
          if (options.mixedArchiveFaultFirstAttempt && attempt === 1 && s === 14)
            throw Error('operating:Error: maker_source:empty_book_side:Error: operating:archive_frame_hash');
          if (options.emptyBookFirstAttempt && attempt === 1 && s === 14) {
            // A genuinely unavailable full snapshot, rejected by the actual
            // decoder after the first valid quote; never turn it into liquidity.
            await frame(hooks, { ...book(), event_type: 'book', bids: [] });
          }
          if (options.malformedBookFirstAttempt && attempt === 1 && s === 14)
            await frame(hooks, { ...book(), event_type: 'book', bids: null });
          if (options.mixedBookSidesFirstAttempt && attempt === 1 && s === 14)
            await frame(hooks, { ...book(), event_type: 'book', bids: [], asks: null });
          if (options.tickChangeFirstAttempt && attempt === 1 && s === 14)
            await frame(hooks, { event_type: 'tick_size_change', market: CONDITION, asset_id: '111',
              old_tick_size: '0.01', new_tick_size: '0.001', timestamp: String(utc) });
          if ((options.backdatedDeltaFirstAttempt || options.mixedBackdatedFirstAttempt || options.duplicateBackdatedFirstAttempt)
            && attempt === 1 && s === 14) {
            const change = { asset_id: '111', side: 'BUY', price: '0.49', size: '777',
              best_bid: '0.49', best_ask: '0.51', hash: 'authored-stale-depth' };
            const delta = { event_type: 'price_change', market: CONDITION, timestamp: String(utc - 2000),
              price_changes: options.duplicateBackdatedFirstAttempt ? [change, { ...change, size: '778' }] : [change] };
            await frame(hooks, options.mixedBackdatedFirstAttempt
              ? [delta, { ...book(), event_type: 'book', bids: null }] : delta);
          }
          const nextBid = s % 3 === 0 ? '0.48' : '0.49';
          if (s === 1 || s % 5 === 0) { priorBid = nextBid; await frame(hooks, { ...book(), event_type: 'book' }); }
          else {
            const changes = priorBid === nextBid ? [{ price: nextBid, size: '900' }]
              : [{ price: priorBid, size: '0' }, { price: nextBid, size: '900' }];
            priorBid = nextBid;
            await frame(hooks, { event_type: 'price_change', market: CONDITION, timestamp: String(utc),
              price_changes: changes.map(c => ({ ...c, asset_id: '111', side: 'BUY', best_bid: nextBid, best_ask: '0.51', hash: `delta-${utc}-${c.price}` })) });
          }
          if (s === 13) await frame(hooks, { event_type: 'last_trade_price', market: CONDITION, asset_id: '111',
            timestamp: String(utc), price: '0.50', size: '5', side: 'BUY' });
          const sampleAt = clock();
          if (options.badSampleAt === s) sampleAt.mono--;
          await hooks.onSample(sampleAt);
          options.afterSample?.(out);
          if (options.faultAt === s) { open = false; throw Error('maker_source:authored_operating_fault'); }
          if (options.stopAt === s) writeFileSync(path.join(out, 'STOP'), 'authored offline operator stop\n');
          await vi.advanceTimersByTimeAsync(250);
        }
        open = false;
        if (capture.stopped || hooks.shouldStop()) return { reason: 'caller_stop', at: clock(), callbacksPending: false };
        utc = slot + 300000; return { reason: 'slot_deadline', at: clock(), callbacksPending: false };
      },
    };
  };
  const wait = async (ms: number) => { utc += ms; };
  const run = (extra: Record<string, unknown> = {}) => runOperatingMaker(file, { clock, makeCapture, wait,
    maxSlots: options.slots ?? 1, config, disableWatchdog: false, ...extra });
  return { out, file, admission, clock, captures, run, config };
}

function terminalFiles(out: string) { return readdirSync(out).filter(x => /^epoch-[0-9]+$/.test(x))
  .flatMap(x => { const file = path.join(out, x, 'terminal.json'); try { return [JSON.parse(readFileSync(file, 'utf8'))]; } catch { return []; } }); }
function events(out: string) { return readFileSync(path.join(out, 'events.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }

function admitOwnedCarry(target: ReturnType<typeof setup>, source: ReturnType<typeof setup>,
  changes: Record<string, unknown> = {}, corruptHash = false) {
  const prior = { schema: 'OPERATING_PAPER_STATE_V1', virtualCashUSDC: '100', epoch: 5, marketSlot: START, attempt: 2,
    totalQuotes: 7, totalTicks: 70, totalSamples: 80, totalCancellations: 7,
    activeDatabase: null, activeOrders: 0, pendingLiabilityNumerator: '0', fills: 0, profitUSDC: null, status: 'STOPPED', ...changes };
  const priorFile = path.join(source.out, 'state.json'); writeFileSync(priorFile, json(prior));
  const carryFrom = { runName: path.basename(source.out), stateSha256: corruptHash ? '0'.repeat(64) : sha(readFileSync(priorFile)) };
  target.admission.carryFrom = carryFrom;
  const review = JSON.parse(readFileSync(target.admission.reviewFile, 'utf8')); review.carryFrom = carryFrom;
  writeFileSync(target.admission.reviewFile, json(review)); target.admission.reviewSha256 = sha(readFileSync(target.admission.reviewFile));
  writeFileSync(target.file, json(target.admission));
  return { prior, carryFrom };
}

function seedOwnedCrashDatabase(out: string) {
  const dir = path.join(out, 'epoch-000001'); mkdirSync(dir);
  const file = path.join(dir, 'paper.sqlite');
  const db = newIsolatedStartupDatabase(file, readFileSync('tests/maker/fixtures/startup-canonical-schema.sql', 'utf8'));
  const c: StartupContract = { paperProfile: 'OPERATING_BURST_V1', purpose: 'SYNTHETIC_OFFLINE_ENGINEERING',
    market: 'fixture', condition: 'fixture-condition', wallet: 1, tokens: ['yes', 'no'],
    book: { token: 'yes', bid: '0.49', ask: '0.51', tick: '0.01', lot: '0.01', minimum: '1',
      minimumUnit: 'USDC_NOTIONAL', minimumShares: '1', receipt: { utc: START, mono: 0 }, venueUtc: START,
      valid: true, sourceHash: 'a'.repeat(64) }, fee: { perShareUSDC: '0', provenance: 'explicit authored offline fee' } };
  const sink = installStartupSink(db, c, () => ({ utc: START, mono: 0 }));
  const submit = (changes: Record<string, unknown> = {}) => {
    const order = { ts: START, wallet_id: 1, token_id: 'yes', market_id: 'fixture', side: 'BUY', kind: 'MAKER_BID', price: .5, size: 10,
      expected_cancel_ts: START + 5000, execution_mode: 'SHADOW', source: 'maker_loop', client_order_id: 'crash-q', decision_group_id: 'crash-q',
      external_order_id: null, status: 'OPEN', filled_size: 0, filled_price: null, last_update_ts: START, strategy_lane: 'MAKER', decision: 'SUBMIT', ...changes };
    const keys = Object.keys(order);
    db.transaction(() => {
      db.prepare(`INSERT INTO shadow_orders(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(order));
      db.prepare('INSERT INTO decision_log(ts,token_id,wallet_id,kind,strategy_lane,decision_group_id,decision,size) VALUES (?,?,?,?,?,?,?,?)')
        .run(order.ts, order.token_id, order.wallet_id, order.kind, order.strategy_lane, order.decision_group_id, 'SUBMIT', order.size);
    })();
  };
  return { file, db, sink, submit };
}

describe('ordinary continuous operating integration, authored offline inputs only', () => {
  it('classifies only the exact typed empty-book errors as unavailable liquidity', () => {
    expect(isUnavailableEmptyBook(Error('maker_source:empty_book_side'))).toBe(true);
    expect(isUnavailableEmptyBook(Error('operating:Error: maker_source:empty_book_side:'))).toBe(true);
    for (const error of [
      Error('operating:Error: maker_source:empty_book_side:Error: operating:archive_frame_hash'),
      Error('maker_source:empty_book_side:archive verification failed'),
      Error('source_event:maker_source:empty_book_side'), Error('unsupported maker_source:empty_book_side'),
      Error('maker_source:empty_book_side\n'), 'maker_source:empty_book_side',
      { message: 'maker_source:empty_book_side', event_type: 'source_event' },
    ]) expect(isUnavailableEmptyBook(error)).toBe(false);
  });
  it('classifies only known exact availability causes and rejects combined invariants or archive errors', () => {
    for (const message of ['maker_operating:source_metadata:OBSERVED_MARKET_VOLUME_AND_LIQUIDITY'])
      expect(operatingUnavailableReason(Error(message))).toBe('metadata_not_ready');
    for (const message of ['maker_source:empty_book_side', 'operating:Error: maker_source:empty_book_side:'])
      expect(operatingUnavailableReason(Error(message))).toBe('empty_book');
    for (const message of ['maker_source:validated_tick_size_change', 'operating:Error: maker_source:validated_tick_size_change:'])
      expect(operatingUnavailableReason(Error(message))).toBe('tick_size_change');
    for (const message of ['maker_source:validated_backdated_delta', 'operating:Error: maker_source:validated_backdated_delta:'])
      expect(operatingUnavailableReason(Error(message))).toBe('backdated_delta');
    for (const message of ['maker_source:validated_rest_tick_mismatch', 'operating:Error: maker_source:validated_rest_tick_mismatch:'])
      expect(operatingUnavailableReason(Error(message))).toBe('rest_tick_mismatch');
    for (const cause of [
      Error('maker_operating:source_metadata:OBSERVED_MARKET_VOLUME_AND_LIQUIDITY,KNOWN_FEE_BOUND'),
      Error('operating:Error: maker_source:validated_tick_size_change:archive verification failed'),
      Error('operating:Error: maker_source:empty_book_side:Error: operating:archive_frame_hash'),
      Error('maker_source:tick_size_change'), Error('unsupported maker_source:validated_tick_size_change'),
      Error('operating:Error: maker_source:validated_backdated_delta:archive verification failed'),
      Error('maker_source:backdated_delta_mixed_frame'), Error('maker_source:backdated_delta'),
      Error('maker_source:book_market_limits'), Error('unsupported maker_source:validated_rest_tick_mismatch'),
      Error('operating:Error: maker_source:validated_rest_tick_mismatch:archive verification failed'),
      'maker_source:validated_rest_tick_mismatch', { message: 'maker_source:validated_rest_tick_mismatch' },
      Error('maker_source:ambiguous_repeated_delta_level'),
      Error('maker_operating:original_market_not_eligible'),
      'maker_operating:original_market_not_eligible', { message: 'maker_source:validated_tick_size_change' },
    ]) expect(operatingUnavailableReason(cause)).toBeNull();
  });
  it('runs the actual engine beyond its first quote and reconciles every reservation', async () => {
    const f = setup(); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('public network forbidden'); });
    const state = await f.run();
    expect(state.lastSourceFault, JSON.stringify(state)).toBeUndefined();
    expect(state.totalQuotes, JSON.stringify(state)).toBeGreaterThanOrEqual(2); expect(state.totalSamples).toBe(30);
    expect(state.status).toBe('OFFLINE_FINISHED'); expect(state.virtualCashUSDC).toBe('100');
    expect(state.activeOrders).toBe(0); expect(state.pendingLiabilityNumerator).toBe('0');
    expect(state.lastSourceFault).toBeUndefined(); expect(f.captures).toHaveLength(1);
    expect(f.captures[0]).toMatchObject({ settled: true, stopped: true, bound: { condition: CONDITION, token: '111', protocolVersion: 'v2' } });
    expect(events(f.out).filter(x => x.kind === 'PAPER_QUOTE').length).toBeGreaterThanOrEqual(2);
    expect(events(f.out).some(x => x.kind === 'CANCEL' && x.reason === 'TTL' && x.count > 0)).toBe(true);
    for (const t of terminalFiles(f.out)) {
      expect(t.terminal).toMatchObject({ syntheticCashUSDC: '100', pendingLiabilityUSDC: '0', fills: 0, profitUSDC: null });
      expect(t.snapshot.orders.every((o: any) => o.execution_mode === 'SHADOW' && o.external_order_id === null && o.status === 'CANCELLED')).toBe(true);
      expect(t.snapshot.fills).toHaveLength(0);
    }
    expect(network).not.toHaveBeenCalled();
  });
  it('rolls two exact five-minute slots while carrying one unchanged virtual bank', async () => {
    const f = setup({ slots: 2 }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(); expect(state.totalQuotes).toBeGreaterThanOrEqual(4);
    expect(f.captures.map(x => x.slot)).toEqual([START, START + 300000]);
    expect(f.captures.every(x => x.calls.join(',') === 'metadata,market,book,fee' && x.settled)).toBe(true);
    expect(state.virtualCashUSDC).toBe('100'); expect(state.pendingLiabilityNumerator).toBe('0');
    const terminals = terminalFiles(f.out); expect(terminals).toHaveLength(2);
    expect(terminals.map(t => t.terminal.syntheticCashUSDC)).toEqual(['100', '100']);
    expect(terminals.every(t => t.snapshot.opening.cashUSDC === '100' && t.snapshot.opening.paidFees === null)).toBe(true);
  });
  it('reconstructs each first quote from its actual sample-journal prefix and retains failed samples before derivation', async () => {
    const f = setup({ slots: 2 }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const positiveState = await f.run(); expect(positiveState.lastSourceFault, JSON.stringify(positiveState)).toBeUndefined();
    const firstQuotes = events(f.out).filter(e => e.kind === 'PAPER_QUOTE' && e.count === 1);
    expect(firstQuotes).toHaveLength(2);
    for (const event of firstQuotes) {
      const q = JSON.parse(readFileSync(event.evidence, 'utf8'));
      const raw = readFileSync(path.join(path.dirname(event.evidence), q.samples.file));
      const prefix = raw.subarray(0, q.samples.bytes);
      expect(prefix.length).toBe(q.samples.bytes); expect(prefix.at(-1)).toBe(10);
      const lines = prefix.toString('utf8').slice(0, -1).split('\n');
      expect(lines.length).toBe(q.samples.records); expect(lines.length).toBeGreaterThanOrEqual(13);
      let head = sha('OPERATING_ACTUAL_SAMPLE_CLOCKS_V1');
      const rows = lines.map((line, i) => {
        head = sha(Buffer.concat([Buffer.from(head, 'hex'), Buffer.from(line + '\n')]));
        const row = JSON.parse(line); expect(row.number).toBe(i + 1); return row;
      });
      expect(head).toBe(q.samples.headSha256);
      const slot = Math.floor(q.sampleAt.utc / 300000) * 300000;
      const offset = rows[0].at.utc - slot - 1000;
      for (const [i, row] of rows.entries()) {
        const expectedUtc = slot + offset + (i + 1) * 1000;
        expect(row.at).toEqual({ utc: expectedUtc, mono: expectedUtc - START });
        // The only extra authored application frame is the actual trade at13s.
        expect(row.processedFrames).toBe(i + 1 + (i + 1 >= 13 ? 1 : 0));
        expect(row.proofHeadSha256).toBe(sha(json({ slot, attempt: 1, sequence: row.processedFrames })));
      }
      expect(rows.at(-1)).toMatchObject({ at: q.sampleAt, processedFrames: q.processedFrames, proofHeadSha256: q.proofHeadSha256 });
      const captureHash = sha(JSON.stringify({ sourceHashes: q.metadataSourceHashes, head: q.proofHeadSha256,
        processedFrames: q.processedFrames, at: q.sampleAt, sampleHead: head, sampleRecords: rows.length }));
      expect(captureHash).toBe(q.snapshot.contract.book.sourceHash);
    }
    // A deliberately invalid fixture clock must still be journaled BEFORE the
    // source decoder rejects it; this is failed custody evidence, never history.
    const bad = setup({ badSampleAt: 14 }); vi.spyOn(Date, 'now').mockImplementation(() => bad.clock().utc);
    const state = await bad.run(); expect(state.lastSourceFault).toContain('causal_clocks');
    const attempted = readFileSync(path.join(bad.out, 'epoch-000001', 'samples.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(attempted).toHaveLength(14);
    expect(attempted[13]).toMatchObject({ number: 14, at: { utc: START + 14000, mono: 13999 } });
    expect(state.pendingLiabilityNumerator).toBe('0');
  });
  it('rejects private frozen-model drift after the first quote and cancels before another quote or source attempt', async () => {
    const originals = ['data/markov_regime.json', 'data/strategy_regime_report.json', 'data/regime_manifest.json']
      .map(file => ({ file, raw: readFileSync(file) }));
    let mutated = false, acceptedBeforeDrift = 0;
    const f = setup({ slots: 2, afterSample: out => {
      if (mutated) return;
      const accepted = events(out).filter(e => e.kind === 'PAPER_QUOTE'); if (!accepted.length) return;
      acceptedBeforeDrift = accepted.length;
      const file = path.join(out, 'frozen-models', 'markov_regime.json'), before = readFileSync(file);
      chmodSync(file, 0o600); writeFileSync(file, Buffer.concat([before, Buffer.from('\n ')]));
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(before.toString('utf8')));
      expect(sha(readFileSync(file))).not.toBe(sha(before)); mutated = true;
    } });
    vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run();
    expect(mutated).toBe(true); expect(acceptedBeforeDrift).toBe(1);
    expect(state.status).toBe('STOPPED'); expect(state.lastSourceFault).toContain('runtime_source_drift');
    expect(state.totalQuotes).toBe(acceptedBeforeDrift); expect(f.captures).toHaveLength(1);
    expect(state.activeOrders).toBe(0); expect(state.pendingLiabilityNumerator).toBe('0');
    expect(terminalFiles(f.out)[0].terminal).toMatchObject({ syntheticCashUSDC: '100', pendingLiabilityUSDC: '0', fills: 0 });
    for (const { file, raw } of originals) expect(readFileSync(file).equals(raw)).toBe(true);
    await expect(f.run()).rejects.toThrow('frozen_model_drift');
    expect(f.captures).toHaveLength(1);
  });
  it('cancels after an actual post-quote source correctness fault without claiming continuity', async () => {
    const f = setup({ faultAt: 20 }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(); expect(state.totalQuotes).toBeGreaterThan(0);
    expect(state.status).toBe('STOPPED'); expect(state.stopReason).toBe('source_correctness_fault');
    expect(state.lastSourceFault).toContain('authored_operating_fault'); expect(state.activeOrders).toBe(0);
    expect(state.pendingLiabilityNumerator).toBe('0'); expect(f.captures).toHaveLength(1);
    expect(terminalFiles(f.out)[0].terminal.fills).toBe(0);
  });
  it('cancels an empty-book gap and quotes again only after a fresh admitted resync attempt', async () => {
    const f = setup({ emptyBookFirstAttempt: true }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(); const log = events(f.out);
    expect(f.captures.map(c => c.attempt)).toEqual([1, 2]);
    expect(f.captures.length).toBeLessThanOrEqual(OPERATING_PROTOCOL.source.maxAttemptsPerSlot);
    expect(f.captures.every(c => c.calls.join(',') === 'metadata,market,book,fee' && c.settled && c.stopped)).toBe(true);
    const fault = log.find(e => e.kind === 'SOURCE_ATTEMPT_FAULT' && e.epoch === 1);
    const firstTerminal = log.find(e => e.kind === 'TERMINAL_RECONCILED' && e.epoch === 1);
    const resumed = log.find(e => e.kind === 'SOURCE_ATTEMPT_OPEN' && e.epoch === 2);
    expect(fault.error).toContain('maker_source:empty_book_side');
    expect(firstTerminal.terminal).toMatchObject({ syntheticCashUSDC: '100', pendingLiabilityUSDC: '0', fills: 0 });
    expect(log.indexOf(firstTerminal)).toBeLessThan(log.indexOf(resumed));
    expect(log.filter(e => e.kind === 'FRESH_RESYNC_GAP')).toHaveLength(1);
    expect(resumed.at.utc - fault.at.utc).toBeGreaterThanOrEqual(2000);
    const quotes = log.filter(e => e.kind === 'PAPER_QUOTE');
    expect(quotes.filter(e => e.epoch === 1)).toHaveLength(1);
    expect(quotes.some(e => e.epoch === 2)).toBe(true);
    expect(quotes.some(e => e.at.utc >= fault.at.utc && e.at.utc < resumed.at.utc)).toBe(false);
    const resumedQuote = JSON.parse(readFileSync(quotes.find(e => e.epoch === 2).evidence, 'utf8'));
    expect(resumedQuote.samples.records).toBeGreaterThanOrEqual(13); // fresh history, not bridged across the gap
    expect(state.status).toBe('OFFLINE_FINISHED'); expect(state.virtualCashUSDC).toBe('100');
    expect(state.activeOrders).toBe(0); expect(state.pendingLiabilityNumerator).toBe('0');
    expect(terminalFiles(f.out)).toHaveLength(2);
    expect(terminalFiles(f.out).every(t => t.terminal.pendingLiabilityUSDC === '0' && t.snapshot.fills.length === 0)).toBe(true);
  });
  it('keeps a malformed nonarray book side fatal instead of relabeling it as empty liquidity', async () => {
    const f = setup({ malformedBookFirstAttempt: true }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(); expect(state.totalQuotes).toBe(1);
    expect(state.status).toBe('STOPPED'); expect(state.stopReason).toBe('source_correctness_fault');
    expect(state.lastSourceFault).toContain('maker_source:book_side_schema');
    expect(f.captures).toHaveLength(1); expect(events(f.out).some(e => e.kind === 'EMPTY_BOOK_RESYNC')).toBe(false);
    expect(state.pendingLiabilityNumerator).toBe('0'); expect(state.activeOrders).toBe(0);
  });
  it('validates both book-side schemas before interpreting either empty array as availability', async () => {
    const f = setup({ mixedBookSidesFirstAttempt: true }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(); expect(state.totalQuotes).toBe(1);
    expect(state.status).toBe('STOPPED'); expect(state.lastSourceFault).toContain('maker_source:book_side_schema');
    expect(f.captures).toHaveLength(1); expect(events(f.out).some(e => e.kind === 'EMPTY_BOOK_RESYNC')).toBe(false);
    expect(state.activeOrders).toBe(0); expect(state.pendingLiabilityNumerator).toBe('0');
  });
  it('waits for missing metadata with bounded debt before opening a third fresh healthy source', async () => {
    const f = setup({ missingMetadataAttempts: 2 });
    vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(); expect(f.captures.map(c => c.attempt)).toEqual([1, 2, 3]);
    expect(f.captures.map(c => c.streamCalls)).toEqual([0, 0, 1]);
    expect(f.captures[0]!.calls).toEqual(['metadata', 'market', 'book', 'fee']);
    expect(f.captures[1]!.calls).toEqual(f.captures[0]!.calls);
    expect(OPERATING_PROTOCOL.source.metadataRetryBackoffMs).toEqual([90000, 90000]);
    expect(f.captures[1]!.startedUtc - f.captures[0]!.startedUtc).toBeGreaterThanOrEqual(90000);
    expect(f.captures[2]!.startedUtc - f.captures[1]!.startedUtc).toBeGreaterThanOrEqual(90000);
    const quotes = events(f.out).filter(e => e.kind === 'PAPER_QUOTE');
    expect(quotes.length).toBeGreaterThan(0); expect(quotes.every(q => q.epoch === 3)).toBe(true);
    const first = JSON.parse(readFileSync(quotes[0].evidence, 'utf8'));
    expect(first.samples.records).toBeGreaterThanOrEqual(13);
    expect(first.sampleAt.utc - f.captures[2]!.startedUtc).toBeGreaterThanOrEqual(13000);
    expect(state.status).toBe('OFFLINE_FINISHED'); expect(state.virtualCashUSDC).toBe('100');
    expect(state.attempt).toBe(3); expect(state.pendingLiabilityNumerator).toBe('0'); expect(state.activeOrders).toBe(0);
    expect(terminalFiles(f.out)).toHaveLength(1);
  });
  it.each(['inactive', 'malformed_identity'] as const)('keeps %s Gamma selection failure fatal rather than assuming availability', async kind => {
    const f = setup(kind === 'inactive' ? { noEligibleAttempts: 3 } : { malformedGammaIdentity: true });
    const state = await f.run(); expect(state.status).toBe('STOPPED'); expect(state.stopReason).toBe('source_correctness_fault');
    expect(state.lastSourceFault).toContain('original_market_not_eligible'); expect(state.totalQuotes).toBe(0);
    expect(f.captures).toHaveLength(1); expect(f.captures[0]!.calls).toEqual(['metadata']); expect(f.captures[0]!.streamCalls).toBe(0);
    expect(events(f.out).some(e => e.kind === 'FRESH_RESYNC_GAP')).toBe(false);
    expect(state.virtualCashUSDC).toBe('100'); expect(state.pendingLiabilityNumerator).toBe('0');
  });
  it('carries missing-metadata attempt debt without a fourth attempt or invented funding', async () => {
    const prior = setup(), f = setup({ missingMetadataAttempts: 3 }); const carried = admitOwnedCarry(f, prior);
    const state = await f.run(); expect(f.captures.map(c => c.attempt)).toEqual([3]);
    expect(f.captures[0]!.streamCalls).toBe(0); expect(state.totalQuotes).toBe(carried.prior.totalQuotes);
    expect(state.totalSamples).toBe(carried.prior.totalSamples); expect(state.attempt).toBe(3);
    expect(state.virtualCashUSDC).toBe('100'); expect(state.pendingLiabilityNumerator).toBe('0');
    expect(state.status).toBe('OFFLINE_FINISHED'); await f.run(); expect(f.captures).toHaveLength(1);
  });
  it('closes on a typed tick change and fetches fresh constraints before any further quote', async () => {
    const f = setup({ tickChangeFirstAttempt: true }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(); expect(f.captures.map(c => c.attempt)).toEqual([1, 2]);
    expect(f.captures.every(c => c.calls.join(',') === 'metadata,market,book,fee')).toBe(true);
    const quotes = events(f.out).filter(e => e.kind === 'PAPER_QUOTE');
    expect(quotes.filter(q => q.epoch === 1)).toHaveLength(1);
    const old = JSON.parse(readFileSync(quotes.find(q => q.epoch === 1).evidence, 'utf8'));
    const fresh = JSON.parse(readFileSync(quotes.find(q => q.epoch === 2).evidence, 'utf8'));
    expect(old.snapshot.contract.book.tick).toBe('0.01'); expect(fresh.snapshot.contract.book.tick).toBe('0.001');
    expect(fresh.samples.records).toBeGreaterThanOrEqual(13); expect(state.status).toBe('OFFLINE_FINISHED');
    expect(state.virtualCashUSDC).toBe('100'); expect(state.pendingLiabilityNumerator).toBe('0');
  });
  it('opens no socket or quote on REST tick disagreement and quotes only after fresh matching metadata and history', async () => {
    const f = setup({ restTickMismatchAttempts: 1 }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(), log = events(f.out);
    expect(OPERATING_PROTOCOL.schema).toBe('ORDINARY_PAPER_MAKER_OPERATING_V7');
    expect(OPERATING_PROTOCOL.source.activityMetricRepresentation).toContain('trading quantity scale9 precision unchanged');
    expect(f.captures.map(c => c.attempt)).toEqual([1, 2]); expect(f.captures.map(c => c.streamCalls)).toEqual([0, 1]);
    expect(f.captures.every(c => c.calls.join(',') === 'metadata,market,book,fee' && c.settled)).toBe(true);
    expect(f.captures[1]!.startedUtc - f.captures[0]!.startedUtc).toBeGreaterThanOrEqual(2000);
    const fault = log.find(e => e.kind === 'SOURCE_ATTEMPT_FAULT');
    expect(fault.error).toBe('Error: maker_source:validated_rest_tick_mismatch');
    expect(log.find(e => e.kind === 'FRESH_RESYNC_GAP').reason).toBe('rest_tick_mismatch');
    const quotes = log.filter(e => e.kind === 'PAPER_QUOTE'); expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every(q => q.epoch === 2)).toBe(true);
    const first = JSON.parse(readFileSync(quotes[0].evidence, 'utf8'));
    expect(first.snapshot.contract.book.tick).toBe('0.001'); expect(first.samples.records).toBeGreaterThanOrEqual(13);
    expect(state.status).toBe('OFFLINE_FINISHED'); expect(state.virtualCashUSDC).toBe('100');
    expect(state.activeOrders).toBe(0); expect(state.pendingLiabilityNumerator).toBe('0'); expect(state.fills).toBe(0);
  });
  it('consumes at most the same three attempts for persistent REST tick disagreement without any socket or quote', async () => {
    const f = setup({ restTickMismatchAttempts: 3 }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(); expect(f.captures.map(c => c.attempt)).toEqual([1, 2, 3]);
    expect(f.captures.map(c => c.streamCalls)).toEqual([0, 0, 0]); expect(state.totalQuotes).toBe(0);
    expect(f.captures[2]!.startedUtc - f.captures[1]!.startedUtc).toBeGreaterThanOrEqual(10000);
    expect(state.status).toBe('OFFLINE_FINISHED'); expect(state.attempt).toBe(3); expect(state.virtualCashUSDC).toBe('100');
    await f.run(); expect(f.captures).toHaveLength(3); expect(state.activeOrders).toBe(0);
  });
  it('keeps REST tick disagreement plus contradictory risk metadata fatal without retry', async () => {
    const f = setup({ restTickMismatchAttempts: 1, restTickMismatchNegRisk: true });
    const state = await f.run(); expect(f.captures).toHaveLength(1); expect(f.captures[0]!.streamCalls).toBe(0);
    expect(state.status).toBe('STOPPED'); expect(state.stopReason).toBe('source_correctness_fault');
    expect(state.lastSourceFault).toBe('Error: maker_source:book_market_limits'); expect(state.totalQuotes).toBe(0);
    expect(events(f.out).some(e => e.kind === 'FRESH_RESYNC_GAP')).toBe(false);
    expect(state.virtualCashUSDC).toBe('100'); expect(state.pendingLiabilityNumerator).toBe('0');
  });
  it('does not apply a validated backdated singleton and quotes only after bounded fresh resync', async () => {
    const f = setup({ backdatedDeltaFirstAttempt: true }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(), log = events(f.out);
    expect(f.captures.map(c => c.attempt)).toEqual([1, 2]);
    expect(f.captures.every(c => c.calls.join(',') === 'metadata,market,book,fee' && c.settled)).toBe(true);
    const fault = log.find(e => e.kind === 'SOURCE_ATTEMPT_FAULT' && e.epoch === 1);
    const terminal = log.find(e => e.kind === 'TERMINAL_RECONCILED' && e.epoch === 1);
    const opened = log.find(e => e.kind === 'SOURCE_ATTEMPT_OPEN' && e.epoch === 2);
    expect(fault.error).toContain('maker_source:validated_backdated_delta');
    expect(terminal.terminal).toMatchObject({ syntheticCashUSDC: '100', pendingLiabilityUSDC: '0', fills: 0 });
    expect(log.indexOf(terminal)).toBeLessThan(log.indexOf(opened)); expect(opened.at.utc - fault.at.utc).toBeGreaterThanOrEqual(2000);
    const quotes = log.filter(e => e.kind === 'PAPER_QUOTE'); expect(quotes.filter(q => q.epoch === 1)).toHaveLength(1);
    expect(quotes.some(q => q.at.utc >= fault.at.utc && q.at.utc < opened.at.utc)).toBe(false);
    const fresh = JSON.parse(readFileSync(quotes.find(q => q.epoch === 2).evidence, 'utf8'));
    expect(fresh.samples.records).toBeGreaterThanOrEqual(13); expect(fresh.feature.bidDepthTop).toBe(900);
    expect(state.status).toBe('OFFLINE_FINISHED'); expect(state.virtualCashUSDC).toBe('100');
    expect(state.pendingLiabilityNumerator).toBe('0'); expect(state.activeOrders).toBe(0);
  });
  it.each(['mixed_sibling', 'duplicate_level'] as const)('keeps a backdated %s frame fatal without availability masking', async kind => {
    const f = setup(kind === 'mixed_sibling' ? { mixedBackdatedFirstAttempt: true } : { duplicateBackdatedFirstAttempt: true });
    vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(); expect(state.totalQuotes).toBe(1); expect(f.captures).toHaveLength(1);
    expect(state.status).toBe('STOPPED'); expect(state.stopReason).toBe('source_correctness_fault');
    expect(events(f.out).some(e => e.kind === 'FRESH_RESYNC_GAP')).toBe(false);
    expect(state.pendingLiabilityNumerator).toBe('0'); expect(state.activeOrders).toBe(0);
    expect(terminalFiles(f.out)[0].terminal).toMatchObject({ syntheticCashUSDC: '100', pendingLiabilityUSDC: '0', fills: 0 });
  });
  it('keeps a combined empty-book and archive failure fatal after a quote', async () => {
    const f = setup({ mixedArchiveFaultFirstAttempt: true }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(); expect(state.totalQuotes).toBe(1); expect(f.captures).toHaveLength(1);
    expect(state.status).toBe('STOPPED'); expect(state.stopReason).toBe('source_correctness_fault');
    expect(state.lastSourceFault).toContain('archive_frame_hash');
    expect(events(f.out).some(e => e.kind === 'EMPTY_BOOK_RESYNC' || e.kind === 'FRESH_RESYNC_GAP')).toBe(false);
    expect(state.activeOrders).toBe(0); expect(state.pendingLiabilityNumerator).toBe('0');
    expect(terminalFiles(f.out)[0].terminal).toMatchObject({ syntheticCashUSDC: '100', pendingLiabilityUSDC: '0', fills: 0 });
  });
  it('carries one reconciled bank and all counters into a new reviewed name without resetting slot attempts', async () => {
    const prior = setup(), f = setup(); const carried = admitOwnedCarry(f, prior);
    vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run();
    expect(f.captures.map(c => c.attempt)).toEqual([3]); expect(state.epoch).toBe(carried.prior.epoch + 1);
    expect(state.virtualCashUSDC).toBe('100'); expect(state.carriedFrom).toEqual(carried.carryFrom); expect(state.sourceAdmissionChanged).toBe(true);
    const addedQuotes = events(f.out).filter(e => e.kind === 'PAPER_QUOTE').reduce((sum, e) => sum + e.added, 0);
    expect(addedQuotes).toBeGreaterThan(0); expect(state.totalQuotes).toBe(carried.prior.totalQuotes + addedQuotes);
    expect(state.totalSamples).toBe(carried.prior.totalSamples + 30);
    expect(state.totalTicks).toBeGreaterThan(carried.prior.totalTicks);
    expect(state.totalCancellations).toBeGreaterThan(carried.prior.totalCancellations);
    expect(state.activeOrders).toBe(0); expect(state.pendingLiabilityNumerator).toBe('0');
    expect(terminalFiles(f.out)[0].terminal).toMatchObject({ syntheticCashUSDC: '100', pendingLiabilityUSDC: '0', fills: 0 });
  });
  it.each(['changed_hash', 'unreleased_reservation'])('rejects carry with %s before opening a source attempt', async kind => {
    const prior = setup(), f = setup();
    admitOwnedCarry(f, prior, kind === 'unreleased_reservation' ? { activeOrders: 1, pendingLiabilityNumerator: '1000000000000000000' } : {}, kind === 'changed_hash');
    await expect(f.run()).rejects.toThrow(kind === 'changed_hash' ? 'carry_state_hash' : 'carry_unreconciled');
    expect(f.captures).toHaveLength(0); expect(readdirSync(f.out).some(name => /^epoch-/.test(name))).toBe(false);
  });
  it('honors an operator stop file through the actual watchdog and cancels before finalization', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = setup({ stopAt: 20 }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(); expect(state.totalQuotes).toBeGreaterThan(0);
    expect(state.status).toBe('STOPPED'); expect(state.stopReason).toBe('operator_stop_file');
    expect(state.activeOrders).toBe(0); expect(state.pendingLiabilityNumerator).toBe('0'); expect(f.captures[0]!.settled).toBe(true);
  });
  it('skips a venue floor above hard budget instead of fabricating a legal quote', async () => {
    const f = setup({ minimum: 25 }); vi.spyOn(Date, 'now').mockImplementation(() => f.clock().utc);
    const state = await f.run(); expect(state.totalTicks).toBeGreaterThan(0); expect(state.totalQuotes).toBe(0);
    expect(state.virtualCashUSDC).toBe('100'); expect(state.pendingLiabilityNumerator).toBe('0');
    expect(terminalFiles(f.out).every(t => t.snapshot.orders.length === 0)).toBe(true);
  });
  it('rejects public-input labels or changed source pins when using test transports', () => {
    const f = setup();
    expect(() => validateOperatingAdmission({ ...f.admission, inputMode: 'CURRENT_PUBLIC_CAPTURE' }, f.clock(), true)).toThrow('evidence_mode');
    expect(() => validateOperatingAdmission({ ...f.admission, inputSha256: {} }, f.clock(), true)).toThrow('source_drift');
  });
  it('reconciles an owned crash reservation on restart without refilling its virtual bank', async () => {
    const f = setup(), crashed = seedOwnedCrashDatabase(f.out); crashed.submit(); crashed.db.close();
    writeFileSync(path.join(f.out, 'state.json'), json({ schema: 'OPERATING_PAPER_STATE_V1', virtualCashUSDC: '100', epoch: 1,
      totalQuotes: 1, totalTicks: 1, totalSamples: 1, totalCancellations: 0, activeDatabase: crashed.file }));
    const state = await f.run({ maxSlots: 0 });
    expect(state.virtualCashUSDC).toBe('100'); expect(state.activeDatabase).toBeNull(); expect(f.captures).toHaveLength(0);
    expect(events(f.out).find(e => e.kind === 'RESTART_RECONCILED')).toMatchObject({ cancelled: 1, virtualCashUSDC: '100', pendingLiabilityUSDC: '0', fills: 0 });
    const db = new Database(crashed.file, { readonly: true });
    try { expect(db.prepare('SELECT status FROM shadow_orders').get()).toEqual({ status: 'CANCELLED' });
      expect(JSON.parse((db.prepare('SELECT record FROM startup_opening').get() as { record: string }).record).cashUSDC).toBe('100'); }
    finally { db.close(); }
  });
  it('preserves the three-attempt slot limit across restart and does not launch an unregistered fourth attempt', async () => {
    const f = setup();
    writeFileSync(path.join(f.out, 'state.json'), json({ schema: 'OPERATING_PAPER_STATE_V1', virtualCashUSDC: '100', epoch: 3,
      marketSlot: START, attempt: 3, totalQuotes: 0, totalTicks: 0, totalSamples: 0, totalCancellations: 0, activeDatabase: null }));
    const state = await f.run(); expect(f.captures).toHaveLength(0); expect(state.epoch).toBe(3); expect(state.virtualCashUSDC).toBe('100');
  });
  it('enforces hard limits, exact grid and SHADOW mode at the actual operational sink', () => {
    const f = setup(), owned = seedOwnedCrashDatabase(f.out);
    try {
      expect(() => owned.submit({ price: .499 })).toThrow('tick_lot_minimum');
      expect(() => owned.submit({ size: 40.02 })).toThrow('order_cap');
      expect(() => owned.submit({ execution_mode: 'FULL' })).toThrow('mode_or_fill');
      expect(() => owned.submit({ external_order_id: 'real-venue' })).toThrow('mode_or_fill');
      expect(owned.sink.snapshot().orders).toHaveLength(0); owned.submit();
      expect(owned.sink.snapshot().orders).toHaveLength(1);
    } finally { owned.db.close(); }
    const another = setup(); expect(() => reconcileOperatingDatabase(owned.file, START + 1, another.out)).toThrow('recovery_scope');
  });
});
