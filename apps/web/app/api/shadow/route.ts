import { getDb } from "../../../lib/db";

type ShadowSummary = {
  windowHours: number;
  maker: {
    orders: number;
    fills: number;
    fillRate: number | null;
    markout5s: number | null;
    markout30s: number | null;
    lastTs: number | null;
    realFills: number;
    syntheticFills: number;
    syntheticRatio: number | null;
  };
  taker: {
    orders: number;
    fills: number;
    fillRate: number | null;
    markout5s: number | null;
    markout30s: number | null;
    lastTs: number | null;
    realFills: number;
    syntheticFills: number;
    syntheticRatio: number | null;
  };
};

type CachedSummaryRow = {
  updated_ts: number;
  window_hours: number;
  maker_orders: number;
  maker_fills: number;
  maker_real_fills: number;
  maker_synthetic_fills: number;
  maker_markout_5s_bps: number | null;
  maker_markout_30s_bps: number | null;
  maker_last_ts: number | null;
  taker_orders: number;
  taker_fills: number;
  taker_real_fills: number;
  taker_synthetic_fills: number;
  taker_markout_5s_bps: number | null;
  taker_markout_30s_bps: number | null;
  taker_last_ts: number | null;
};

const tableExists = (sqlite: ReturnType<typeof getDb>["sqlite"], name: string): boolean => {
  const row = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
  return row !== undefined;
};

const getCachedSummary = (sqlite: ReturnType<typeof getDb>["sqlite"]): CachedSummaryRow | null => {
  if (!tableExists(sqlite, "shadow_summary_latest")) return null;
  const row = sqlite.prepare("SELECT * FROM shadow_summary_latest WHERE id = 1").get();
  return (row as CachedSummaryRow) ?? null;
};

const buildFromCache = (cached: CachedSummaryRow): ShadowSummary => ({
  windowHours: cached.window_hours,
  maker: {
    orders: cached.maker_orders,
    fills: cached.maker_fills,
    realFills: cached.maker_real_fills,
    syntheticFills: cached.maker_synthetic_fills,
    syntheticRatio: cached.maker_fills > 0 ? cached.maker_synthetic_fills / cached.maker_fills : null,
    fillRate: cached.maker_orders > 0 ? cached.maker_fills / cached.maker_orders : null,
    markout5s: cached.maker_markout_5s_bps,
    markout30s: cached.maker_markout_30s_bps,
    lastTs: cached.maker_last_ts
  },
  taker: {
    orders: cached.taker_orders,
    fills: cached.taker_fills,
    realFills: cached.taker_real_fills,
    syntheticFills: cached.taker_synthetic_fills,
    syntheticRatio: cached.taker_fills > 0 ? cached.taker_synthetic_fills / cached.taker_fills : null,
    fillRate: cached.taker_orders > 0 ? cached.taker_fills / cached.taker_orders : null,
    markout5s: cached.taker_markout_5s_bps,
    markout30s: cached.taker_markout_30s_bps,
    lastTs: cached.taker_last_ts
  }
});

const computeFreshSummary = (
  sqlite: ReturnType<typeof getDb>["sqlite"],
  walletId: number | null,
  windowHours: number
): ShadowSummary => {
  const since = Date.now() - windowHours * 60 * 60 * 1000;
  const idClause = walletId != null && Number.isFinite(walletId) ? "AND wallet_id = @walletId" : "";

  const makerOrders = (sqlite.prepare(
    `SELECT COUNT(*) as c FROM shadow_orders
     WHERE ts >= @since AND kind IN ('MAKER_BID','MAKER_ASK')
       AND execution_mode = 'SHADOW' ${idClause}`
  ).get({ since, walletId }) as { c: number }).c;

  const makerFills = (sqlite.prepare(
    `SELECT COUNT(*) as c
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE f.ts >= @since AND o.kind IN ('MAKER_BID','MAKER_ASK')
       AND o.execution_mode = 'SHADOW' ${idClause.replace("wallet_id", "o.wallet_id")}`
  ).get({ since, walletId }) as { c: number }).c;

  const makerRealFills = (sqlite.prepare(
    `SELECT COUNT(*) as c
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE f.ts >= @since
       AND o.kind IN ('MAKER_BID','MAKER_ASK')
       AND o.execution_mode = 'SHADOW'
       AND f.method != 'synthetic_fill'
       ${idClause.replace("wallet_id", "o.wallet_id")}`
  ).get({ since, walletId }) as { c: number }).c;

  const makerSyntheticFills = Math.max(0, makerFills - makerRealFills);

  const takerOrders = (sqlite.prepare(
    `SELECT COUNT(*) as c FROM shadow_orders
     WHERE ts >= @since AND kind IN ('TAKER_BUY','TAKER_SELL')
       AND execution_mode = 'SHADOW' ${idClause}`
  ).get({ since, walletId }) as { c: number }).c;

  const takerFills = (sqlite.prepare(
    `SELECT COUNT(*) as c
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE f.ts >= @since AND o.kind IN ('TAKER_BUY','TAKER_SELL')
       AND o.execution_mode = 'SHADOW' ${idClause.replace("wallet_id", "o.wallet_id")}`
  ).get({ since, walletId }) as { c: number }).c;

  const takerRealFills = (sqlite.prepare(
    `SELECT COUNT(*) as c
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE f.ts >= @since
       AND o.kind IN ('TAKER_BUY','TAKER_SELL')
       AND o.execution_mode = 'SHADOW'
       AND f.method != 'synthetic_fill'
       ${idClause.replace("wallet_id", "o.wallet_id")}`
  ).get({ since, walletId }) as { c: number }).c;

  const takerSyntheticFills = Math.max(0, takerFills - takerRealFills);

  const makerMarkout5s = (sqlite.prepare(
    `SELECT AVG(m.markout_bps) as avg_bps
     FROM shadow_markouts m
     JOIN shadow_fills f ON f.id = m.fill_id
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE m.horizon_ms = 5000 AND m.ts >= @since AND o.kind IN ('MAKER_BID','MAKER_ASK')
       AND o.execution_mode = 'SHADOW' ${idClause.replace("wallet_id", "o.wallet_id")}`
  ).get({ since, walletId }) as { avg_bps: number | null }).avg_bps;

  const makerMarkout30s = (sqlite.prepare(
    `SELECT AVG(m.markout_bps) as avg_bps
     FROM shadow_markouts m
     JOIN shadow_fills f ON f.id = m.fill_id
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE m.horizon_ms = 30000 AND m.ts >= @since AND o.kind IN ('MAKER_BID','MAKER_ASK')
       AND o.execution_mode = 'SHADOW' ${idClause.replace("wallet_id", "o.wallet_id")}`
  ).get({ since, walletId }) as { avg_bps: number | null }).avg_bps;

  const takerMarkout5s = (sqlite.prepare(
    `SELECT AVG(m.markout_bps) as avg_bps
     FROM shadow_markouts m
     JOIN shadow_fills f ON f.id = m.fill_id
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE m.horizon_ms = 5000 AND m.ts >= @since AND o.kind IN ('TAKER_BUY','TAKER_SELL')
       AND o.execution_mode = 'SHADOW' ${idClause.replace("wallet_id", "o.wallet_id")}`
  ).get({ since, walletId }) as { avg_bps: number | null }).avg_bps;

  const takerMarkout30s = (sqlite.prepare(
    `SELECT AVG(m.markout_bps) as avg_bps
     FROM shadow_markouts m
     JOIN shadow_fills f ON f.id = m.fill_id
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE m.horizon_ms = 30000 AND m.ts >= @since AND o.kind IN ('TAKER_BUY','TAKER_SELL')
       AND o.execution_mode = 'SHADOW' ${idClause.replace("wallet_id", "o.wallet_id")}`
  ).get({ since, walletId }) as { avg_bps: number | null }).avg_bps;

  const makerLastTs = (sqlite.prepare(
    `SELECT MAX(ts) as ts FROM shadow_orders
     WHERE kind IN ('MAKER_BID','MAKER_ASK')
       AND execution_mode = 'SHADOW' ${idClause}`
  ).get({ walletId }) as { ts: number | null }).ts;

  const takerLastTs = (sqlite.prepare(
    `SELECT MAX(ts) as ts FROM shadow_orders
     WHERE kind IN ('TAKER_BUY','TAKER_SELL')
       AND execution_mode = 'SHADOW' ${idClause}`
  ).get({ walletId }) as { ts: number | null }).ts;

  return {
    windowHours,
    maker: {
      orders: makerOrders,
      fills: makerFills,
      realFills: makerRealFills,
      syntheticFills: makerSyntheticFills,
      syntheticRatio: makerFills > 0 ? makerSyntheticFills / makerFills : null,
      fillRate: makerOrders > 0 ? makerFills / makerOrders : null,
      markout5s: makerMarkout5s ?? null,
      markout30s: makerMarkout30s ?? null,
      lastTs: makerLastTs ?? null
    },
    taker: {
      orders: takerOrders,
      fills: takerFills,
      realFills: takerRealFills,
      syntheticFills: takerSyntheticFills,
      syntheticRatio: takerFills > 0 ? takerSyntheticFills / takerFills : null,
      fillRate: takerOrders > 0 ? takerFills / takerOrders : null,
      markout5s: takerMarkout5s ?? null,
      markout30s: takerMarkout30s ?? null,
      lastTs: takerLastTs ?? null
    }
  };
};

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const walletIdParam = url.searchParams.get("walletId");
    const walletId = walletIdParam ? Number(walletIdParam) : null;
    const windowHours = Number(url.searchParams.get("hours") ?? 24);

    const { sqlite } = getDb();

    if (walletId == null && windowHours === 24) {
      const cached = getCachedSummary(sqlite);
      if (cached && cached.updated_ts > Date.now() - 5 * 60 * 1000) {
        return Response.json(buildFromCache(cached));
      }
    }

    const payload = computeFreshSummary(sqlite, walletId, windowHours);
    return Response.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
