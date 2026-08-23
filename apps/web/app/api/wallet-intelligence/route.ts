import { getDb } from "../../../lib/db";
import { getPerformanceMetrics } from "../../../lib/performance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MakerStats = {
  openPositions: number;
  totalRealized: number;
  totalUnrealized: number;
  netPnl: number;
  avgSpreadCapture: number;
  avgFillRate: number;
  fillsLast1h: number;
  longExposure: number;
  shortExposure: number;
  inventorySkew: number;
};

type MakerFill = {
  tokenId: string;
  question: string | null;
  outcome: string | null;
  side: string;
  price: number;
  size: number;
  ts: number;
};

type MakerRiskPosition = {
  tokenId: string;
  question: string | null;
  outcome: string | null;
  position: number;
  avgEntry: number;
  mid: number | null;
  unrealized: number;
  pnlPct: number;
  riskType: "high_exposure" | "underwater" | "inventory_imbalance";
};

type SystemHealth = {
  feedFreshnessSec: number;
  activeTokens: number;
  signalsLast5m: number;
  isHealthy: boolean;
};

type IntelligenceResponse = {
  makerStats: MakerStats | null;
  makerFills: MakerFill[];
  makerRiskPositions: MakerRiskPosition[];
  systemHealth: SystemHealth;
  isMakerWallet: boolean;
};

export async function GET(req: Request) {
  const { sqlite } = getDb();
  const url = new URL(req.url);
  const walletIdParam = url.searchParams.get("walletId");
  const walletId = walletIdParam ? Number(walletIdParam) : null;

  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;

  // System health
  const latestFeature = sqlite
    .prepare("SELECT MAX(ts) as maxTs FROM latest_features")
    .get() as { maxTs: number | null } | undefined;
  const feedFreshnessSec = latestFeature?.maxTs
    ? Math.round((now - latestFeature.maxTs) / 1000)
    : 999;

  const activeTokens = (
    sqlite.prepare("SELECT COUNT(*) as cnt FROM latest_features WHERE ts > ?").get(fiveMinAgo) as { cnt: number }
  ).cnt;

  const signalsLast5m = (
    sqlite
      .prepare("SELECT COUNT(*) as cnt FROM decision_log WHERE decision = 'SUBMIT' AND ts > ?")
      .get(fiveMinAgo) as { cnt: number }
  ).cnt;

  const systemHealth: SystemHealth = {
    feedFreshnessSec,
    activeTokens,
    signalsLast5m,
    isHealthy: feedFreshnessSec < 60 && activeTokens > 0
  };

  let isMakerWallet = false;
  if (walletId != null && Number.isFinite(walletId)) {
    const walletRow = sqlite
      .prepare("SELECT maker_enabled as makerEnabled FROM wallets WHERE id = ?")
      .get(walletId) as { makerEnabled: number } | undefined;
    isMakerWallet = (walletRow?.makerEnabled ?? 0) === 1;
  }

  let makerStats: MakerStats | null = null;
  let makerFills: MakerFill[] = [];
  let makerRiskPositions: MakerRiskPosition[] = [];

  if (isMakerWallet && walletId != null) {
    const perf = getPerformanceMetrics(sqlite, walletId);
    const maker = perf.maker;
    const totalExposure = maker.longExposure + maker.shortExposure;
    const inventorySkew = totalExposure > 0 ? (maker.longExposure - maker.shortExposure) / totalExposure : 0;

    const fillsLast1h = (
      sqlite.prepare(
        `SELECT COUNT(*) as cnt
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= ?
           AND f.method != 'synthetic_fill'
           AND o.kind IN ('MAKER_BID','MAKER_ASK')
           AND o.wallet_id = ?`
      ).get(now - 60 * 60 * 1000, walletId) as { cnt: number }
    ).cnt;

    makerStats = {
      openPositions: maker.openPositions,
      totalRealized: maker.totalRealized,
      totalUnrealized: maker.totalUnrealized,
      netPnl: maker.netPnl,
      avgSpreadCapture: maker.avgSpreadCapture,
      avgFillRate: maker.avgFillRate,
      fillsLast1h,
      longExposure: maker.longExposure,
      shortExposure: maker.shortExposure,
      inventorySkew
    };

    makerFills = sqlite.prepare(
      `SELECT
         o.token_id as tokenId,
         m.question as question,
         t.outcome as outcome,
         o.side as side,
         f.price as price,
         f.size as size,
         f.ts as ts
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       LEFT JOIN tokens t ON t.id = o.token_id
       LEFT JOIN markets m ON m.id = t.market_id
       WHERE o.wallet_id = ?
         AND o.kind IN ('MAKER_BID','MAKER_ASK')
         AND f.method != 'synthetic_fill'
       ORDER BY f.ts DESC
       LIMIT 50`
    ).all(walletId) as MakerFill[];
  }

  const response: IntelligenceResponse = {
    makerStats,
    makerFills,
    makerRiskPositions: makerRiskPositions.slice(0, 10),
    systemHealth,
    isMakerWallet
  };

  return Response.json(response);
}
