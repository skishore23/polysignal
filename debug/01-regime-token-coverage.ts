/**
 * Diagnostic 01: Regime token coverage
 * Tokens with markouts vs tokens with state timelines; tokens with empty timelines;
 * tokens in fills but not in regime token set.
 */
import { openDb, getRegimeConfig, repoRoot } from "./shared.js";
import { buildRegimeBase } from "../packages/data/src/regimeAnalysis.js";

const config = getRegimeConfig();
const { sqlite, dbPath } = openDb();

console.log(`\n${"=".repeat(60)}`);
console.log("01 REGIME TOKEN COVERAGE");
console.log(`${"=".repeat(60)}`);
console.log(`DB: ${dbPath}`);
console.log(`Since: ${new Date(config.sinceTs).toISOString()}\n`);

const base = buildRegimeBase(sqlite, config);
const { stateTimelines, tokenIds } = base;

const tokensWithTimelines = new Set(stateTimelines.keys());
const tokensWithEmptyTimelines: string[] = [];
for (const [tokenId, timeline] of stateTimelines) {
  if (timeline.length === 0) tokensWithEmptyTimelines.push(tokenId);
}

const markoutTokens = sqlite
  .prepare(
    `SELECT DISTINCT o.token_id as tokenId
     FROM shadow_markouts m
     JOIN shadow_fills f ON f.id = m.fill_id
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE m.horizon_ms = ? AND m.ts >= ?`
  )
  .all(config.horizonMs, config.sinceTs) as Array<{ tokenId: string }>;

const markoutTokenSet = new Set(markoutTokens.map((r) => r.tokenId));
const tokensWithMarkoutsButNoTimeline = [...markoutTokenSet].filter((t) => !tokensWithTimelines.has(t));

const regimeTokenSet = new Set(tokenIds);
const tokensInMarkoutsButNotInRegime = [...markoutTokenSet].filter((t) => !regimeTokenSet.has(t));

console.log("Counts:");
console.log(`  Tokens with state timelines:     ${tokensWithTimelines.size}`);
console.log(`  Tokens with empty timelines:     ${tokensWithEmptyTimelines.length}`);
console.log(`  Tokens with markouts:            ${markoutTokenSet.size}`);
console.log(`  Regime token set size:           ${regimeTokenSet.size}`);
console.log("");
console.log("Gaps:");
console.log(`  Tokens with markouts but no timeline: ${tokensWithMarkoutsButNoTimeline.length}`);
if (tokensWithMarkoutsButNoTimeline.length > 0) {
  const sample = tokensWithMarkoutsButNoTimeline.slice(0, 10);
  console.log(`    Sample: ${sample.join(", ")}${sample.length < tokensWithMarkoutsButNoTimeline.length ? " ..." : ""}`);
}
console.log(`  Tokens in markouts but not in regime set: ${tokensInMarkoutsButNotInRegime.length}`);
if (tokensInMarkoutsButNotInRegime.length > 0) {
  const sample = tokensInMarkoutsButNotInRegime.slice(0, 10);
  console.log(`    Sample: ${sample.join(", ")}${sample.length < tokensInMarkoutsButNotInRegime.length ? " ..." : ""}`);
}

sqlite.close();
console.log("\n");
