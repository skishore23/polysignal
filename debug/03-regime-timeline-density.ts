/**
 * Diagnostic 03: Regime timeline density
 * Per-token: feature row count, timeline length, step gaps;
 * histogram of gaps between consecutive timeline points.
 */
import { openDb, getRegimeConfig } from "./shared.js";
import { buildRegimeBase } from "../packages/data/src/regimeAnalysis.js";

const config = getRegimeConfig();
const { sqlite, dbPath } = openDb();

console.log(`\n${"=".repeat(60)}`);
console.log("03 REGIME TIMELINE DENSITY");
console.log(`${"=".repeat(60)}`);
console.log(`DB: ${dbPath}`);
console.log(`Since: ${new Date(config.sinceTs).toISOString()}`);
console.log(`stepMs: ${config.stepMs}\n`);

const base = buildRegimeBase(sqlite, config);
const { stateTimelines, tokenIds } = base;

const featureCountByToken = new Map<string, number>();
if (tokenIds.length > 0) {
  const placeholders = tokenIds.slice(0, 400).map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT token_id as tokenId, COUNT(*) as cnt
       FROM features
       WHERE ts >= ? AND token_id IN (${placeholders})
       GROUP BY token_id`
    )
    .all(config.sinceTs, ...tokenIds.slice(0, 400)) as Array<{ tokenId: string; cnt: number }>;
  for (const r of rows) {
    featureCountByToken.set(r.tokenId, r.cnt);
  }
  for (let i = 400; i < tokenIds.length; i += 400) {
    const chunk = tokenIds.slice(i, i + 400);
    const ph = chunk.map(() => "?").join(",");
    const chunkRows = sqlite
      .prepare(`SELECT token_id as tokenId, COUNT(*) as cnt FROM features WHERE ts >= ? AND token_id IN (${ph}) GROUP BY token_id`)
      .all(config.sinceTs, ...chunk) as Array<{ tokenId: string; cnt: number }>;
    for (const r of chunkRows) {
      featureCountByToken.set(r.tokenId, r.cnt);
    }
  }
}

const timelineLengths: number[] = [];
const allGaps: number[] = [];
const tokensWithGapGtStep: string[] = [];

for (const [tokenId, timeline] of stateTimelines) {
  const len = timeline.length;
  timelineLengths.push(len);

  for (let i = 1; i < timeline.length; i += 1) {
    const prev = timeline[i - 1];
    const cur = timeline[i];
    if (prev && cur) {
      const gapMs = cur.ts - prev.ts;
      allGaps.push(gapMs);
      if (gapMs > config.stepMs) {
        tokensWithGapGtStep.push(tokenId);
      }
    }
  }
}

const minLen = timelineLengths.length > 0 ? Math.min(...timelineLengths) : 0;
const maxLen = timelineLengths.length > 0 ? Math.max(...timelineLengths) : 0;
const avgLen = timelineLengths.length > 0 ? timelineLengths.reduce((a, b) => a + b, 0) / timelineLengths.length : 0;

const hist0_1 = allGaps.filter((g) => g <= 1000).length;
const hist1_5 = allGaps.filter((g) => g > 1000 && g <= 5000).length;
const hist5_60 = allGaps.filter((g) => g > 5000 && g <= 60_000).length;
const histGt60 = allGaps.filter((g) => g > 60_000).length;

console.log("Timeline length (per token):");
console.log(`  Tokens with timeline:       ${stateTimelines.size}`);
console.log(`  Min timeline length:        ${minLen}`);
console.log(`  Max timeline length:        ${maxLen}`);
console.log(`  Avg timeline length:        ${avgLen.toFixed(1)}`);
console.log("");
console.log("Gap histogram (consecutive timeline points, ms):");
console.log(`  0–1s:    ${hist0_1}`);
console.log(`  1–5s:    ${hist1_5}`);
console.log(`  5–60s:   ${hist5_60}`);
console.log(`  >60s:    ${histGt60}`);
console.log(`  Total gaps: ${allGaps.length}`);
console.log("");
const avgFeatures = featureCountByToken.size > 0
  ? [...featureCountByToken.values()].reduce((a, b) => a + b, 0) / featureCountByToken.size
  : 0;
console.log("Feature row count (per token, in window):");
console.log(`  Tokens with features:        ${featureCountByToken.size}`);
console.log(`  Avg feature rows per token:  ${avgFeatures.toFixed(1)}`);
console.log("");
console.log(`Tokens with at least one gap > stepMs (${config.stepMs}ms): ${tokensWithGapGtStep.length}`);
if (tokensWithGapGtStep.length > 0) {
  const sample = [...new Set(tokensWithGapGtStep)].slice(0, 5);
  console.log(`  Sample: ${sample.map((t) => t.slice(0, 20) + "...").join(", ")}`);
}

sqlite.close();
console.log("\n");
