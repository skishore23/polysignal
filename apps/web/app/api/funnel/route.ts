import { getDb } from "../../../lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_STALENESS_SEC = 120;
const MAX_SPREAD = 0.02;
const MIN_DEPTH = 20;

type TokenGateRow = {
  tokenId: string;
  stalenessSec: number | null;
  spread: number | null;
  bidDepth: number | null;
  askDepth: number | null;
};

function passGate(row: TokenGateRow): boolean {
  const staleness = row.stalenessSec ?? 999;
  const spread = row.spread ?? 1;
  const bidDepth = row.bidDepth ?? 0;
  const askDepth = row.askDepth ?? 0;
  const depth = Math.min(bidDepth, askDepth);
  return staleness < MAX_STALENESS_SEC && spread < MAX_SPREAD && depth >= MIN_DEPTH;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export type FunnelResponse = {
  windowMin: number;
  horizonMs: number;
  since: number;
  throughput: {
    signals_created: number;
    skips_by_reason: Array<{ reason: string; count: number }>;
    orders_submitted: number;
    fills: number;
    markouts_available: number;
  };
  snapshot: {
    tradeable_universe_now: number;
  };
  latency: {
    median_submit_to_fill_ms: number | null;
    median_fill_to_markout_ms: number | null;
  };
};

export async function GET(req: Request): Promise<Response> {
  const { sqlite } = getDb();
  const url = new URL(req.url);
  const windowMin = Math.max(1, Math.min(60, Number(url.searchParams.get("windowMin") ?? 15)));
  const horizonMs = Number(url.searchParams.get("horizonMs") ?? 300000) || 300000;
  const now = Date.now();
  const since = now - windowMin * 60 * 1000;

  const decisionsRow = sqlite
    .prepare(`SELECT COUNT(*) as c FROM decision_log WHERE decision = 'SUBMIT' AND ts >= ?`)
    .get(since) as { c: number };
  const signals_created = decisionsRow?.c ?? 0;

  let skips_by_reason: Array<{ reason: string; count: number }> = [];
  try {
    skips_by_reason = sqlite
      .prepare(
        `SELECT decision_reason as reason, COUNT(*) as count
         FROM decision_log
         WHERE ts >= ? AND decision = 'SKIP'
         GROUP BY decision_reason
         ORDER BY count DESC`
      )
      .all(since) as Array<{ reason: string; count: number }>;
  } catch {
    // decision_log may not exist
  }

  const ordersRow = sqlite
    .prepare(
      `SELECT COUNT(*) as c FROM shadow_orders WHERE ts >= ? AND (decision = 'SUBMIT' OR decision IS NULL)`
    )
    .get(since) as { c: number };
  const orders_submitted = ordersRow?.c ?? 0;

  const fillsRow = sqlite
    .prepare(
      `SELECT COUNT(*) as c FROM shadow_fills f WHERE f.ts >= ? AND (f.method IS NULL OR f.method != 'synthetic_fill')`
    )
    .get(since) as { c: number };
  const fills = fillsRow?.c ?? 0;

  const markoutsRow = sqlite
    .prepare(
      `SELECT COUNT(DISTINCT f.id) as c
       FROM shadow_fills f
       JOIN shadow_markouts m ON m.fill_id = f.id AND m.horizon_ms = ?
       WHERE f.ts >= ? AND (f.method IS NULL OR f.method != 'synthetic_fill')`
    )
    .get(horizonMs, since) as { c: number };
  const markouts_available = markoutsRow?.c ?? 0;

  let tradeable_universe_now = 0;
  try {
    const tokenRows = sqlite
      .prepare(
        `SELECT lf.token_id as tokenId, lf.staleness_sec as stalenessSec, lf.spread,
                lf.bid_depth_top as bidDepth, lf.ask_depth_top as askDepth
         FROM latest_features lf
         WHERE lf.mid IS NOT NULL`
      )
      .all() as TokenGateRow[];
    tradeable_universe_now = tokenRows.filter((r) => passGate(r)).length;
  } catch {
    // latest_features may be empty
  }

  const submitToFillRows = sqlite
    .prepare(
      `SELECT f.ts as fillTs, o.ts as orderTs
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE f.ts >= ? AND (f.method IS NULL OR f.method != 'synthetic_fill')`
    )
    .all(since) as Array<{ fillTs: number; orderTs: number }>;
  const submitToFillDeltas = submitToFillRows
    .map((r) => r.fillTs - r.orderTs)
    .filter((d) => Number.isFinite(d));
  const median_submit_to_fill_ms = median(submitToFillDeltas);

  const fillToMarkoutRows = sqlite
    .prepare(
      `SELECT m.ts as markoutTs, f.ts as fillTs
       FROM shadow_markouts m
       JOIN shadow_fills f ON f.id = m.fill_id
       WHERE m.horizon_ms = ? AND f.ts >= ? AND (f.method IS NULL OR f.method != 'synthetic_fill')`
    )
    .all(horizonMs, since) as Array<{ markoutTs: number; fillTs: number }>;
  const fillToMarkoutDeltas = fillToMarkoutRows
    .map((r) => r.markoutTs - r.fillTs)
    .filter((d) => Number.isFinite(d));
  const median_fill_to_markout_ms = median(fillToMarkoutDeltas);

  const response: FunnelResponse = {
    windowMin,
    horizonMs,
    since,
    throughput: {
      signals_created,
      skips_by_reason,
      orders_submitted,
      fills,
      markouts_available
    },
    snapshot: {
      tradeable_universe_now
    },
    latency: {
      median_submit_to_fill_ms,
      median_fill_to_markout_ms
    }
  };

  return Response.json(response);
}
