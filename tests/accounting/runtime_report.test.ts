import { afterAll, describe, expect, it } from 'vitest';
import { ShadowExecutionLoop } from '../../apps/worker/src/shadow/ShadowExecutionLoop';
import { computeTakerFee } from '../../apps/worker/src/trading/PolymarketFeeMath';
import {
  getAccountingReport,
  getSavedAccountingReport,
  postAccountingEvent,
  saveAccountingReport,
  type AccountingEvent,
} from '../../packages/storage/src/accounting';
import { reconcileEvents, type CashEvent } from '../trading/independent_cash_ledger';
import { createTempDb, destroyTempDb, type TempDb } from '../helpers/db-temp';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return this;
  },
} as any;
const opened: TempDb[] = [];
const base = 1_780_000_000_000;
const event = (
  fields: Partial<AccountingEvent> & Pick<AccountingEvent, 'eventKey' | 'kind' | 'sourceRef'>,
): AccountingEvent => ({
  accountKey: 'wallet:7',
  source: 'fixture',
  eventTs: base,
  receiptTs: base,
  processingOrder: 0,
  finality: 'CONFIRMED',
  feeEvidence: 'NOT_APPLICABLE',
  ruleVersion: 'fixture-v1',
  roundingPolicy: 'exact-fixture',
  collateralAsset: 'USDC',
  ...fields,
});

describe('runtime accounting event to report', () => {
  afterAll(async () => {
    await Promise.all(opened.map(destroyTempDb));
  });

  it('persists paper fill economics once and agrees with an independent cash ledger', async () => {
    const db = await createTempDb();
    opened.push(db);
    const opening = event({
      eventKey: 'opening:7',
      kind: 'OPENING',
      sourceRef: 'opening:7',
      cashDelta: 100,
    });
    expect(postAccountingEvent(db.sqlite, opening)).toBe(true);
    expect(postAccountingEvent(db.sqlite, opening)).toBe(false);
    expect(() => postAccountingEvent(db.sqlite, { ...opening, cashDelta: 101 })).toThrow(
      'ACCOUNTING_EVENT_ID_CONFLICT',
    );
    db.sqlite
      .prepare(
        "INSERT INTO markets (id, question, slug, updated_at, created_at) VALUES ('m', 'Will BTC rise in 5 minutes?', 'btc-5m', ?, ?)",
      )
      .run(base, base);
    db.sqlite
      .prepare(
        "INSERT INTO tokens (id, market_id, fee_rate_bps, updated_at) VALUES ('t', 'm', 700, ?)",
      )
      .run(base);
    const insertOrder = db.sqlite.prepare(`INSERT INTO shadow_orders
      (ts, wallet_id, token_id, market_id, side, kind, execution_mode, price, size, status, filled_size)
      VALUES (?, 7, 't', 'm', ?, ?, 'SHADOW', ?, ?, 'OPEN', 0)`);
    insertOrder.run(base + 1, 'BUY', 'TAKER_BUY', 0.5, 10);
    insertOrder.run(base + 2, 'SELL', 'TAKER_SELL', 0.6, 4);
    const loop = new ShadowExecutionLoop(
      {
        intervalMs: 1000,
        makerStalenessSec: 30,
        markoutHorizonsMs: [300000],
        makerQueueFillProb: 1,
        makerPriceToleranceBps: 0,
        forceSyntheticFills: false,
        rebalanceEnabled: false,
      },
      { sqlite: db.sqlite, logger },
    );
    (loop as any).processTakerOrders();
    (loop as any).processTakerOrders();
    const fills = db.sqlite
      .prepare('SELECT id, size, price FROM shadow_fills ORDER BY id')
      .all() as Array<{ id: number; size: number; price: number }>;
    expect(fills).toHaveLength(2);
    const postings = db.sqlite
      .prepare(
        "SELECT event_key AS eventKey, fee_asset AS feeAsset, fee_amount AS feeAmount, net_shares_delta AS netSharesDelta FROM accounting_events WHERE kind = 'FILL' ORDER BY id",
      )
      .all() as Array<{
      eventKey: string;
      feeAsset: string;
      feeAmount: number;
      netSharesDelta: number;
    }>;
    expect(postings).toHaveLength(2);
    expect(postings[0]?.eventKey).toBe(`shadow-fill:${fills[0]?.id}`);
    expect(postings[0]?.feeAsset).toBe('SHARES');
    expect(postings[1]?.feeAsset).toBe('USDC');
    const buyFee = computeTakerFee({
      marketProfile: 'CRYPTO_5M',
      shares: 10,
      price: 0.5,
      side: 'BUY',
      feeRateBps: 700,
    });
    const sellFee = computeTakerFee({
      marketProfile: 'CRYPTO_5M',
      shares: 4,
      price: 0.6,
      side: 'SELL',
      feeRateBps: 700,
    });
    db.sqlite
      .prepare("INSERT INTO latest_features (token_id, ts, mid) VALUES ('t', ?, 0.7)")
      .run(base + 3);
    const report = getAccountingReport(db.sqlite, 'wallet:7', base + 3);
    const oracleEvents: CashEvent[] = [
      { id: 'opening', sequence: 0, kind: 'TRANSFER', amount: 100 },
      {
        id: 'buy',
        sequence: 1,
        kind: 'FILL',
        token: 't',
        side: 'BUY',
        shares: 10,
        price: 0.5,
        feeAsset: 'SHARES',
        feeAmount: buyFee.sharesFee,
      },
      {
        id: 'sell',
        sequence: 2,
        kind: 'FILL',
        token: 't',
        side: 'SELL',
        shares: 4,
        price: 0.6,
        feeAsset: 'CASH',
        feeAmount: sellFee.usdcFee,
      },
    ];
    const oracle = reconcileEvents(oracleEvents, { t: 0.7 });
    expect(report.complete).toBe(true);
    expect(report.cash).toBeCloseTo(oracle.cash, 10);
    expect(report.positions[0]?.shares).toBeCloseTo(oracle.positions.get('t')!.shares, 10);
    expect(report.grossRealized).toBeCloseTo(oracle.grossRealized, 10);
    expect(report.cashFees).toBeCloseTo(oracle.cashFees, 10);
    expect(report.netPnl).toBeCloseTo(oracle.netPnl!, 10);
    expect(getAccountingReport(db.sqlite, 'wallet:7', base + 3).reportId).toBe(report.reportId);
    saveAccountingReport(db.sqlite, report);
    db.sqlite.prepare("DELETE FROM latest_features WHERE token_id = 't'").run();
    const partial = getAccountingReport(db.sqlite, 'wallet:7', base + 3);
    expect(partial.netPnl).toBeNull();
    expect(partial.issues).toContainEqual({ code: 'MISSING_MARK', tokenId: 't' });
    expect(getSavedAccountingReport(db.sqlite, report.reportId)).toEqual(report);
    db.sqlite
      .prepare("INSERT INTO latest_features (token_id, ts, mid) VALUES ('t', ?, 0)")
      .run(base + 3);
    const stale = getAccountingReport(db.sqlite, 'wallet:7', base + 60_004);
    expect(stale.netPnl).toBeNull();
    expect(stale.issues).toContainEqual({ code: 'STALE_MARK', tokenId: 't' });
  });

  it('surfaces legacy fills, provisional events, and corrections without posting twice', async () => {
    const db = await createTempDb();
    opened.push(db);
    postAccountingEvent(
      db.sqlite,
      event({ eventKey: 'open', kind: 'OPENING', sourceRef: 'open', cashDelta: 0 }),
    );
    postAccountingEvent(
      db.sqlite,
      event({ eventKey: 'fund', kind: 'TRANSFER', sourceRef: 'fund', cashDelta: 10 }),
    );
    postAccountingEvent(
      db.sqlite,
      event({
        eventKey: 'void',
        kind: 'CORRECTION',
        sourceRef: 'void',
        receiptTs: base + 10,
        correctsEventKey: 'fund',
      }),
    );
    postAccountingEvent(
      db.sqlite,
      event({
        eventKey: 'pending',
        kind: 'TRANSFER',
        sourceRef: 'pending',
        cashDelta: 5,
        finality: 'PROVISIONAL',
      }),
    );
    db.sqlite
      .prepare(
        "INSERT INTO shadow_orders (ts, wallet_id, token_id, side, kind, execution_mode) VALUES (?, 7, 't', 'BUY', 'TAKER_BUY', 'SHADOW')",
      )
      .run(base);
    db.sqlite
      .prepare('INSERT INTO shadow_fills (ts, order_id, price, size) VALUES (?, 1, 0.5, 1)')
      .run(base);
    const report = getAccountingReport(db.sqlite, 'wallet:7', base);
    expect(report.cash).toBe(0);
    expect(getAccountingReport(db.sqlite, 'wallet:7', base, base + 5).cash).toBe(10);
    expect(report.netPnl).toBeNull();
    expect(report.issues.map((issue) => issue.code)).toEqual([
      'PROVISIONAL_EVENT',
      'UNPOSTED_SHADOW_FILL',
    ]);
  });

  it('reconciles opening inventory, transfers and settlement; rejects malformed postings', async () => {
    const db = await createTempDb();
    opened.push(db);
    postAccountingEvent(
      db.sqlite,
      event({
        eventKey: 'opening',
        kind: 'OPENING',
        sourceRef: 'opening',
        cashDelta: 50,
        tokenId: 'settled',
        netSharesDelta: 3,
        price: 0.4,
      }),
    );
    postAccountingEvent(
      db.sqlite,
      event({
        eventKey: 'transfer',
        kind: 'TRANSFER',
        sourceRef: 'transfer',
        eventTs: base + 1,
        cashDelta: -10,
      }),
    );
    const settlement = event({
      eventKey: 'settlement',
      kind: 'SETTLEMENT',
      sourceRef: 'settlement',
      eventTs: base + 2,
      tokenId: 'settled',
      netSharesDelta: -3,
      price: 1,
      cashDelta: 3,
    });
    postAccountingEvent(db.sqlite, settlement);
    const report = getAccountingReport(db.sqlite, 'wallet:7', base + 3);
    expect(report.complete).toBe(true);
    expect(report.cash).toBeCloseTo(43);
    expect(report.externalFunding).toBe(-10);
    expect(report.grossRealized).toBeCloseTo(1.8);
    expect(report.netPnl).toBeCloseTo(1.8);
    expect(report.positions).toEqual([]);
    expect(() =>
      postAccountingEvent(db.sqlite, { ...settlement, eventKey: 'bad-settlement', cashDelta: 2 }),
    ).toThrow('INVALID_SETTLEMENT_POSTING');
    expect(() =>
      postAccountingEvent(
        db.sqlite,
        event({
          eventKey: 'bad-fill',
          kind: 'FILL',
          sourceRef: 'bad-fill',
          tokenId: 't',
          side: 'BUY',
          grossShares: 1,
          netSharesDelta: 1,
          price: 0.5,
          cashDelta: -1,
          feeAsset: 'USDC',
          feeAmount: 0,
          feeEvidence: 'OBSERVED',
        }),
      ),
    ).toThrow('INVALID_FILL_POSTING');
    expect(() =>
      postAccountingEvent(
        db.sqlite,
        event({
          eventKey: 'double-fee',
          kind: 'FILL',
          sourceRef: 'double-fee',
          tokenId: 't',
          side: 'BUY',
          grossShares: 10,
          netSharesDelta: 9.65,
          price: 0.5,
          cashDelta: -5.175,
          feeAsset: 'SHARES',
          feeAmount: 0.35,
          feeEvidence: 'MODELED',
        }),
      ),
    ).toThrow('INVALID_FILL_POSTING');
    postAccountingEvent(
      db.sqlite,
      event({
        eventKey: 'unknown-fee',
        kind: 'FILL',
        sourceRef: 'unknown-fee',
        eventTs: base + 4,
        tokenId: 't',
        side: 'BUY',
        grossShares: 1,
        price: 0.5,
        cashDelta: -0.5,
        feeEvidence: 'MISSING',
      }),
    );
    const partial = getAccountingReport(db.sqlite, 'wallet:7', base + 4);
    expect(partial.netPnl).toBeNull();
    expect(partial.issues).toContainEqual({
      code: 'MISSING_FEE_EVIDENCE',
      eventKey: 'unknown-fee',
      tokenId: 't',
    });
  });

  it.each(['FAILED', 'PROVISIONAL'] as const)(
    'does not apply a %s correction to a valid posting',
    async (finality) => {
      const db = await createTempDb();
      opened.push(db);
      postAccountingEvent(
        db.sqlite,
        event({ eventKey: 'opening', kind: 'OPENING', sourceRef: 'opening', cashDelta: 100 }),
      );
      postAccountingEvent(
        db.sqlite,
        event({
          eventKey: 'funding',
          kind: 'TRANSFER',
          sourceRef: 'funding',
          eventTs: base + 1,
          cashDelta: 10,
        }),
      );
      postAccountingEvent(
        db.sqlite,
        event({
          eventKey: 'correction',
          kind: 'CORRECTION',
          sourceRef: 'correction',
          eventTs: base + 2,
          correctsEventKey: 'funding',
          finality,
        }),
      );
      const report = getAccountingReport(db.sqlite, 'wallet:7', base + 3);
      expect(report.cash).toBe(110);
      expect(report.externalFunding).toBe(10);
      expect(report.complete).toBe(finality === 'FAILED');
      expect(report.issues.map((issue) => issue.code)).toEqual(
        finality === 'PROVISIONAL' ? ['PROVISIONAL_EVENT'] : [],
      );
    },
  );

  it('rejects a BUY whose share fee exceeds its acquired shares', async () => {
    const db = await createTempDb();
    opened.push(db);
    expect(() =>
      postAccountingEvent(
        db.sqlite,
        event({
          eventKey: 'excess-fee',
          kind: 'FILL',
          sourceRef: 'excess-fee',
          tokenId: 't',
          side: 'BUY',
          grossShares: 1,
          netSharesDelta: -1,
          price: 0.5,
          cashDelta: -0.5,
          feeAsset: 'SHARES',
          feeAmount: 2,
          feeEvidence: 'OBSERVED',
        }),
      ),
    ).toThrow('INVALID_FILL_POSTING');
  });

  it('rolls back a fill when its accounting posting fails', async () => {
    const db = await createTempDb();
    opened.push(db);
    const orderId = Number(
      db.sqlite
        .prepare(
          `INSERT INTO shadow_orders
      (ts, wallet_id, token_id, side, kind, execution_mode, price, size, status, filled_size)
      VALUES (?, 7, 't', 'BUY', 'TAKER_BUY', 'SHADOW', 0.5, 2, 'OPEN', 0)`,
        )
        .run(base).lastInsertRowid,
    );
    db.sqlite.exec(`CREATE TRIGGER reject_posting BEFORE INSERT ON accounting_events
      BEGIN SELECT RAISE(ABORT, 'posting rejected'); END`);
    const loop = new ShadowExecutionLoop(
      {
        intervalMs: 1000,
        makerStalenessSec: 30,
        markoutHorizonsMs: [300000],
        makerQueueFillProb: 1,
        makerPriceToleranceBps: 0,
        forceSyntheticFills: false,
        rebalanceEnabled: false,
      },
      { sqlite: db.sqlite, logger },
    );
    expect(() => (loop as any).processTakerOrders()).toThrow('posting rejected');
    expect(
      (
        db.sqlite
          .prepare('SELECT COUNT(*) AS count FROM shadow_fills WHERE order_id = ?')
          .get(orderId) as { count: number }
      ).count,
    ).toBe(0);
    expect(
      (
        db.sqlite
          .prepare('SELECT filled_size AS filledSize FROM shadow_orders WHERE id = ?')
          .get(orderId) as { filledSize: number }
      ).filledSize,
    ).toBe(0);
  });
});
