/**
 * Tune Maker Inventory Limits
 * 
 * Analyzes current inventory positions and updates wallet limits to match reality.
 * Positions exceeding inventoryMaxAbs means skewing can't pull exposure back,
 * so we raise limits to keep the skew signal meaningful.
 * 
 * Usage: npx tsx scripts/archive/manual-diagnostics/tune-maker-inventory-limits.ts [--dry-run] [--multiplier=1.5]
 */

import { openDatabase } from "../../../packages/storage/src/index.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const multiplierArg = args.find(a => a.startsWith("--multiplier="));
const multiplier = multiplierArg ? parseFloat(multiplierArg.split("=")[1]) : 1.5;

const { sqlite } = openDatabase("data/dev.db");

const makerPnlLatestExists = (): boolean => {
  const row = sqlite
    .prepare(
      "SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = 'maker_pnl_latest' LIMIT 1"
    )
    .get() as { ok: number } | undefined;
  return Boolean(row?.ok);
};

type WalletInventoryStats = {
  walletId: number;
  walletName: string;
  currentLimit: number;
  maxAbsPosition: number;
  avgAbsPosition: number;
  tokenCount: number;
  saturationPct: number;
};

type WalletUpdate = {
  walletId: number;
  walletName: string;
  currentLimit: number;
  newLimit: number;
  reason: string;
};

const getInventoryStats = (): WalletInventoryStats[] => {
  const stmt = sqlite.prepare(`
    SELECT 
      w.id as walletId,
      w.name as walletName,
      w.maker_inventory_max_abs as currentLimit,
      MAX(ABS(p.position)) as maxAbsPosition,
      AVG(ABS(p.position)) as avgAbsPosition,
      COUNT(DISTINCT p.token_id) as tokenCount
    FROM wallets w
    JOIN maker_pnl_latest p ON w.id = p.wallet_id
    WHERE w.maker_enabled = 1
    GROUP BY w.id
    ORDER BY w.id
  `);

  const rows = stmt.all() as Array<{
    walletId: number;
    walletName: string;
    currentLimit: number;
    maxAbsPosition: number;
    avgAbsPosition: number;
    tokenCount: number;
  }>;

  return rows.map(row => ({
    ...row,
    saturationPct: (row.maxAbsPosition / row.currentLimit) * 100
  }));
};

const computeNewLimits = (stats: WalletInventoryStats[]): WalletUpdate[] => {
  const updates: WalletUpdate[] = [];

  for (const stat of stats) {
    // If max position exceeds limit, raise the limit
    if (stat.maxAbsPosition > stat.currentLimit) {
      // New limit = max position * multiplier (default 1.5x headroom)
      const newLimit = Math.ceil(stat.maxAbsPosition * multiplier / 100) * 100; // Round to nearest 100
      updates.push({
        walletId: stat.walletId,
        walletName: stat.walletName,
        currentLimit: stat.currentLimit,
        newLimit,
        reason: `Max position ${stat.maxAbsPosition.toFixed(0)} exceeds limit ${stat.currentLimit}`
      });
    }
  }

  return updates;
};

const applyUpdates = (updates: WalletUpdate[]): void => {
  const updateStmt = sqlite.prepare(`
    UPDATE wallets 
    SET maker_inventory_max_abs = ?
    WHERE id = ?
  `);

  for (const update of updates) {
    updateStmt.run(update.newLimit, update.walletId);
  }
};

const main = (): void => {
  console.log("=" .repeat(80));
  console.log("MAKER INVENTORY LIMITS TUNING");
  console.log("=" .repeat(80));
  console.log(`Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE"}`);
  console.log(`Multiplier: ${multiplier}x headroom`);
  console.log("");

  if (!makerPnlLatestExists()) {
    console.log("⚠️  Skipping: table `maker_pnl_latest` not found in data/dev.db.");
    console.log("   Run maker loop first to populate maker tables, then rerun this script.");
    console.log("");
    console.log("=".repeat(80));
    return;
  }

  // Get current stats
  const stats = getInventoryStats();

  console.log("CURRENT INVENTORY STATUS");
  console.log("-".repeat(80));
  console.log(
    "Wallet".padEnd(20),
    "Limit".padStart(10),
    "Max Pos".padStart(10),
    "Avg Pos".padStart(10),
    "Tokens".padStart(8),
    "Saturation".padStart(12)
  );
  console.log("-".repeat(80));

  for (const stat of stats) {
    const saturationStr = stat.saturationPct > 100 
      ? `⚠️ ${stat.saturationPct.toFixed(0)}%`
      : `✅ ${stat.saturationPct.toFixed(0)}%`;

    console.log(
      stat.walletName.padEnd(20),
      stat.currentLimit.toString().padStart(10),
      stat.maxAbsPosition.toFixed(0).padStart(10),
      stat.avgAbsPosition.toFixed(0).padStart(10),
      stat.tokenCount.toString().padStart(8),
      saturationStr.padStart(12)
    );
  }

  console.log("");

  // Compute updates
  const updates = computeNewLimits(stats);

  if (updates.length === 0) {
    console.log("✅ All wallets are within their inventory limits. No changes needed.");
    return;
  }

  console.log("PROPOSED LIMIT UPDATES");
  console.log("-".repeat(80));
  console.log(
    "Wallet".padEnd(20),
    "Current".padStart(10),
    "→".padStart(3),
    "New".padStart(10),
    "Reason".padStart(35)
  );
  console.log("-".repeat(80));

  for (const update of updates) {
    console.log(
      update.walletName.padEnd(20),
      update.currentLimit.toString().padStart(10),
      "→".padStart(3),
      update.newLimit.toString().padStart(10),
      update.reason.padStart(35)
    );
  }

  console.log("");

  if (dryRun) {
    console.log("🔍 DRY RUN - No changes applied.");
    console.log("   Run without --dry-run to apply these changes.");
  } else {
    applyUpdates(updates);
    console.log(`✅ Applied ${updates.length} limit updates.`);
    
    // Verify
    console.log("");
    console.log("VERIFICATION - NEW LIMITS");
    console.log("-".repeat(80));
    const newStats = getInventoryStats();
    for (const stat of newStats) {
      const saturationStr = stat.saturationPct > 100 
        ? `⚠️ ${stat.saturationPct.toFixed(0)}%`
        : `✅ ${stat.saturationPct.toFixed(0)}%`;
      console.log(
        stat.walletName.padEnd(20),
        `Limit: ${stat.currentLimit}`.padStart(15),
        saturationStr.padStart(12)
      );
    }
  }

  console.log("");
  console.log("=" .repeat(80));
};

main();
