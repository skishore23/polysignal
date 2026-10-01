import {
  getAccountingReport,
  getSavedAccountingReport,
  saveAccountingReport,
} from '@polysignal/storage';
import { getDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Scope = { walletId: number; valuationTs: number; asOfReceiptTs?: number };
const parseScope = (raw: Record<string, unknown>): Scope | null => {
  const numeric = (value: unknown): number =>
    typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
      ? Number(value)
      : Number.NaN;
  const walletId = numeric(raw.walletId);
  const valuationTs = numeric(raw.valuationTs);
  const asOfReceiptTs = raw.asOfReceiptTs == null ? undefined : numeric(raw.asOfReceiptTs);
  if (
    !Number.isSafeInteger(walletId) ||
    walletId <= 0 ||
    !Number.isSafeInteger(valuationTs) ||
    valuationTs < 0 ||
    (asOfReceiptTs != null && (!Number.isSafeInteger(asOfReceiptTs) || asOfReceiptTs < 0))
  )
    return null;
  return { walletId, valuationTs, asOfReceiptTs };
};
const invalid = () =>
  Response.json(
    { error: 'walletId, valuationTs and optional asOfReceiptTs must be valid integers' },
    { status: 400 },
  );

/** Generate a live projection, or retrieve a previously frozen report by ID. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    const reportId = url.searchParams.get('reportId');
    if (reportId) {
      const saved = getSavedAccountingReport(getDb().sqlite, reportId);
      return saved
        ? Response.json(saved)
        : Response.json({ error: 'report not found' }, { status: 404 });
    }
    const scope = parseScope(Object.fromEntries(url.searchParams));
    if (!scope) return invalid();
    return Response.json(
      getAccountingReport(
        getDb().sqlite,
        `wallet:${scope.walletId}`,
        scope.valuationTs,
        scope.asOfReceiptTs,
      ),
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** Freeze the current projection, including marks and issue list, for later audit. */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return invalid();
  }
  const scope = parseScope(
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {},
  );
  if (!scope) return invalid();
  try {
    const sqlite = getDb().sqlite;
    const report = getAccountingReport(
      sqlite,
      `wallet:${scope.walletId}`,
      scope.valuationTs,
      scope.asOfReceiptTs,
    );
    saveAccountingReport(sqlite, report);
    return Response.json(report);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
