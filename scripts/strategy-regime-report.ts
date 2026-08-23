#!/usr/bin/env npx tsx
/**
 * Strategy x Regime report for maker/taker variants.
 *
 * Usage:
 *   node --import tsx scripts/strategy-regime-report.ts --hours=24 --horizon-ms=300000 --bins=3
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { openDatabase } from "../packages/storage/src/index.js";
import { computeStrategyRegimeReport, type RegimeConfig } from "../packages/data/src/regimeAnalysis.js";

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

const args = parseArgs();
const hours = Math.max(1, Number(args.get("hours") ?? 24));
const horizonMs = Math.max(1000, Number(args.get("horizon-ms") ?? 300_000));
const bins = Math.max(2, Number(args.get("bins") ?? 3));
const stepMs = Math.max(250, Number(args.get("step-ms") ?? 1000));
const sampleLimit = Math.max(1000, Number(args.get("sample") ?? 200_000));
const featuresList = (args.get("features") ?? "spread,depth,obi,vol,micro")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dbRaw = args.get("db") ?? "data/dev.db";
const dbPath = path.isAbsolute(dbRaw) ? dbRaw : path.join(repoRoot, dbRaw);

const { sqlite } = openDatabase(dbPath);
const sinceTs = Date.now() - hours * 3600 * 1000;

const config: RegimeConfig = {
  sinceTs,
  horizonMs,
  bins,
  stepMs,
  sampleLimit,
  features: featuresList
};

const report = computeStrategyRegimeReport(sqlite, config);
const outPath = path.join(repoRoot, "data", "strategy_regime_report.json");
sqlite.close();
await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");

console.log(`[strategy-regime] DB: ${dbPath}`);
console.log(`[strategy-regime] window: last ${hours}h (since ${new Date(sinceTs).toISOString()})`);
console.log(`[strategy-regime] horizon: ${horizonMs}ms | bins=${bins} | step=${stepMs}ms`);
console.log(`[strategy-regime] features: ${(report.config.features ?? []).join(", ")}`);
console.log(`[strategy-regime] rows: ${report.rows?.length ?? 0}`);
console.log(`\n[strategy-regime] wrote ${outPath}`);
