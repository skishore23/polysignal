#!/usr/bin/env npx tsx
/**
 * Debug why Top Regimes (Occupancy) Markout column is —.
 * Uses same config and attribution logic as the Markov regime report; prints
 * whether the cause is no markouts, wrong horizon, attribution failure, or fills in other states.
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/debug-regime-markout-empty.ts
 *   npx tsx scripts/archive/manual-diagnostics/debug-regime-markout-empty.ts --hours=24 --horizon-ms=300000
 *   npx tsx scripts/archive/manual-diagnostics/debug-regime-markout-empty.ts --db=data/dev.db
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { openDatabase } from "../../../packages/storage/src/index.js";
import {
  buildRegimeBase,
  lookupStateAt,
  type RegimeConfig
} from "../../../packages/data/src/index.js";

type MarkoutRow = {
  ts: number;
  markoutBps: number | null;
  midAtFill: number | null;
  price: number | null;
  size: number | null;
  tokenId: string;
  kind: string;
  walletId: number | null;
  orderId: number;
  stateId: number | null;
};

const parseArgs = (): Map<string, string> => {
  const map = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const eqIdx = raw.indexOf("=");
    if (eqIdx !== -1) {
      map.set(raw.slice(2, eqIdx), raw.slice(eqIdx + 1));
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      map.set(key, next);
      i += 1;
      continue;
    }
    map.set(key, "true");
  }
  return map;
};

const loadConfigFromWorker = (repoRoot: string): Partial<RegimeConfig> | null => {
  const configPath = path.join(repoRoot, "configs", "worker.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { regimeReport?: Record<string, unknown> };
    const r = parsed.regimeReport;
    if (!r || typeof r !== "object") return null;
    const hours = Number((r as { hours?: number }).hours ?? 6);
    const sinceTs = Date.now() - hours * 3600 * 1000;
    return {
      sinceTs,
      horizonMs: Number((r as { horizonMs?: number }).horizonMs ?? 30_000),
      bins: Number((r as { bins?: number }).bins ?? 3),
      stepMs: Number((r as { stepMs?: number }).stepMs ?? 1000),
      sampleLimit: Number((r as { sampleLimit?: number }).sampleLimit ?? 200_000),
      features: Array.isArray((r as { features?: string[] }).features)
        ? (r as { features: string[] }).features
        : ["spread", "depth", "obi", "vol", "micro"]
    };
  } catch {
    return null;
  }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = parseArgs();

const hours = Math.max(1, Number(args.get("hours") ?? ""));
const horizonMsArg = args.get("horizon-ms");
const dbRaw = args.get("db") ?? "data/dev.db";
const dbPath = path.isAbsolute(dbRaw) ? dbRaw : path.join(repoRoot, dbRaw);
const bins = Math.max(2, Number(args.get("bins") ?? 3));
const stepMs = Math.max(250, Number(args.get("step-ms") ?? 1000));
const sampleLimit = Math.max(1000, Number(args.get("sample") ?? 200_000));
const featuresList = (args.get("features") ?? "spread,depth,obi,vol,micro")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const workerConfig = loadConfigFromWorker(repoRoot);
const useWorker = !args.has("hours") && !args.has("horizon-ms") && workerConfig != null;

const sinceTs =
  useWorker && workerConfig.sinceTs != null
    ? workerConfig.sinceTs
    : Date.now() - Math.max(1, hours || 24) * 3600 * 1000;
const horizonMs =
  useWorker && workerConfig.horizonMs != null
    ? workerConfig.horizonMs
    : Math.max(1000, Number(horizonMsArg ?? 300_000));
const features = useWorker && workerConfig.features?.length ? workerConfig.features : featuresList;

const config: RegimeConfig = {
  sinceTs,
  horizonMs,
  bins,
  stepMs,
  sampleLimit,
  features
};

const { sqlite } = openDatabase(dbPath);
const base = buildRegimeBase(sqlite, config);
const { stateTimelines } = base;

const stateCounts = new Map<number, number>();
for (const timeline of stateTimelines.values()) {
  for (const cur of timeline) {
    if (!cur) continue;
    stateCounts.set(cur.state, (stateCounts.get(cur.state) ?? 0) + 1);
  }
}
const topStatesByOccupancy = [...stateCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([state]) => state);

const markoutRows = sqlite
  .prepare(
    `SELECT m.ts as ts, m.markout_bps as markoutBps, m.mid_at_fill as midAtFill,
            f.price as price, f.size as size,
            o.token_id as tokenId, o.kind as kind, o.wallet_id as walletId, o.id as orderId, o.state_id as stateId
     FROM shadow_markouts m
     JOIN shadow_fills f ON f.id = m.fill_id
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE m.horizon_ms = ? AND m.ts >= ?`
  )
  .all(config.horizonMs, config.sinceTs) as MarkoutRow[];

let total = markoutRows.length;
let filteredOut = 0;
let viaStateId = 0;
let viaTimeline = 0;
let dropped = 0;
let droppedNoTimeline = 0;
let droppedTsBeforeFirst = 0;
let droppedOther = 0;
const byState = new Map<number, number>();

for (const row of markoutRows) {
  if (!Number.isFinite(row.markoutBps ?? NaN)) {
    filteredOut += 1;
    continue;
  }
  if (!Number.isFinite(row.size ?? NaN) || (row.size ?? 0) <= 0) {
    filteredOut += 1;
    continue;
  }
  const mid = row.midAtFill ?? row.price ?? 0;
  if (!Number.isFinite(mid) || mid <= 0) {
    filteredOut += 1;
    continue;
  }

  let state: number | null = Number.isFinite(row.stateId ?? NaN) ? (row.stateId as number) : null;
  if (state != null) {
    viaStateId += 1;
    byState.set(state, (byState.get(state) ?? 0) + 1);
    continue;
  }

  const timeline = stateTimelines.get(row.tokenId);
  if (!timeline || timeline.length === 0) {
    dropped += 1;
    droppedNoTimeline += 1;
    continue;
  }
  state = lookupStateAt(timeline, row.ts);
  if (state != null) {
    viaTimeline += 1;
    byState.set(state, (byState.get(state) ?? 0) + 1);
    continue;
  }

  dropped += 1;
  const firstTs = timeline[0]?.ts;
  if (firstTs != null && row.ts < firstTs) {
    droppedTsBeforeFirst += 1;
  } else {
    droppedOther += 1;
  }
}

const passed = total - filteredOut;
const statesWithMarkout = [...byState.keys()].sort((a, b) => (byState.get(b) ?? 0) - (byState.get(a) ?? 0));
const topWithMarkout = topStatesByOccupancy.filter((s) => byState.has(s));

const hoursUsed = Math.round((Date.now() - config.sinceTs) / (3600 * 1000));

console.log("");
console.log("=== Debug: why Top Regimes Markout is — ===");
console.log("");
console.log("Config:");
console.log(`  sinceTs:    ${config.sinceTs} (${new Date(config.sinceTs).toISOString()})`);
console.log(`  horizonMs:  ${config.horizonMs}`);
console.log(`  hours:      ~${hoursUsed}h`);
console.log(`  db:         ${dbPath}`);
if (useWorker) {
  console.log("  (from configs/worker.json regimeReport)");
}
console.log("");
console.log("Markout rows:");
console.log(`  total in window (horizon=${config.horizonMs}ms): ${total}`);
console.log(`  after filters (valid bps, size, mid):          ${passed}`);
if (total === 0) {
  console.log("");
  console.log("No markouts in window for this horizon. Check horizon (e.g. 300000) and run backfill-markouts if needed.");
}
console.log("");
console.log("Attribution:");
console.log(`  attributed via order.state_id:  ${viaStateId}`);
console.log(`  attributed via timeline lookup: ${viaTimeline}`);
console.log(`  dropped (state == null):        ${dropped}`);
if (dropped > 0) {
  console.log(`    no timeline for token:  ${droppedNoTimeline}`);
  console.log(`    ts before first step:  ${droppedTsBeforeFirst}`);
  console.log(`    other:                 ${droppedOther}`);
}
if (passed > 0 && dropped === passed) {
  console.log("");
  console.log("All markouts dropped; check order.state_id coverage and timeline coverage (tokens, ts range).");
}
console.log("");
console.log("States with at least one attributed markout:");
if (statesWithMarkout.length === 0) {
  console.log("  (none)");
} else {
  for (const s of statesWithMarkout.slice(0, 20)) {
    console.log(`  state ${s}: ${byState.get(s)} markouts`);
  }
  if (statesWithMarkout.length > 20) {
    console.log(`  ... and ${statesWithMarkout.length - 20} more`);
  }
}
console.log("");
console.log("Top 10 states by occupancy (Count in UI):");
for (let i = 0; i < topStatesByOccupancy.length; i += 1) {
  const s = topStatesByOccupancy[i];
  const occ = stateCounts.get(s) ?? 0;
  const hasMarkout = byState.has(s);
  console.log(`  ${i + 1}. state ${s}: count=${occ}  markout=${hasMarkout ? "yes" : "—"}`);
}
console.log("");
console.log("Overlap (top 10 occupancy states that have attributed markout):");
if (topWithMarkout.length === 0) {
  console.log("  None. Top occupancy states have no attributed markouts → Markout column — for them; fills are in other states or attribution failed.");
} else {
  console.log(`  ${topWithMarkout.join(", ")}`);
}
console.log("");

sqlite.close();
