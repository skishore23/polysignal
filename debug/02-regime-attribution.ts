/**
 * Diagnostic 02: Regime attribution
 * Count markouts with state == null vs attributed; per-token attribution rate;
 * sample of dropped markouts (ts, tokenId, kind).
 */
import { openDb, getRegimeConfig } from "./shared.js";
import { buildRegimeBase, lookupStateAt } from "../packages/data/src/index.js";

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

const config = getRegimeConfig();
const { sqlite, dbPath } = openDb();

console.log(`\n${"=".repeat(60)}`);
console.log("02 REGIME ATTRIBUTION");
console.log(`${"=".repeat(60)}`);
console.log(`DB: ${dbPath}`);
console.log(`Since: ${new Date(config.sinceTs).toISOString()}\n`);

const base = buildRegimeBase(sqlite, config);
const { stateTimelines } = base;

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

let attributed = 0;
let attributedViaStateId = 0;
let dropped = 0;
const droppedSample: Array<{ ts: number; tokenId: string; kind: string }> = [];
const perTokenAttribution = new Map<string, { total: number; attributed: number }>();

for (const row of markoutRows) {
  if (!Number.isFinite(row.markoutBps ?? NaN)) continue;
  if (!Number.isFinite(row.size ?? NaN) || (row.size ?? 0) <= 0) continue;
  const mid = row.midAtFill ?? row.price ?? 0;
  if (!Number.isFinite(mid) || mid <= 0) continue;

  let state: number | null = Number.isFinite(row.stateId ?? NaN) ? (row.stateId as number) : null;
  if (state != null) attributedViaStateId++;
  if (state == null) {
    const timeline = stateTimelines.get(row.tokenId);
    state = timeline ? lookupStateAt(timeline, row.ts) : null;
  }

  const agg = perTokenAttribution.get(row.tokenId) ?? { total: 0, attributed: 0 };
  agg.total += 1;
  perTokenAttribution.set(row.tokenId, agg);

  if (state != null) {
    attributed += 1;
    agg.attributed += 1;
  } else {
    dropped += 1;
    if (droppedSample.length < 15) {
      droppedSample.push({ ts: row.ts, tokenId: row.tokenId, kind: row.kind });
    }
  }
}

const total = attributed + dropped;
const rate = total > 0 ? (attributed / total) * 100 : 0;

console.log("Attribution:");
console.log(`  Total markouts (valid):     ${total}`);
console.log(`  Attributed (state found):   ${attributed}`);
console.log(`  Attributed via order.state_id: ${attributedViaStateId}`);
console.log(`  Dropped (state == null):    ${dropped}`);
console.log(`  Attribution rate:           ${rate.toFixed(1)}%`);
console.log("");
console.log("Per-token attribution (tokens with markouts):");
const tokensWithMarkouts = [...perTokenAttribution.entries()].sort((a, b) => b[1].total - a[1].total);
for (const [tokenId, agg] of tokensWithMarkouts.slice(0, 10)) {
  const r = agg.total > 0 ? ((agg.attributed / agg.total) * 100).toFixed(1) : "—";
  console.log(`  ${tokenId.slice(0, 20)}... total=${agg.total} attributed=${agg.attributed} rate=${r}%`);
}
if (tokensWithMarkouts.length > 10) {
  console.log(`  ... and ${tokensWithMarkouts.length - 10} more`);
}
console.log("");
console.log("Sample of dropped markouts (ts, tokenId, kind):");
for (const s of droppedSample) {
  console.log(`  ${new Date(s.ts).toISOString()}  ${s.tokenId.slice(0, 24)}...  ${s.kind}`);
}

sqlite.close();
console.log("\n");
