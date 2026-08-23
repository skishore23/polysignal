#!/usr/bin/env npx tsx

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRepoRoot, loadConfig } from "../apps/worker/src/config.js";
import { RegimeGate, type RegimeGateConfig } from "../apps/worker/src/regime/RegimeGate.js";

type ManifestJson = {
  stamp?: string;
  generatedAt?: string;
  markovFile?: string;
  strategyFile?: string;
};

type JsonMeta = {
  _meta?: {
    stamp?: string;
    generatedAt?: string;
  };
};

const parseArgs = (): Map<string, string> => {
  const out = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      out.set(raw.slice(2, eq), raw.slice(eq + 1));
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.set(key, next);
      i += 1;
      continue;
    }
    out.set(key, "true");
  }
  return out;
};

const readJson = <T,>(filePath: string): T | null => {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
};

const resolvePath = (baseDir: string, raw: string | null | undefined): string | null => {
  if (!raw) return null;
  if (path.isAbsolute(raw)) return raw;
  return path.join(baseDir, raw);
};

const fileMtimeIso = (filePath: string | null): string => {
  if (!filePath || !existsSync(filePath)) return "missing";
  try {
    return new Date(statSync(filePath).mtimeMs).toISOString();
  } catch {
    return "unreadable";
  }
};

const fallbackSimulation = (cfg: RegimeGateConfig, manifestPath: string): {
  attempted: boolean;
  ok: boolean;
  detail: string;
} => {
  const manifest = readJson<ManifestJson>(manifestPath);
  if (!manifest?.markovFile || !manifest?.strategyFile) {
    return { attempted: false, ok: false, detail: "manifest missing markov/strategy names" };
  }
  const dir = path.dirname(manifestPath);
  const markovPath = resolvePath(dir, manifest.markovFile);
  const strategyPath = resolvePath(dir, manifest.strategyFile);
  if (!markovPath || !strategyPath || !existsSync(markovPath) || !existsSync(strategyPath)) {
    return { attempted: false, ok: false, detail: "markov/strategy file missing" };
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "regime-audit-"));
  try {
    const markovRaw = readFileSync(markovPath, "utf-8");
    const strategyRaw = readFileSync(strategyPath, "utf-8");
    const manifestRaw = readFileSync(manifestPath, "utf-8");
    const tmpMarkov = path.join(tmpDir, "markov_regime.json");
    const tmpStrategy = path.join(tmpDir, "strategy_regime_report.json");
    const tmpManifest = path.join(tmpDir, "regime_manifest.json");

    writeFileSync(tmpMarkov, markovRaw, "utf-8");
    writeFileSync(tmpStrategy, strategyRaw, "utf-8");
    writeFileSync(tmpManifest, manifestRaw, "utf-8");

    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {}
    } as any;

    const gate = new RegimeGate(
      {
        ...cfg,
        reloadMs: 0,
        markovPath: tmpMarkov,
        strategyPath: tmpStrategy,
        manifestPath: tmpManifest
      },
      logger
    );

    const before = gate.getLoadDiagnostics();
    if (!before.loaded) {
      return {
        attempted: true,
        ok: false,
        detail: `initial load failed (${before.lastLoadError ?? "unknown"})`
      };
    }

    writeFileSync(tmpStrategy, "{not-json", "utf-8");
    (gate as any).load();
    const after = gate.getLoadDiagnostics();
    const ok = after.loaded && after.usingLastGood;
    return {
      attempted: true,
      ok,
      detail: ok
        ? "reload failure kept last-good snapshot"
        : `fallback not observed (loaded=${after.loaded} usingLastGood=${after.usingLastGood} err=${after.lastLoadError ?? "none"})`
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

const main = (): void => {
  const args = parseArgs();
  const repoRoot = getRepoRoot();
  const worker = loadConfig();
  const gateConfig = worker.regimeGating;

  const manifestOverride = args.get("manifest");
  const manifestPath = manifestOverride
    ? resolvePath(repoRoot, manifestOverride)
    : resolvePath(repoRoot, gateConfig.manifestPath);

  if (!manifestPath) {
    console.error("[regime-audit] Could not resolve manifest path");
    process.exit(1);
  }

  const manifest = readJson<ManifestJson>(manifestPath);
  const manifestDir = path.dirname(manifestPath);
  const markovPath = resolvePath(manifestDir, manifest?.markovFile ?? gateConfig.markovPath);
  const strategyPath = resolvePath(manifestDir, manifest?.strategyFile ?? gateConfig.strategyPath);
  const markovJson = markovPath ? readJson<JsonMeta>(markovPath) : null;
  const strategyJson = strategyPath ? readJson<JsonMeta>(strategyPath) : null;

  const manifestStamp = manifest?.stamp ?? null;
  const markovStamp = markovJson?._meta?.stamp ?? null;
  const strategyStamp = strategyJson?._meta?.stamp ?? null;

  const invariantFailures: string[] = [];
  if (!existsSync(manifestPath)) invariantFailures.push("manifest_missing");
  if (!manifest) invariantFailures.push("manifest_invalid_json");
  if (manifest && !manifestStamp) invariantFailures.push("manifest_stamp_missing");
  if (!markovPath || !existsSync(markovPath)) invariantFailures.push("markov_missing");
  if (!strategyPath || !existsSync(strategyPath)) invariantFailures.push("strategy_missing");
  if (manifestStamp && markovStamp !== manifestStamp) invariantFailures.push("markov_stamp_mismatch");
  if (manifestStamp && strategyStamp !== manifestStamp) invariantFailures.push("strategy_stamp_mismatch");

  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
  const gate = new RegimeGate({ ...gateConfig, reloadMs: 0 }, logger);
  const gateLoad = gate.getLoadDiagnostics();
  const fallback = fallbackSimulation(gateConfig, manifestPath);

  console.log("Regime Pair Auditor");
  console.log(`repoRoot: ${repoRoot}`);
  console.log(`manifestPath: ${manifestPath}`);
  console.log(`manifestStamp: ${manifestStamp ?? "missing"}`);
  console.log(`markovPath: ${markovPath ?? "missing"}`);
  console.log(`strategyPath: ${strategyPath ?? "missing"}`);
  console.log(`manifestMtime: ${fileMtimeIso(manifestPath)}`);
  console.log(`markovMtime: ${fileMtimeIso(markovPath)}`);
  console.log(`strategyMtime: ${fileMtimeIso(strategyPath)}`);
  console.log(`markovMetaStamp: ${markovStamp ?? "missing"}`);
  console.log(`strategyMetaStamp: ${strategyStamp ?? "missing"}`);
  console.log(`invariantFailures: ${invariantFailures.length ? invariantFailures.join(",") : "none"}`);
  console.log(`gateLoad.loaded: ${gateLoad.loaded}`);
  console.log(`gateLoad.usingLastGood: ${gateLoad.usingLastGood}`);
  console.log(`gateLoad.lastLoadError: ${gateLoad.lastLoadError ?? "none"}`);
  console.log(`gateLoad.manifestStampWanted: ${gateLoad.manifestStampWanted ?? "none"}`);
  console.log(`gateLoad.manifestStampLoaded: ${gateLoad.manifestStampLoaded ?? "none"}`);
  console.log(`gateWould: ${gateLoad.loaded ? (gateLoad.usingLastGood ? "fallback_last_good" : "load_current") : "not_loaded"}`);
  console.log(`lastGoodSimulation.attempted: ${fallback.attempted}`);
  console.log(`lastGoodSimulation.ok: ${fallback.ok}`);
  console.log(`lastGoodSimulation.detail: ${fallback.detail}`);

  const strict = worker.executionPolicy.mode !== "FULL";
  const failed = invariantFailures.length > 0 || (fallback.attempted && !fallback.ok);
  if (failed && strict) {
    console.error("[regime-audit] FAILED (strict mode)");
    process.exit(1);
  }
  if (failed) {
    console.warn("[regime-audit] FAILED (non-strict live mode)");
    return;
  }
  console.log("[regime-audit] OK");
};

main();
