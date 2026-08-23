import { getDb } from "../../../lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_STALENESS_SEC = 120;
const MAX_SPREAD = 0.02;
const MIN_DEPTH = 20;

type TokenGateRow = {
  tokenId: string;
  stalenessSec: number | null;
  spread: number | null;
  mid: number | null;
  bidDepth: number | null;
  askDepth: number | null;
};

type SkipByReason = { reason: string; count: number };

type FailReason = "staleness" | "spread" | "depth";

type LiquidityGateResponse = {
  tokens: Array<{
    tokenId: string;
    freshnessSec: number | null;
    spreadBps: number | null;
    depth: number | null;
    pass: boolean;
    failReason?: FailReason;
    updatesPerMin: number | null;
  }>;
  global: {
    submits: number;
    skipsByReason: SkipByReason[];
    fills: number;
    tradeableUniverseSize: number;
    failCountByReason: { staleness: number; spread: number; depth: number };
  };
};

function passGate(row: TokenGateRow): boolean {
  const staleness = row.stalenessSec ?? 999;
  const spread = row.spread ?? 1;
  const bidDepth = row.bidDepth ?? 0;
  const askDepth = row.askDepth ?? 0;
  const depth = Math.min(bidDepth, askDepth);
  return staleness < MAX_STALENESS_SEC && spread < MAX_SPREAD && depth >= MIN_DEPTH;
}

function failReasonFor(row: TokenGateRow): FailReason | undefined {
  if (passGate(row)) return undefined;
  const staleness = row.stalenessSec ?? 999;
  const spread = row.spread ?? 1;
  const bidDepth = row.bidDepth ?? 0;
  const askDepth = row.askDepth ?? 0;
  const depth = Math.min(bidDepth, askDepth);
  if (staleness >= MAX_STALENESS_SEC) return "staleness";
  if (spread >= MAX_SPREAD) return "spread";
  if (depth < MIN_DEPTH) return "depth";
  return "staleness";
}

export async function GET(): Promise<Response> {
  const { sqlite } = getDb();
  const now = Date.now();
  const since = now - WINDOW_MS;

  const tokenRows = sqlite
    .prepare(
      `SELECT lf.token_id as tokenId, lf.staleness_sec as stalenessSec, lf.spread, lf.mid,
              lf.bid_depth_top as bidDepth, lf.ask_depth_top as askDepth
       FROM latest_features lf
       LEFT JOIN tokens t ON t.id = lf.token_id
       LEFT JOIN markets m ON m.id = t.market_id
       WHERE lf.mid IS NOT NULL
       ORDER BY COALESCE(m.volume, 0) DESC
       LIMIT 100`
    )
    .all() as TokenGateRow[];

  let tradeableUniverseSize = 0;
  const failCountByReason = { staleness: 0, spread: 0, depth: 0 };

  const tokens = tokenRows.map((row) => {
    const stalenessSec = row.stalenessSec != null ? row.stalenessSec : 999;
    const spreadBps = row.mid != null && row.spread != null ? (row.spread / row.mid) * 10_000 : null;
    const depth = row.bidDepth != null && row.askDepth != null ? Math.min(row.bidDepth, row.askDepth) : null;
    const pass = passGate(row);
    if (pass) tradeableUniverseSize += 1;
    const failReason = failReasonFor(row);
    if (failReason) failCountByReason[failReason] += 1;
    const updatesPerMin = stalenessSec < 60 && stalenessSec > 0 ? 60 / stalenessSec : null;
    return {
      tokenId: row.tokenId,
      freshnessSec: row.stalenessSec,
      spreadBps,
      depth,
      pass,
      ...(failReason != null ? { failReason } : {}),
      updatesPerMin
    };
  });

  const submitsRow = sqlite
    .prepare(
      `SELECT COUNT(*) as c FROM shadow_orders WHERE ts >= ? AND (decision = 'SUBMIT' OR decision IS NULL)`
    )
    .get(since) as { c: number };
  const submits = submitsRow?.c ?? 0;

  let skipRows: SkipByReason[] = [];
  try {
    skipRows = sqlite
      .prepare(
        `SELECT decision_reason as reason, COUNT(*) as count
         FROM decision_log
         WHERE ts >= ? AND decision = 'SKIP'
         GROUP BY decision_reason
         ORDER BY count DESC`
      )
      .all(since) as SkipByReason[];
  } catch {
    // decision_log may not exist before migration
  }

  const fillsRow = sqlite
    .prepare(`SELECT COUNT(*) as c FROM shadow_fills WHERE ts >= ?`)
    .get(since) as { c: number };
  const fills = fillsRow?.c ?? 0;

  const response: LiquidityGateResponse = {
    tokens,
    global: {
      submits,
      skipsByReason: skipRows,
      fills,
      tradeableUniverseSize,
      failCountByReason
    }
  };

  return Response.json(response);
}
