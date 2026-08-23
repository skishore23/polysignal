/**
 * Shared setup for regime debug scripts.
 * Uses existing storage DB connection pattern.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../packages/storage/src/index.js";
import type { RegimeConfig } from "../packages/data/src/regimeAnalysis.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, "..");

const loadWorkerConfig = (): { regimeReport: RegimeConfig; regimeGating: Record<string, unknown> } => {
  const configPath = path.join(repoRoot, "configs", "worker.json");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as { regimeReport?: unknown; regimeGating?: unknown };
  const regimeReport = parsed.regimeReport as RegimeConfig;
  const regimeGating = (parsed.regimeGating ?? {}) as Record<string, unknown>;
  return { regimeReport, regimeGating };
};

export const getRegimeConfig = (): RegimeConfig => {
  const { regimeReport } = loadWorkerConfig();
  const hours = Number(regimeReport?.hours ?? 6);
  const sinceTs = Date.now() - hours * 3600 * 1000;
  return {
    sinceTs,
    horizonMs: Number(regimeReport?.horizonMs ?? 30_000),
    bins: Number(regimeReport?.bins ?? 3),
    stepMs: Number(regimeReport?.stepMs ?? 1000),
    sampleLimit: Number(regimeReport?.sampleLimit ?? 200_000),
    features: Array.isArray(regimeReport?.features) ? regimeReport.features : ["spread", "depth", "obi", "vol", "micro"]
  };
};

export const getDbPath = (): string => {
  const raw = process.env.DB_PATH ?? "data/dev.db";
  return path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
};

export const openDb = () => {
  const dbPath = getDbPath();
  const { sqlite } = openDatabase(dbPath);
  return { sqlite, dbPath };
};
