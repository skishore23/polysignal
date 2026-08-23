/**
 * Monitor Maker Inventory
 * 
 * Reports tokens with large inventory positions that may need attention.
 * Helps identify:
 * - Tokens exceeding inventory limits (quoting paused)
 * - Tokens with large exposure that may need limit adjustments
 * - Per-token risk concentration
 * 
 * Usage: npx tsx scripts/archive/manual-diagnostics/monitor-maker-inventory.ts [--threshold=500] [--wallet=37]
 */

import { openDatabase } from "../../../packages/storage/src/index.js";

const args = process.argv.slice(2);
const thresholdArg = args.find(a => a.startsWith("--threshold="));
const walletArg = args.find(a => a.startsWith("--wallet="));

const threshold = thresholdArg ? parseInt(thresholdArg.split("=")[1]) : 500;
const walletFilter = walletArg ? parseInt(walletArg.split("=")[1]) : null;

const { sqlite } = openDatabase("data/dev.db");

type TokenInventory = {
  walletId: number;
  walletName: string;
  tokenId: string;
  tokenName: string | null;
  marketQuestion: string | null;
  position: number;
  avgEntry: number;
  realized: number;
  unrealized: number;
  inventoryLimit: number;
  saturationPct: number;
  isSaturated: boolean;
};

type WalletSummary = {
  walletId: number;
  walletName: string;
  inventoryLimit: number;
  totalTokens: number;
  saturatedTokens: number;
  largePositionTokens: number;
  totalLongExposure: number;
  totalShortExposure: number;
  netExposure: number;
};

const getTokenInventories = (): TokenInventory[] => {
  const walletClause = walletFilter ? `AND w.id = ${walletFilter}` : "";
  
  const stmt = sqlite.prepare(`
    SELECT 
      w.id as walletId,
      w.name as walletName,
      w.maker_inventory_max_abs as inventoryLimit,
      p.token_id as tokenId,
      t.name as tokenName,
      m.question as marketQuestion,
      p.position,
      p.avg_entry as avgEntry,
      p.realized,
      p.unrealized
    FROM wallets w
    JOIN maker_pnl_latest p ON w.id = p.wallet_id
    LEFT JOIN tokens t ON p.token_id = t.id
    LEFT JOIN markets m ON t.market_id = m.id
    WHERE w.maker_enabled = 1
      ${walletClause}
      AND ABS(p.position) >= ${threshold}
    ORDER BY ABS(p.position) DESC
  `);

  const rows = stmt.all() as Array<{
    walletId: number;
    walletName: string;
    inventoryLimit: number;
    tokenId: string;
    tokenName: string | null;
    marketQuestion: string | null;
    position: number;
    avgEntry: number;
    realized: number;
    unrealized: number;
  }>;

  return rows.map(row => ({
    ...row,
    saturationPct: (Math.abs(row.position) / row.inventoryLimit) * 100,
    isSaturated: Math.abs(row.position) >= row.inventoryLimit
  }));
};

const getWalletSummaries = (): WalletSummary[] => {
  const walletClause = walletFilter ? `AND w.id = ${walletFilter}` : "";
  
  const stmt = sqlite.prepare(`
    SELECT 
      w.id as walletId,
      w.name as walletName,
      w.maker_inventory_max_abs as inventoryLimit,
      COUNT(DISTINCT p.token_id) as totalTokens,
      SUM(CASE WHEN ABS(p.position) >= w.maker_inventory_max_abs THEN 1 ELSE 0 END) as saturatedTokens,
      SUM(CASE WHEN ABS(p.position) >= ${threshold} THEN 1 ELSE 0 END) as largePositionTokens,
      SUM(CASE WHEN p.position > 0 THEN p.position ELSE 0 END) as totalLongExposure,
      SUM(CASE WHEN p.position < 0 THEN ABS(p.position) ELSE 0 END) as totalShortExposure,
      SUM(p.position) as netExposure
    FROM wallets w
    JOIN maker_pnl_latest p ON w.id = p.wallet_id
    WHERE w.maker_enabled = 1
      ${walletClause}
    GROUP BY w.id
    ORDER BY saturatedTokens DESC
  `);

  return stmt.all() as WalletSummary[];
};

const getSaturatedTokens = (): TokenInventory[] => {
  const walletClause = walletFilter ? `AND w.id = ${walletFilter}` : "";
  
  const stmt = sqlite.prepare(`
    SELECT 
      w.id as walletId,
      w.name as walletName,
      w.maker_inventory_max_abs as inventoryLimit,
      p.token_id as tokenId,
      t.name as tokenName,
      m.question as marketQuestion,
      p.position,
      p.avg_entry as avgEntry,
      p.realized,
      p.unrealized
    FROM wallets w
    JOIN maker_pnl_latest p ON w.id = p.wallet_id
    LEFT JOIN tokens t ON p.token_id = t.id
    LEFT JOIN markets m ON t.market_id = m.id
    WHERE w.maker_enabled = 1
      ${walletClause}
      AND ABS(p.position) >= w.maker_inventory_max_abs
    ORDER BY ABS(p.position) DESC
  `);

  const rows = stmt.all() as Array<{
    walletId: number;
    walletName: string;
    inventoryLimit: number;
    tokenId: string;
    tokenName: string | null;
    marketQuestion: string | null;
    position: number;
    avgEntry: number;
    realized: number;
    unrealized: number;
  }>;

  return rows.map(row => ({
    ...row,
    saturationPct: (Math.abs(row.position) / row.inventoryLimit) * 100,
    isSaturated: true
  }));
};

const truncate = (str: string | null, len: number): string => {
  if (!str) return "Unknown".padEnd(len);
  return str.length > len ? str.slice(0, len - 3) + "..." : str.padEnd(len);
};

const main = (): void => {
  console.log("=" .repeat(100));
  console.log("MAKER INVENTORY MONITOR");
  console.log("=" .repeat(100));
  console.log(`Threshold: positions >= ${threshold}`);
  if (walletFilter) {
    console.log(`Wallet Filter: ${walletFilter}`);
  }
  console.log("");

  // Wallet summaries
  const summaries = getWalletSummaries();
  
  console.log("WALLET SUMMARY");
  console.log("-".repeat(100));
  console.log(
    "Wallet".padEnd(20),
    "Limit".padStart(8),
    "Tokens".padStart(8),
    "Saturated".padStart(10),
    "Large".padStart(8),
    "Long".padStart(12),
    "Short".padStart(12),
    "Net".padStart(12)
  );
  console.log("-".repeat(100));

  for (const s of summaries) {
    const saturatedStr = s.saturatedTokens > 0 ? `⚠️ ${s.saturatedTokens}` : `✅ ${s.saturatedTokens}`;
    console.log(
      s.walletName.padEnd(20),
      s.inventoryLimit.toString().padStart(8),
      s.totalTokens.toString().padStart(8),
      saturatedStr.padStart(10),
      s.largePositionTokens.toString().padStart(8),
      s.totalLongExposure.toFixed(0).padStart(12),
      s.totalShortExposure.toFixed(0).padStart(12),
      (s.netExposure >= 0 ? "+" : "") + s.netExposure.toFixed(0).padStart(11)
    );
  }

  console.log("");

  // Saturated tokens (quoting paused)
  const saturated = getSaturatedTokens();
  
  if (saturated.length > 0) {
    console.log("⚠️  SATURATED TOKENS (QUOTING PAUSED)");
    console.log("-".repeat(100));
    console.log(
      "Wallet".padEnd(18),
      "Token".padEnd(8),
      "Position".padStart(10),
      "Limit".padStart(8),
      "Sat%".padStart(8),
      "Realized".padStart(10),
      "Market".padEnd(35)
    );
    console.log("-".repeat(100));

    for (const t of saturated) {
      const shortId = t.tokenId.slice(0, 6) + "...";
      console.log(
        t.walletName.padEnd(18),
        shortId.padEnd(8),
        t.position.toFixed(0).padStart(10),
        t.inventoryLimit.toString().padStart(8),
        `${t.saturationPct.toFixed(0)}%`.padStart(8),
        `$${t.realized.toFixed(2)}`.padStart(10),
        truncate(t.marketQuestion, 35)
      );
    }
    console.log("");
  }

  // Large positions (not yet saturated but worth watching)
  const large = getTokenInventories().filter(t => !t.isSaturated);
  
  if (large.length > 0) {
    console.log(`📊 LARGE POSITIONS (>= ${threshold}, not saturated)`);
    console.log("-".repeat(100));
    console.log(
      "Wallet".padEnd(18),
      "Token".padEnd(8),
      "Position".padStart(10),
      "Limit".padStart(8),
      "Sat%".padStart(8),
      "Realized".padStart(10),
      "Market".padEnd(35)
    );
    console.log("-".repeat(100));

    for (const t of large.slice(0, 30)) { // Top 30
      const shortId = t.tokenId.slice(0, 6) + "...";
      const satWarn = t.saturationPct >= 80 ? "⚠️" : "  ";
      console.log(
        t.walletName.padEnd(18),
        shortId.padEnd(8),
        t.position.toFixed(0).padStart(10),
        t.inventoryLimit.toString().padStart(8),
        `${satWarn}${t.saturationPct.toFixed(0)}%`.padStart(8),
        `$${t.realized.toFixed(2)}`.padStart(10),
        truncate(t.marketQuestion, 35)
      );
    }

    if (large.length > 30) {
      console.log(`... and ${large.length - 30} more tokens`);
    }
  }

  console.log("");

  // Summary stats
  const totalSaturated = saturated.length;
  const totalLarge = large.length;
  
  console.log("SUMMARY");
  console.log("-".repeat(100));
  console.log(`🔴 Saturated tokens (quoting paused): ${totalSaturated}`);
  console.log(`🟡 Large positions (watching): ${totalLarge}`);
  console.log("");
  
  if (totalSaturated > 0) {
    console.log("RECOMMENDED ACTIONS:");
    console.log(
      "1. Run: npx tsx scripts/archive/manual-diagnostics/tune-maker-inventory-limits.ts"
    );
    console.log("   to raise limits based on actual position sizes");
    console.log("");
    console.log("2. Or manually increase maker_inventory_max_abs for affected wallets");
    console.log("");
    console.log("3. Consider adding token-specific overrides for high-volume tokens");
  }

  console.log("=" .repeat(100));
};

main();
