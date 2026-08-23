#!/usr/bin/env tsx

import path from "node:path"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { computeMarkovRegimeReport, computeStrategyRegimeReport, type RegimeConfig } from "../packages/data/src/regimeAnalysis.js"
import {
  discoverDbPath,
  numberArg,
  openReadOnlyDatabase,
  parseCliArgs,
  resolveRepoRoot,
  safeClose,
  stringArg
} from "./lib/db.js"

const args = parseCliArgs()
const repoRoot = resolveRepoRoot()

const dbPath = discoverDbPath(stringArg(args, "db", ""))
const hours = Math.max(1, numberArg(args, "hours", 24))
const horizonMs = Math.max(1_000, numberArg(args, "horizon-ms", 300_000))
const bins = Math.max(2, Math.floor(numberArg(args, "bins", 3)))
const stepMs = Math.max(100, Math.floor(numberArg(args, "step-ms", 1_000)))
const sampleLimit = Math.max(1_000, Math.floor(numberArg(args, "sample-limit", 200_000)))
const features = stringArg(args, "features", "spread,depth,obi,vol,micro")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0)
const outputDirRaw = stringArg(args, "output-dir", "data")
const outputDir = path.isAbsolute(outputDirRaw) ? outputDirRaw : path.join(repoRoot, outputDirRaw)
const minFills = Math.max(0, Math.floor(numberArg(args, "min-fills", 20)))
const winsorClipBps = numberArg(args, "winsor-clip-bps", 250)

const sinceTs = Date.now() - (hours * 3600 * 1000)
const sqlite = openReadOnlyDatabase(dbPath)

const writeJsonAtomic = async (filePath: string, data: unknown): Promise<void> => {
  const tmpPath = `${filePath}.tmp`
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8")
  await rename(tmpPath, filePath)
}

const main = async (): Promise<void> => {
  const fillCount = sqlite
    .prepare(
      "SELECT COUNT(*) as n FROM shadow_fills f JOIN shadow_orders o ON o.id = f.order_id WHERE f.ts >= ? AND o.kind IN ('MAKER_BID','MAKER_ASK','TAKER_BUY','TAKER_SELL')"
    )
    .get(sinceTs) as { n: number } | undefined
  const n = fillCount?.n ?? 0

  if (n < minFills) {
    console.log(`[regime-report-refresh] SKIP db=${dbPath} fill_count=${n} min_fills=${minFills}`)
    return
  }

  const config: RegimeConfig = {
    sinceTs,
    horizonMs,
    bins,
    stepMs,
    sampleLimit,
    features
  }
  ;(config as RegimeConfig & { winsorClipBps?: number }).winsorClipBps = winsorClipBps

  const markov = computeMarkovRegimeReport(sqlite, config)
  const strategy = computeStrategyRegimeReport(sqlite, config)

  await mkdir(outputDir, { recursive: true })
  const markovPath = path.join(outputDir, "markov_regime.json")
  const strategyPath = path.join(outputDir, "strategy_regime_report.json")
  const manifestPath = path.join(outputDir, "regime_manifest.json")

  const stamp = `${Date.now()}:${process.pid}`
  const generatedAt = new Date().toISOString()

  await writeJsonAtomic(markovPath, {
    ...markov,
    _meta: { stamp, generatedAt }
  })
  await writeJsonAtomic(strategyPath, {
    ...strategy,
    _meta: { stamp, generatedAt }
  })
  await writeJsonAtomic(manifestPath, {
    stamp,
    generatedAt,
    markovFile: path.basename(markovPath),
    strategyFile: path.basename(strategyPath)
  })

  console.log(
    `[regime-report-refresh] OK db=${dbPath} fill_count=${n} stamp=${stamp} markov_states=${Object.keys(markov.states ?? {}).length} strategy_rows=${strategy.rows?.length ?? 0} output_dir=${outputDir}`
  )
}

main()
  .catch((err) => {
    console.error(`[regime-report-refresh] FAIL db=${dbPath}`)
    console.error(err instanceof Error ? err.stack ?? err.message : String(err))
    process.exitCode = 1
  })
  .finally(() => {
    safeClose(sqlite)
  })
