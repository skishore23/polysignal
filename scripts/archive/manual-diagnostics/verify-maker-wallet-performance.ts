#!/usr/bin/env tsx

/**
 * Verify Maker Wallet Performance
 * 
 * Analyzes performance metrics for maker-enabled wallets including:
 * - PnL (realized, unrealized, total, ROI)
 * - Trading activity (quotes, fills, metrics)
 * - Spread capture and fill rates
 * - Inventory management
 */

import { getDb } from "../../../apps/web/lib/db.js";

const formatCurrency = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);

const formatPercent = (value: number): string =>
  `${(value * 100).toFixed(2)}%`;

const formatTime = (ts: number): string =>
  new Date(ts).toLocaleString();

const formatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
};

type WalletPnL = {
  walletId: number;
  walletName: string;
  startingBalance: number;
  realized: number;
  unrealized: number;
  total: number;
  roi: number;
  tokenCount: number;
};

type WalletActivity = {
  walletId: number;
  quotes: number;
  fills: number;
  metrics: number;
  firstActivity: number | null;
  lastActivity: number | null;
};

type WalletMetrics = {
  walletId: number;
  avgSpreadCapture: number;
  avgInventorySkew: number;
  avgQMin: number;
  avgFillRate: number;
  tokenCount: number;
};

const getWalletPnL = (sqlite: any, walletId: number | null = null): WalletPnL[] => {
  if (walletId) {
    const rows = sqlite
      .prepare(
        `SELECT
          w.id as walletId,
          w.name as walletName,
          w.starting_balance as startingBalance,
          COALESCE(SUM(p.realized), 0) as realized,
          COALESCE(SUM(p.unrealized), 0) as unrealized,
          COALESCE(SUM(p.realized + p.unrealized), 0) as total,
          CASE WHEN w.starting_balance > 0
            THEN COALESCE(SUM(p.realized + p.unrealized), 0) / w.starting_balance
            ELSE 0
          END as roi,
          COUNT(DISTINCT p.token_id) as tokenCount
        FROM wallets w
        LEFT JOIN (
          SELECT wallet_id, token_id, MAX(ts) as ts
          FROM maker_pnl
          WHERE wallet_id = ?
          GROUP BY wallet_id, token_id
        ) latest ON latest.wallet_id = w.id
        LEFT JOIN maker_pnl p ON p.wallet_id = latest.wallet_id AND p.token_id = latest.token_id AND p.ts = latest.ts
        WHERE w.maker_enabled = 1 AND w.id = ?
        GROUP BY w.id
        ORDER BY roi DESC`
      )
      .all(walletId, walletId) as WalletPnL[];
    return rows;
  }

  const rows = sqlite
    .prepare(
      `SELECT
        w.id as walletId,
        w.name as walletName,
        w.starting_balance as startingBalance,
        COALESCE(SUM(p.realized), 0) as realized,
        COALESCE(SUM(p.unrealized), 0) as unrealized,
        COALESCE(SUM(p.realized + p.unrealized), 0) as total,
        CASE WHEN w.starting_balance > 0
          THEN COALESCE(SUM(p.realized + p.unrealized), 0) / w.starting_balance
          ELSE 0
        END as roi,
        COUNT(DISTINCT p.token_id) as tokenCount
      FROM wallets w
      LEFT JOIN (
        SELECT wallet_id, token_id, MAX(ts) as ts
        FROM maker_pnl
        GROUP BY wallet_id, token_id
      ) latest ON latest.wallet_id = w.id
      LEFT JOIN maker_pnl p ON p.wallet_id = latest.wallet_id AND p.token_id = latest.token_id AND p.ts = latest.ts
      WHERE w.maker_enabled = 1
      GROUP BY w.id
      ORDER BY roi DESC`
    )
    .all() as WalletPnL[];

  return rows;
};

const getWalletActivity = (sqlite: any, walletId: number | null = null): WalletActivity[] => {
  if (walletId) {
    const rows = sqlite
      .prepare(
        `SELECT
          w.id as walletId,
          COALESCE(q.quotes, 0) as quotes,
          COALESCE(f.fills, 0) as fills,
          COALESCE(m.metrics, 0) as metrics,
          MIN(COALESCE(q.firstTs, f.firstTs, m.firstTs, NULL)) as firstActivity,
          MAX(COALESCE(q.lastTs, f.lastTs, m.lastTs, NULL)) as lastActivity
        FROM wallets w
        LEFT JOIN (
          SELECT 
            wallet_id,
            COUNT(*) as quotes,
            MIN(ts) as firstTs,
            MAX(ts) as lastTs
          FROM maker_quotes
          WHERE wallet_id = ?
          GROUP BY wallet_id
        ) q ON q.wallet_id = w.id
        LEFT JOIN (
          SELECT 
            wallet_id,
            COUNT(*) as fills,
            MIN(ts) as firstTs,
            MAX(ts) as lastTs
          FROM maker_fills
          WHERE wallet_id = ?
          GROUP BY wallet_id
        ) f ON f.wallet_id = w.id
        LEFT JOIN (
          SELECT 
            wallet_id,
            COUNT(*) as metrics,
            MIN(ts) as firstTs,
            MAX(ts) as lastTs
          FROM maker_metrics
          WHERE wallet_id = ?
          GROUP BY wallet_id
        ) m ON m.wallet_id = w.id
        WHERE w.maker_enabled = 1 AND w.id = ?
        GROUP BY w.id
        ORDER BY w.id`
      )
      .all(walletId, walletId, walletId, walletId) as WalletActivity[];
    return rows;
  }

  const rows = sqlite
    .prepare(
      `SELECT
        w.id as walletId,
        COALESCE(q.quotes, 0) as quotes,
        COALESCE(f.fills, 0) as fills,
        COALESCE(m.metrics, 0) as metrics,
        MIN(COALESCE(q.firstTs, f.firstTs, m.firstTs, NULL)) as firstActivity,
        MAX(COALESCE(q.lastTs, f.lastTs, m.lastTs, NULL)) as lastActivity
      FROM wallets w
      LEFT JOIN (
        SELECT 
          wallet_id,
          COUNT(*) as quotes,
          MIN(ts) as firstTs,
          MAX(ts) as lastTs
        FROM maker_quotes
        GROUP BY wallet_id
      ) q ON q.wallet_id = w.id
      LEFT JOIN (
        SELECT 
          wallet_id,
          COUNT(*) as fills,
          MIN(ts) as firstTs,
          MAX(ts) as lastTs
        FROM maker_fills
        GROUP BY wallet_id
      ) f ON f.wallet_id = w.id
      LEFT JOIN (
        SELECT 
          wallet_id,
          COUNT(*) as metrics,
          MIN(ts) as firstTs,
          MAX(ts) as lastTs
        FROM maker_metrics
        GROUP BY wallet_id
      ) m ON m.wallet_id = w.id
      WHERE w.maker_enabled = 1
      GROUP BY w.id
      ORDER BY w.id`
    )
    .all() as WalletActivity[];

  return rows;
};

const getWalletMetrics = (sqlite: any, walletId: number | null = null): WalletMetrics[] => {
  if (walletId) {
    const rows = sqlite
      .prepare(
        `SELECT
          mm.wallet_id as walletId,
          AVG(mm.spread_capture) as avgSpreadCapture,
          AVG(mm.inventory_skew) as avgInventorySkew,
          AVG(mm.q_min) as avgQMin,
          AVG(mm.fill_rate) as avgFillRate,
          COUNT(DISTINCT mm.token_id) as tokenCount
        FROM maker_metrics mm
        INNER JOIN wallets w ON w.id = mm.wallet_id AND w.maker_enabled = 1
        WHERE mm.wallet_id = ?
        GROUP BY mm.wallet_id
        ORDER BY mm.wallet_id`
      )
      .all(walletId) as WalletMetrics[];
    return rows;
  }

  const rows = sqlite
    .prepare(
      `SELECT
        mm.wallet_id as walletId,
        AVG(mm.spread_capture) as avgSpreadCapture,
        AVG(mm.inventory_skew) as avgInventorySkew,
        AVG(mm.q_min) as avgQMin,
        AVG(mm.fill_rate) as avgFillRate,
        COUNT(DISTINCT mm.token_id) as tokenCount
      FROM maker_metrics mm
      INNER JOIN wallets w ON w.id = mm.wallet_id AND w.maker_enabled = 1
      GROUP BY mm.wallet_id
      ORDER BY mm.wallet_id`
    )
    .all() as WalletMetrics[];

  return rows;
};

const getTopPnLByToken = (sqlite: any, limit: number = 10, walletId: number | null = null) => {
  if (walletId) {
    const rows = sqlite
      .prepare(
        `SELECT
          mp.wallet_id as walletId,
          w.name as walletName,
          mp.token_id as tokenId,
          t.market_id as marketId,
          m.slug as slug,
          m.question as question,
          t.outcome as outcome,
          mp.realized + mp.unrealized as totalPnL,
          mp.realized,
          mp.unrealized,
          mp.position,
          mp.avg_entry as avgEntry,
          mp.ts
        FROM (
          SELECT token_id, wallet_id, MAX(id) as maxId
          FROM maker_pnl
          WHERE wallet_id = ?
          GROUP BY token_id, wallet_id
        ) latest
        INNER JOIN maker_pnl mp ON mp.id = latest.maxId
        INNER JOIN wallets w ON w.id = mp.wallet_id AND w.maker_enabled = 1
        INNER JOIN tokens t ON t.id = mp.token_id
        INNER JOIN markets m ON m.id = t.market_id
        ORDER BY mp.realized + mp.unrealized DESC
        LIMIT ?`
      )
      .all(walletId, limit) as Array<{
    walletId: number;
    walletName: string;
    tokenId: string;
    marketId: string | null;
    slug: string | null;
    question: string | null;
    outcome: string | null;
    totalPnL: number;
    realized: number;
    unrealized: number;
    position: number;
    avgEntry: number;
    ts: number;
  }>;
    return rows;
  }

  const rows = sqlite
    .prepare(
      `SELECT
        mp.wallet_id as walletId,
        w.name as walletName,
        mp.token_id as tokenId,
        t.market_id as marketId,
        m.slug as slug,
        m.question as question,
        t.outcome as outcome,
        mp.realized + mp.unrealized as totalPnL,
        mp.realized,
        mp.unrealized,
        mp.position,
        mp.avg_entry as avgEntry,
        mp.ts
      FROM (
        SELECT token_id, wallet_id, MAX(id) as maxId
        FROM maker_pnl
        GROUP BY token_id, wallet_id
      ) latest
      INNER JOIN maker_pnl mp ON mp.id = latest.maxId
      INNER JOIN wallets w ON w.id = mp.wallet_id AND w.maker_enabled = 1
      INNER JOIN tokens t ON t.id = mp.token_id
      INNER JOIN markets m ON m.id = t.market_id
      ORDER BY mp.realized + mp.unrealized DESC
      LIMIT ?`
    )
    .all(limit) as Array<{
    walletId: number;
    walletName: string;
    tokenId: string;
    marketId: string | null;
    slug: string | null;
    question: string | null;
    outcome: string | null;
    totalPnL: number;
    realized: number;
    unrealized: number;
    position: number;
    avgEntry: number;
    ts: number;
  }>;

  return rows;
};

const getRecentFills = (sqlite: any, limit: number = 10, walletId: number | null = null) => {
  if (walletId) {
    const rows = sqlite
      .prepare(
        `SELECT
          mf.wallet_id as walletId,
          w.name as walletName,
          mf.token_id as tokenId,
          m.slug as slug,
          m.question as question,
          t.outcome as outcome,
          mf.side as side,
          mf.price as price,
          mf.size as size,
          mf.ts
        FROM maker_fills mf
        JOIN wallets w ON w.id = mf.wallet_id
        JOIN tokens t ON t.id = mf.token_id
        JOIN markets m ON m.id = t.market_id
        WHERE w.maker_enabled = 1 AND mf.wallet_id = ?
        ORDER BY mf.ts DESC
        LIMIT ?`
      )
      .all(walletId, limit) as Array<{
    walletId: number;
    walletName: string;
    tokenId: string;
    slug: string | null;
    question: string | null;
    outcome: string | null;
    side: string;
    price: number;
    size: number;
    ts: number;
  }>;
    return rows;
  }

  const rows = sqlite
    .prepare(
      `SELECT
        mf.wallet_id as walletId,
        w.name as walletName,
        mf.token_id as tokenId,
        m.slug as slug,
        m.question as question,
        t.outcome as outcome,
        mf.side as side,
        mf.price as price,
        mf.size as size,
        mf.ts
      FROM maker_fills mf
      JOIN wallets w ON w.id = mf.wallet_id
      JOIN tokens t ON t.id = mf.token_id
      JOIN markets m ON m.id = t.market_id
      WHERE w.maker_enabled = 1
      ORDER BY mf.ts DESC
      LIMIT ?`
    )
    .all(limit) as Array<{
    walletId: number;
    walletName: string;
    tokenId: string;
    slug: string | null;
    question: string | null;
    outcome: string | null;
    side: string;
    price: number;
    size: number;
    ts: number;
  }>;

  return rows;
};

const displayWalletSummary = (pnl: WalletPnL[], activity: WalletActivity[], metrics: WalletMetrics[], walletId: number | null): void => {
  const title = walletId ? `MAKER WALLET PERFORMANCE - WALLET ${walletId}` : "MAKER WALLET PERFORMANCE SUMMARY";
  console.log("\n" + "=".repeat(80));
  console.log(title);
  console.log("=".repeat(80));
  console.log(`Generated at: ${new Date().toISOString()}`);
  console.log("=".repeat(80) + "\n");

  if (pnl.length === 0) {
    console.log(walletId ? `No maker-enabled wallet found with ID ${walletId}.` : "No maker-enabled wallets found.");
    return;
  }

  const metricsMap = new Map(metrics.map(m => [m.walletId, m]));
  const activityMap = new Map(activity.map(a => [a.walletId, a]));

  console.log("💰 WALLET PnL OVERVIEW");
  console.log("-".repeat(80));
  console.log(
    `${"Wallet".padEnd(30)} ${"Realized".padStart(12)} ${"Unrealized".padStart(12)} ${"Total".padStart(12)} ${"ROI".padStart(10)} ${"Tokens".padStart(8)}`
  );
  console.log("-".repeat(80));

  for (const wallet of pnl) {
    const name = wallet.walletName.length > 28 ? wallet.walletName.substring(0, 28) + ".." : wallet.walletName;
    console.log(
      `${name.padEnd(30)} ${formatCurrency(wallet.realized).padStart(12)} ${formatCurrency(wallet.unrealized).padStart(12)} ${formatCurrency(wallet.total).padStart(12)} ${formatPercent(wallet.roi).padStart(10)} ${wallet.tokenCount.toString().padStart(8)}`
    );
  }

  console.log("");

  const totalRealized = pnl.reduce((sum, w) => sum + w.realized, 0);
  const totalUnrealized = pnl.reduce((sum, w) => sum + w.unrealized, 0);
  const totalPnL = totalRealized + totalUnrealized;
  const totalStarting = pnl.reduce((sum, w) => sum + w.startingBalance, 0);
  const overallROI = totalStarting > 0 ? totalPnL / totalStarting : 0;

  console.log("📊 AGGREGATE STATISTICS");
  console.log("-".repeat(80));
  console.log(`Total Wallets: ${pnl.length}`);
  console.log(`Total Starting Balance: ${formatCurrency(totalStarting)}`);
  console.log(`Total Realized PnL: ${formatCurrency(totalRealized)}`);
  console.log(`Total Unrealized PnL: ${formatCurrency(totalUnrealized)}`);
  console.log(`Total PnL: ${formatCurrency(totalPnL)} ${totalPnL > 0 ? "✅" : totalPnL === 0 ? "➖" : "❌"}`);
  console.log(`Overall ROI: ${formatPercent(overallROI)}`);
  console.log("");

  console.log("📈 ACTIVITY METRICS");
  console.log("-".repeat(80));
  console.log(
    `${"Wallet".padEnd(30)} ${"Quotes".padStart(10)} ${"Fills".padStart(10)} ${"Metrics".padStart(10)} ${"Duration".padStart(12)}`
  );
  console.log("-".repeat(80));

  for (const wallet of pnl) {
    const act = activityMap.get(wallet.walletId);
    if (!act) continue;

    const name = wallet.walletName.length > 28 ? wallet.walletName.substring(0, 28) + ".." : wallet.walletName;
    const duration = act.firstActivity && act.lastActivity
      ? formatDuration(act.lastActivity - act.firstActivity)
      : "N/A";

    console.log(
      `${name.padEnd(30)} ${act.quotes.toString().padStart(10)} ${act.fills.toString().padStart(10)} ${act.metrics.toString().padStart(10)} ${duration.padStart(12)}`
    );
  }

  console.log("");

  console.log("🎯 TRADING METRICS");
  console.log("-".repeat(80));
  console.log(
    `${"Wallet".padEnd(30)} ${"Avg Spread".padStart(12)} ${"Avg Skew".padStart(12)} ${"Avg QMin".padStart(12)} ${"Avg Fill".padStart(12)} ${"Tokens".padStart(8)}`
  );
  console.log("-".repeat(80));

  for (const wallet of pnl) {
    const met = metricsMap.get(wallet.walletId);
    if (!met) continue;

    const name = wallet.walletName.length > 28 ? wallet.walletName.substring(0, 28) + ".." : wallet.walletName;
    console.log(
      `${name.padEnd(30)} ${formatPercent(met.avgSpreadCapture).padStart(12)} ${formatPercent(met.avgInventorySkew).padStart(12)} ${met.avgQMin.toFixed(4).padStart(12)} ${formatPercent(met.avgFillRate).padStart(12)} ${met.tokenCount.toString().padStart(8)}`
    );
  }

  console.log("");
};

const displayTopPnL = (sqlite: any, limit: number = 10): void => {
  const topPnL = getTopPnLByToken(sqlite, limit);

  if (topPnL.length === 0) {
    return;
  }

  console.log("🏆 TOP PnL BY TOKEN");
  console.log("-".repeat(80));
  console.log(
    `${"Wallet".padEnd(25)} ${"Market".padEnd(35)} ${"Total PnL".padStart(12)} ${"Position".padStart(10)}`
  );
  console.log("-".repeat(80));

  for (const row of topPnL) {
    const walletName = row.walletName.length > 23 ? row.walletName.substring(0, 23) + ".." : row.walletName;
    let marketName = row.question ?? row.slug ?? row.tokenId.substring(0, 20);
    if (marketName.length > 35) {
      marketName = marketName.substring(0, 33) + "..";
    }
    marketName = marketName.padEnd(35);

    console.log(
      `${walletName.padEnd(25)} ${marketName} ${formatCurrency(row.totalPnL).padStart(12)} ${row.position.toFixed(2).padStart(10)}`
    );
  }

  console.log("");
};

const displayRecentFills = (sqlite: any, limit: number = 10): void => {
  const fills = getRecentFills(sqlite, limit);

  if (fills.length === 0) {
    return;
  }

  console.log("🔄 RECENT FILLS");
  console.log("-".repeat(80));
  console.log(
    `${"Time".padEnd(20)} ${"Wallet".padEnd(20)} ${"Side".padStart(6)} ${"Price".padStart(10)} ${"Size".padStart(10)} ${"Market".padEnd(30)}`
  );
  console.log("-".repeat(80));

  for (const fill of fills) {
    const time = formatTime(fill.ts);
    const walletName = fill.walletName.length > 18 ? fill.walletName.substring(0, 18) + ".." : fill.walletName;
    let marketName = fill.question ?? fill.slug ?? fill.tokenId.substring(0, 20);
    if (marketName.length > 30) {
      marketName = marketName.substring(0, 28) + "..";
    }
    marketName = marketName.padEnd(30);

    console.log(
      `${time.padEnd(20)} ${walletName.padEnd(20)} ${fill.side.padStart(6)} ${fill.price.toFixed(4).padStart(10)} ${fill.size.toFixed(2).padStart(10)} ${marketName}`
    );
  }

  console.log("");
};

const main = (): void => {
  const walletIdArg = process.argv[2];
  const walletId = walletIdArg ? parseInt(walletIdArg, 10) : null;

  if (walletIdArg && (!Number.isFinite(walletId) || walletId < 1)) {
    console.error("❌ Invalid wallet ID. Usage: tsx scripts/archive/manual-diagnostics/verify-maker-wallet-performance.ts [walletId]");
    process.exit(1);
  }

  const { sqlite } = getDb();

  const pnl = getWalletPnL(sqlite, walletId);
  const activity = getWalletActivity(sqlite, walletId);
  const metrics = getWalletMetrics(sqlite, walletId);

  displayWalletSummary(pnl, activity, metrics, walletId);
  displayTopPnL(sqlite, 10, walletId);
  displayRecentFills(sqlite, 10, walletId);

  console.log("=".repeat(80));
  if (walletId) {
    console.log(`💡 Showing details for wallet ${walletId} only`);
    console.log(`💡 To see all wallets, run without wallet ID argument`);
  } else {
    console.log(`💡 To see a specific wallet, run: tsx scripts/archive/manual-diagnostics/verify-maker-wallet-performance.ts <walletId>`);
  }
  console.log("=".repeat(80));
};

main();
