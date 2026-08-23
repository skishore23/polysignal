/**
 * Diagnostic 05: Regime config check
 * Echo config (sinceTs, horizonMs, bins, stepMs, features);
 * compare with worker.json regimeReport/regimeGating.
 */
import { getRegimeConfig, repoRoot } from "./shared.js";
import { readFileSync } from "node:fs";
import path from "node:path";

console.log(`\n${"=".repeat(60)}`);
console.log("05 REGIME CONFIG CHECK");
console.log(`${"=".repeat(60)}\n`);

const config = getRegimeConfig();
const raw = readFileSync(path.join(repoRoot, "configs", "worker.json"), "utf-8");
const parsed = JSON.parse(raw) as {
  regimeReport?: Record<string, unknown>;
  regimeGating?: Record<string, unknown>;
};

const report = parsed.regimeReport ?? {};
const gating = parsed.regimeGating ?? {};

console.log("regimeReport (worker.json):");
console.log(`  hours:        ${report.hours ?? "—"}`);
console.log(`  horizonMs:    ${report.horizonMs ?? "—"}`);
console.log(`  bins:         ${report.bins ?? "—"}`);
console.log(`  stepMs:       ${report.stepMs ?? "—"}`);
console.log(`  sampleLimit:  ${report.sampleLimit ?? "—"}`);
console.log(`  features:     ${Array.isArray(report.features) ? report.features.join(", ") : "—"}`);
console.log(`  outputDir:    ${report.outputDir ?? "—"}`);
console.log("");
console.log("Resolved RegimeConfig:");
console.log(`  sinceTs:      ${config.sinceTs} (${new Date(config.sinceTs).toISOString()})`);
console.log(`  horizonMs:    ${config.horizonMs}`);
console.log(`  bins:         ${config.bins}`);
console.log(`  stepMs:       ${config.stepMs}`);
console.log(`  sampleLimit:  ${config.sampleLimit}`);
console.log(`  features:     ${config.features.join(", ")}`);
console.log("");
console.log("regimeGating (worker.json):");
console.log(`  enabled:      ${gating.enabled ?? "—"}`);
console.log(`  markovPath:   ${gating.markovPath ?? "—"}`);
console.log(`  strategyPath: ${gating.strategyPath ?? "—"}`);
console.log(`  minCount:     ${gating.minCount ?? "—"}`);
console.log(`  minWavgBps:   ${gating.minWavgBps ?? "—"}`);
console.log(`  minFillRate:  ${gating.minFillRate ?? "—"}`);
console.log(`  reloadMs:     ${gating.reloadMs ?? "—"}`);
console.log(`  failOpen:     ${gating.failOpen ?? "—"}`);

console.log("\n");
