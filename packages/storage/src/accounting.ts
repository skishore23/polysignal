import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export const ACCOUNTING_VERSION = 'shadow-accounting-v1';
export const MAX_MARK_AGE_MS = 60_000;
export type AccountingKind = 'OPENING' | 'TRANSFER' | 'FILL' | 'SETTLEMENT' | 'CORRECTION';
export type AccountingFinality = 'SIMULATED' | 'CONFIRMED' | 'PROVISIONAL' | 'FAILED';
export type AccountingEvent = {
  eventKey: string;
  accountKey: string;
  kind: AccountingKind;
  source: string;
  sourceRef: string;
  orderId?: number | null;
  tradeId?: string | null;
  tokenId?: string | null;
  side?: 'BUY' | 'SELL' | null;
  eventTs: number;
  receiptTs: number;
  processingOrder: number;
  finality: AccountingFinality;
  grossShares?: number | null;
  netSharesDelta?: number | null;
  price?: number | null;
  cashDelta?: number | null;
  feeAsset?: 'USDC' | 'SHARES' | null;
  feeAmount?: number | null;
  feeEvidence: 'OBSERVED' | 'MODELED' | 'MISSING' | 'NOT_APPLICABLE';
  ruleVersion: string;
  roundingPolicy: string;
  collateralAsset: 'USDC';
  correctsEventKey?: string | null;
};

const fields = [
  'eventKey',
  'accountKey',
  'kind',
  'source',
  'sourceRef',
  'orderId',
  'tradeId',
  'tokenId',
  'side',
  'eventTs',
  'receiptTs',
  'processingOrder',
  'finality',
  'grossShares',
  'netSharesDelta',
  'price',
  'cashDelta',
  'feeAsset',
  'feeAmount',
  'feeEvidence',
  'ruleVersion',
  'roundingPolicy',
  'collateralAsset',
  'correctsEventKey',
] as const;
const columns = [
  'event_key',
  'account_key',
  'kind',
  'source',
  'source_ref',
  'order_id',
  'trade_id',
  'token_id',
  'side',
  'event_ts',
  'receipt_ts',
  'processing_order',
  'finality',
  'gross_shares',
  'net_shares_delta',
  'price',
  'cash_delta',
  'fee_asset',
  'fee_amount',
  'fee_evidence',
  'rule_version',
  'rounding_policy',
  'collateral_asset',
  'corrects_event_key',
];
const selected = columns.map((column, i) => `${column} AS ${fields[i]}`).join(', ');
const finite = (value: number | null | undefined): value is number =>
  value != null && Number.isFinite(value);
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Duplicate keys are idempotent only when every economic field agrees. */
export function postAccountingEvent(sqlite: Database.Database, input: AccountingEvent): boolean {
  const event = Object.fromEntries(fields.map((key) => [key, input[key] ?? null])) as Record<
    string,
    unknown
  >;
  const near = (actual: number | null | undefined, expected: number): boolean =>
    finite(actual) && Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected));
  if (
    !input.eventKey ||
    !input.accountKey ||
    !input.source ||
    !input.sourceRef ||
    !input.ruleVersion ||
    !Number.isSafeInteger(input.eventTs) ||
    !Number.isSafeInteger(input.receiptTs) ||
    !Number.isSafeInteger(input.processingOrder) ||
    !['OPENING', 'TRANSFER', 'FILL', 'SETTLEMENT', 'CORRECTION'].includes(input.kind) ||
    !['SIMULATED', 'CONFIRMED', 'PROVISIONAL', 'FAILED'].includes(input.finality) ||
    !['OBSERVED', 'MODELED', 'MISSING', 'NOT_APPLICABLE'].includes(input.feeEvidence) ||
    input.collateralAsset !== 'USDC' ||
    [input.grossShares, input.netSharesDelta, input.price, input.cashDelta, input.feeAmount].some(
      (value) => value != null && !Number.isFinite(value),
    ) ||
    (input.feeAmount != null && input.feeAmount < 0) ||
    (input.kind === 'FILL' &&
      (!input.tokenId ||
        !input.side ||
        !finite(input.grossShares) ||
        input.grossShares <= 0 ||
        !finite(input.price) ||
        input.price <= 0 ||
        input.price >= 1)) ||
    (input.kind === 'CORRECTION' && !input.correctsEventKey) ||
    (input.kind !== 'CORRECTION' && input.correctsEventKey != null)
  ) {
    throw new Error('INVALID_ACCOUNTING_EVENT');
  }
  if (input.kind === 'FILL' && input.feeEvidence !== 'MISSING') {
    if (
      !finite(input.feeAmount) ||
      !input.feeAsset ||
      (input.side === 'SELL' && input.feeAsset === 'SHARES')
    )
      throw new Error('INVALID_FILL_POSTING');
    const q = input.grossShares as number;
    const p = input.price as number;
    const cashFee = input.feeAsset === 'USDC' ? input.feeAmount : 0;
    const expectedCash = input.side === 'BUY' ? -q * p - cashFee : q * p - cashFee;
    const expectedShares =
      input.side === 'BUY' ? q - (input.feeAsset === 'SHARES' ? input.feeAmount : 0) : -q;
    if (
      (input.side === 'BUY' && expectedShares <= 0) ||
      !near(input.cashDelta, expectedCash) ||
      !near(input.netSharesDelta, expectedShares)
    )
      throw new Error('INVALID_FILL_POSTING');
  }
  if (
    input.kind === 'SETTLEMENT' &&
    (!input.tokenId ||
      !finite(input.netSharesDelta) ||
      input.netSharesDelta >= 0 ||
      !finite(input.price) ||
      ![0, 1].includes(input.price) ||
      !near(input.cashDelta, -input.netSharesDelta * input.price))
  )
    throw new Error('INVALID_SETTLEMENT_POSTING');
  if (
    input.kind === 'OPENING' &&
    (!finite(input.cashDelta) ||
      (input.tokenId != null &&
        (!finite(input.netSharesDelta) ||
          input.netSharesDelta < 0 ||
          !finite(input.price) ||
          input.price < 0 ||
          input.price > 1)))
  )
    throw new Error('INVALID_OPENING_POSTING');
  if (input.kind === 'TRANSFER' && (!finite(input.cashDelta) || input.tokenId != null))
    throw new Error('INVALID_TRANSFER_POSTING');
  if (input.correctsEventKey) {
    const target = sqlite
      .prepare('SELECT account_key AS accountKey, kind FROM accounting_events WHERE event_key = ?')
      .get(input.correctsEventKey) as { accountKey: string; kind: AccountingKind } | undefined;
    if (!target || target.accountKey !== input.accountKey || target.kind === 'CORRECTION')
      throw new Error('INVALID_CORRECTION_TARGET');
  }
  const result = sqlite
    .prepare(
      `INSERT OR IGNORE INTO accounting_events (${columns.join(', ')}) VALUES (${fields.map((field) => `@${field}`).join(', ')})`,
    )
    .run(event);
  if (result.changes) return true;
  const prior = sqlite
    .prepare(`SELECT ${selected} FROM accounting_events WHERE event_key = ?`)
    .get(input.eventKey) as AccountingEvent | undefined;
  if (!prior || digest(prior) !== digest(event)) throw new Error('ACCOUNTING_EVENT_ID_CONFLICT');
  return false;
}

export type AccountingIssue = {
  code: string;
  eventKey?: string;
  tokenId?: string;
  fillId?: number;
};
export type AccountingReport = ReturnType<typeof getAccountingReport>;

export function saveAccountingReport(sqlite: Database.Database, report: AccountingReport): void {
  const json = JSON.stringify(report);
  sqlite
    .prepare(
      'INSERT OR IGNORE INTO accounting_reports (report_id, report_json, created_ts) VALUES (?, ?, ?)',
    )
    .run(report.reportId, json, Date.now());
  const saved = sqlite
    .prepare('SELECT report_json AS reportJson FROM accounting_reports WHERE report_id = ?')
    .get(report.reportId) as { reportJson: string } | undefined;
  if (saved?.reportJson !== json) throw new Error('ACCOUNTING_REPORT_ID_CONFLICT');
}

export function getSavedAccountingReport(
  sqlite: Database.Database,
  reportId: string,
): AccountingReport | null {
  const row = sqlite
    .prepare('SELECT report_json AS reportJson FROM accounting_reports WHERE report_id = ?')
    .get(reportId) as { reportJson: string } | undefined;
  return row ? (JSON.parse(row.reportJson) as AccountingReport) : null;
}

/** Folds immutable postings in declared processing order. Missing evidence makes net P&L null. */
export function getAccountingReport(
  sqlite: Database.Database,
  accountKey: string,
  valuationTs: number,
  asOfReceiptTs?: number,
) {
  if (
    !accountKey ||
    !Number.isSafeInteger(valuationTs) ||
    (asOfReceiptTs != null && !Number.isSafeInteger(asOfReceiptTs))
  )
    throw new Error('INVALID_REPORT_SCOPE');
  return sqlite.transaction(() => {
    const events = sqlite
      .prepare(
        `SELECT ${selected} FROM accounting_events
      WHERE account_key = ? AND event_ts <= ? AND receipt_ts <= ?
      ORDER BY event_ts, processing_order, event_key`,
      )
      .all(accountKey, valuationTs, asOfReceiptTs ?? Number.MAX_SAFE_INTEGER) as AccountingEvent[];
    const corrections = new Set(
      events
        .filter(
          (event) =>
            event.kind === 'CORRECTION' && ['CONFIRMED', 'SIMULATED'].includes(event.finality),
        )
        .map((event) => event.correctsEventKey),
    );
    const issues: AccountingIssue[] = [];
    const positions = new Map<string, { shares: number; basis: number }>();
    let cash = 0;
    let openingCash = 0;
    let externalFunding = 0;
    let grossRealized = 0;
    let cashFees = 0;
    let shareFees = 0;
    let openingSeen = false;
    const EPS = 1e-9;
    for (const event of events) {
      if (corrections.has(event.eventKey)) continue;
      if (event.finality === 'FAILED') continue;
      if (event.finality === 'PROVISIONAL') {
        issues.push({
          code: 'PROVISIONAL_EVENT',
          eventKey: event.eventKey,
          tokenId: event.tokenId ?? undefined,
        });
        continue;
      }
      if (event.kind === 'CORRECTION') continue;
      if (
        event.feeEvidence === 'MISSING' ||
        (event.kind === 'FILL' && (!finite(event.feeAmount) || !event.feeAsset))
      ) {
        issues.push({
          code: 'MISSING_FEE_EVIDENCE',
          eventKey: event.eventKey,
          tokenId: event.tokenId ?? undefined,
        });
        continue;
      }
      if (!finite(event.cashDelta)) {
        issues.push({ code: 'MISSING_CASH_MOVEMENT', eventKey: event.eventKey });
        continue;
      }
      cash += event.cashDelta;
      if (event.kind === 'TRANSFER') {
        externalFunding += event.cashDelta;
        continue;
      }
      if (event.kind === 'OPENING') {
        openingSeen = true;
        openingCash += event.cashDelta;
      }
      if (!event.tokenId) continue;
      const previous = positions.get(event.tokenId) ?? { shares: 0, basis: 0 };
      if (!finite(event.netSharesDelta)) {
        issues.push({
          code: 'MISSING_SHARE_MOVEMENT',
          eventKey: event.eventKey,
          tokenId: event.tokenId,
        });
        continue;
      }
      const nextShares = previous.shares + event.netSharesDelta;
      if (nextShares < -EPS) {
        issues.push({
          code: 'UNSUPPORTED_SHORT',
          eventKey: event.eventKey,
          tokenId: event.tokenId,
        });
        continue;
      }
      if (event.kind === 'OPENING' || (event.kind === 'FILL' && event.side === 'BUY')) {
        const cost =
          event.kind === 'OPENING'
            ? event.netSharesDelta * (event.price ?? 0)
            : (event.grossShares ?? 0) * (event.price ?? 0);
        const basis = nextShares > EPS ? (previous.shares * previous.basis + cost) / nextShares : 0;
        positions.set(event.tokenId, { shares: nextShares, basis });
      } else {
        if (event.kind === 'FILL') {
          grossRealized += (event.grossShares ?? 0) * ((event.price ?? 0) - previous.basis);
        } else if (event.kind === 'SETTLEMENT') {
          grossRealized += -event.netSharesDelta * ((event.price ?? 0) - previous.basis);
        }
        positions.set(event.tokenId, {
          shares: nextShares > EPS ? nextShares : 0,
          basis: nextShares > EPS ? previous.basis : 0,
        });
      }
      if (event.kind === 'FILL') {
        if (event.feeAsset === 'USDC') cashFees += event.feeAmount ?? 0;
        else shareFees += event.feeAmount ?? 0;
      }
    }
    if (!openingSeen) issues.push({ code: 'MISSING_OPENING_STATE' });
    const positionRows = [...positions]
      .filter(([, p]) => p.shares > EPS)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tokenId, position]) => {
        const row = sqlite
          .prepare(
            'SELECT mid, ts FROM latest_features WHERE token_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1',
          )
          .get(tokenId, valuationTs) as { mid: number | null; ts: number } | undefined;
        const mark = row?.mid;
        if (!finite(mark) || mark < 0 || mark > 1) issues.push({ code: 'MISSING_MARK', tokenId });
        else if (row && valuationTs - row.ts > MAX_MARK_AGE_MS)
          issues.push({ code: 'STALE_MARK', tokenId });
        const valid =
          finite(mark) &&
          mark >= 0 &&
          mark <= 1 &&
          row != null &&
          valuationTs - row.ts <= MAX_MARK_AGE_MS;
        return { tokenId, ...position, mark: valid ? mark : null, markTs: row?.ts ?? null };
      });
    const legacy = sqlite
      .prepare(
        `SELECT f.id AS fillId, o.token_id AS tokenId FROM shadow_fills f
      JOIN shadow_orders o ON o.id = f.order_id LEFT JOIN accounting_events e ON e.event_key = 'shadow-fill:' || f.id
      WHERE o.execution_mode = 'SHADOW' AND ('wallet:' || COALESCE(o.wallet_id, 'unattributed')) = ?
        AND f.ts <= ? AND e.id IS NULL ORDER BY f.id`,
      )
      .all(accountKey, valuationTs) as Array<{ fillId: number; tokenId: string }>;
    issues.push(
      ...legacy.map((row) => ({
        code: 'UNPOSTED_SHADOW_FILL',
        fillId: row.fillId,
        tokenId: row.tokenId,
      })),
    );
    const unrealized = positionRows.every((p) => p.mark != null)
      ? positionRows.reduce((sum, p) => sum + p.shares * ((p.mark as number) - p.basis), 0)
      : null;
    const complete = issues.length === 0;
    const codeVersion =
      process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? 'unavailable';
    const inputHash = digest({
      accountKey,
      events,
      positionRows,
      legacy,
      valuationTs,
      asOfReceiptTs: asOfReceiptTs ?? null,
    });
    return {
      reportId: digest({ inputHash, codeVersion, accountingVersion: ACCOUNTING_VERSION }),
      inputHash,
      codeVersion,
      accountingVersion: ACCOUNTING_VERSION,
      accountKey,
      valuationTs,
      asOfReceiptTs: asOfReceiptTs ?? null,
      scope: 'paper-shadow',
      complete,
      issues,
      assurance: {
        postingValidated: complete,
        dataComplete: complete,
        sourceVerified: false,
        codePinned: codeVersion !== 'unavailable',
        maxMarkAgeMs: MAX_MARK_AGE_MS,
        simulationAssumptions: [
          'shadow fills are simulated',
          'maker fee is modeled as zero',
          'taker fee uses the declared paper rule version',
        ],
      },
      cash,
      openingCash,
      externalFunding,
      grossRealized,
      cashFees,
      shareFees,
      unrealized,
      netPnl: complete && unrealized != null ? grossRealized - cashFees + unrealized : null,
      positions: positionRows,
      events,
    };
  })();
}
