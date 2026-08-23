import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BookStore, type Book } from "@polysignal/book";
import { FeatureEngine } from "@polysignal/features";
import {
  openDatabase,
  features as featuresTable,
} from "@polysignal/storage";
import type { FeatureRow } from "@polysignal/types";
import { sleep } from "@polysignal/utils";
import { createLogger } from "./logger";
import { loadConfig } from "./config";
import { startHealthServer, type HealthState } from "./healthServer";
import { IngestionEngine } from "./ingestion/IngestionEngine";
import { startRetentionLoop } from "./retentionLoop";
import { runStartupVerification, startVerificationLoop } from "./verificationLoop";
import { ShadowExecutionLoop } from "./shadow/ShadowExecutionLoop";
import { MakerLoop } from "./maker/MakerLoop";
import { TakerLoop } from "./taker/TakerLoop";
import { LiveExecutionGateway } from "./execution/clobExecution";
import { startUserWsReconciler, type UserWsReconciler } from "./execution/userWsReconciler";
import { ArbExecutor, ArbScannerLoop } from "./arb";
import {
  BeliefEngine,
  MicrostructureBeliefProvider,
  SportsbookBeliefProvider
} from "./belief";
import { RegimeGate } from "./regime/RegimeGate";
import { RegimeReportLoop } from "./regime/RegimeReportLoop";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

const log = createLogger();
const config = loadConfig();

const dbPath = path.isAbsolute(config.dbPath)
  ? config.dbPath
  : path.join(repoRoot, config.dbPath);
const eventsPath = path.isAbsolute(config.eventsPath)
  ? config.eventsPath
  : path.join(repoRoot, config.eventsPath);

let eventsLog: ReturnType<typeof createWriteStream> | null = null;

await mkdir(path.dirname(dbPath), { recursive: true });
if (config.eventsLogEnabled) {
  await mkdir(path.dirname(eventsPath), { recursive: true });
  eventsLog = createWriteStream(eventsPath, { flags: "a" });
}

const { sqlite, db } = openDatabase(dbPath);
log.info({ dbPath }, "Worker started");

const health: HealthState = {
  startedAt: Date.now(),
  marketsTracked: 0,
  tokensTracked: 0,
  wsConnected: false,
  lastUpdate: null,
  loopStates: {}
};

if (config.port > 0) {
  startHealthServer(config.port, health);
}

const store = new BookStore();
const liveExecution = new LiveExecutionGateway(config.liveExecution, { logger: log });
const regimeGate = new RegimeGate(config.regimeGating, log);
const regimeReportLoop = new RegimeReportLoop(config.regimeReport, { sqlite, logger: log });
let userWs: UserWsReconciler | null = null;
let latestConditionIds: string[] = [];

const upsertLatestFeatureStmt = sqlite.prepare(
  `INSERT INTO latest_features
   (token_id, market_id, ts, mid, spread, obi, microprice, microprice_minus_mid, bid_depth_top, ask_depth_top, r10s, r1m, r5m,
    accel_1m, skew_30m, entropy_30m, vol30m, staleness_sec, best_bid, best_ask, recv_ts_ms, last_event_global_seq)
   VALUES (@tokenId, @marketId, @ts, @mid, @spread, @obi, @microprice, @micropriceMinusMid, @bidDepthTop, @askDepthTop, @r10s, @r1m, @r5m,
           @accel1m, @skew30m, @entropy30m, @vol30m, @stalenessSec, @bestBid, @bestAsk, @recvTsMs, @lastEventGlobalSeq)
   ON CONFLICT(token_id) DO UPDATE SET
     market_id = excluded.market_id,
     ts = excluded.ts,
     mid = excluded.mid,
     spread = excluded.spread,
     obi = excluded.obi,
     microprice = excluded.microprice,
     microprice_minus_mid = excluded.microprice_minus_mid,
     bid_depth_top = excluded.bid_depth_top,
     ask_depth_top = excluded.ask_depth_top,
     r10s = excluded.r10s,
     r1m = excluded.r1m,
     r5m = excluded.r5m,
     accel_1m = excluded.accel_1m,
     skew_30m = excluded.skew_30m,
     entropy_30m = excluded.entropy_30m,
     vol30m = excluded.vol30m,
     staleness_sec = excluded.staleness_sec,
     best_bid = excluded.best_bid,
     best_ask = excluded.best_ask,
     recv_ts_ms = excluded.recv_ts_ms,
     last_event_global_seq = excluded.last_event_global_seq`
);

const upsertLatestFeatures = sqlite.transaction((rows: FeatureRow[]) => {
  for (const row of rows) {
    upsertLatestFeatureStmt.run(row);
  }
});

const featureEngine = new FeatureEngine(store, {
  topKLevels: config.feature.topKLevels,
  returnWindowSec: 10,
  volWindowSec: 1800,
  sampleIntervalSec: 1
});

const ingestion = new IngestionEngine(
  {
    clobWsUrl: config.clobWsUrl,
    universeRefreshSec: config.universe.refreshSec,
    topN: config.universe.topN,
    activeTokenLimit: config.universe.activeTokenLimit,
    activeTokenWindowMinutes: config.universe.activeTokenWindowMinutes,
    clobEventsSampleRate: config.clobEventsSampleRate,
    marketScope: config.marketScope
  },
  {
    db,
    sqlite,
    logger: log,
    store,
    onUniverseUpdated: ({ conditionIds }) => {
      latestConditionIds = conditionIds;
      if (userWs) userWs.updateMarkets(conditionIds);
    }
  }
);

const shadowLoop = new ShadowExecutionLoop(
  {
    intervalMs: 1000,
    makerStalenessSec: config.feature.makerMaxStalenessSec,
    markoutHorizonsMs: [1000, 5000, 30000, 60000, 300000, 600000],
    makerQueueFillProb: 0.6,
    makerPriceToleranceBps: config.makerEv.priceToleranceBps,
    forceSyntheticFills: false,
    syntheticFillIntervalMs: 30_000,
    rebalanceEnabled: true,
    rebalanceIntervalMs: 60_000,
    rebalanceTriggerFraction: 0.6,
    rebalanceTargetFraction: 0.2
  },
  {
    sqlite,
    logger: log
  }
);

const belief = new BeliefEngine(
  [
    new SportsbookBeliefProvider({
      enabled: config.belief.sportsbook.enabled,
      baseUrl: config.belief.sportsbook.baseUrl,
      apiKey: config.belief.sportsbook.apiKey,
      timeoutMs: config.belief.sportsbook.timeoutMs
    }),
    new MicrostructureBeliefProvider()
  ],
  {
    providerWeights: config.belief.providerWeights,
    minConfidence: config.belief.minConfidence
  },
  {
    sqlite,
    logger: log
  }
);

const makerLoop = new MakerLoop(
  {
    intervalMs: config.makerEv.intervalMs,
    quoteSize: config.makerEv.quoteSize,
    maxNotionalPerOrderUsd: config.makerEv.maxNotionalPerOrderUsd,
    minExpectedEvBps: config.makerEv.minExpectedEvBps,
    maxInventoryAbs: config.makerEv.maxInventoryAbs,
    inventoryLambdaBps: config.makerEv.inventoryLambdaBps,
    quoteHalfSpreadBps: config.makerEv.quoteHalfSpreadBps,
    maxSpread: config.makerEv.maxSpread,
    minDepth: config.makerEv.minDepth,
    slippageBps: config.fees.slippageBps,
    adverseSelectionBps: config.fees.adverseSelectionBps,
    queueLossBps: config.fees.queueLossBps,
    rebateBps: config.fees.rebateBps,
    rebateShareAssumption: config.makerEv.rebateShareAssumption,
    liquidityRewardBpsWhenScoring: config.makerEv.liquidityRewardBpsWhenScoring,
    orderTtlMs: config.executionSafeguards.orderTtlMs,
    priceToleranceBps: config.makerEv.priceToleranceBps,
    marketScope: config.marketScope,
    executionMode: config.executionPolicy.mode,
    regimeModulation: config.regimeGating.modulation,
    tradeFlowGate: config.makerEv.tradeFlowGate
  },
  {
    sqlite,
    logger: log,
    belief,
    execution: liveExecution,
    regimeGate
  }
);

const takerLoop = new TakerLoop(
  {
    enabled: config.taker.enabled,
    intervalMs: config.taker.intervalMs,
    baseOrderSize: config.taker.baseOrderSize,
    maxNotionalPerOrderUsd: config.taker.maxNotionalPerOrderUsd,
    minNetEdgeBps: config.taker.minNetEdgeBps,
    maxLongPerToken: config.taker.maxLongPerToken,
    maxShortPerToken: config.taker.maxShortPerToken,
    maxSpread: config.taker.maxSpread,
    minDepth: config.taker.minDepth,
    slippageBps: config.fees.slippageBps,
    adverseSelectionBps: config.fees.adverseSelectionBps,
    queueLossBps: config.fees.queueLossBps,
    inventoryPenaltyBps: config.taker.inventoryPenaltyBps,
    orderTtlMs: config.executionSafeguards.orderTtlMs,
    marketScope: config.marketScope,
    executionMode: config.executionPolicy.mode,
    regimeModulation: config.regimeGating.modulation,
    close: config.taker.close,
    maxFeatureStalenessSec: config.feature.takerMaxStalenessSec
  },
  {
    sqlite,
    logger: log,
    belief,
    execution: liveExecution,
    regimeGate
  }
);

const arbExecutor = new ArbExecutor(
  {
    executionMode: config.executionPolicy.mode,
    orderTtlMs: config.executionSafeguards.orderTtlMs,
    maxBatchOrders: config.executionSafeguards.maxBatchOrders
  },
  {
    sqlite,
    logger: log,
    execution: liveExecution
  }
);

const arbScanner = new ArbScannerLoop(
  {
    enabled: config.arb.enabled,
    intervalMs: config.arb.intervalMs,
    minNetEdgeBps: config.arb.minNetEdgeBps,
    maxNotionalUsd: config.arb.maxNotionalUsd,
    maxConcurrentGroups: config.arb.maxConcurrentGroups,
    enableNegRisk: config.arb.enableNegRisk,
    slippageBpsPerLeg: config.fees.slippageBps,
    adverseSelectionBpsPerLeg: config.fees.adverseSelectionBps,
    queueLossBpsPerLeg: config.fees.queueLossBps,
    rebateBpsPerLeg: config.fees.rebateBps,
    marketScope: config.marketScope
  },
  {
    sqlite,
    logger: log,
    executor: arbExecutor
  }
);

const stopRetention = startRetentionLoop(
  { intervalHours: config.retentionIntervalHours, retention: config.retention, disableBackup: true },
  { sqlite, logger: log, dataDir: path.dirname(dbPath) }
);

const stopVerification = startVerificationLoop(config.verification, {
  repoRoot,
  logger: log,
  sqlite
});

let shutdownRequested = false;

function isBookSane(book: Book): boolean {
  const bestBid = book.bids[0]?.price ?? null;
  const bestAsk = book.asks[0]?.price ?? null;
  if (bestBid != null && (bestBid < 0 || bestBid > 1)) return false;
  if (bestAsk != null && (bestAsk < 0 || bestAsk > 1)) return false;
  if (bestBid != null && bestAsk != null && bestBid > bestAsk) return false;
  return true;
}

function isValidFeatureRow(row: FeatureRow): boolean {
  if (row.mid == null || !Number.isFinite(row.mid) || row.mid <= 0 || row.mid >= 1) return false;
  if (row.spread == null || !Number.isFinite(row.spread) || row.spread < 0) return false;
  if (row.bestBid != null && row.bestAsk != null && row.bestBid > row.bestAsk) return false;
  return true;
}

function insertFeatures(rows: FeatureRow[]): void {
  if (!rows.length) return;
  const validRows = rows.filter(isValidFeatureRow);
  if (!validRows.length) return;
  db.insert(featuresTable).values(validRows).run();
  upsertLatestFeatures(validRows);
}

async function waitForWssConnected(timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!shutdownRequested && Date.now() - start < timeoutMs) {
    if (ingestion.state.wsConnected) return;
    await sleep(200);
  }
  if (!ingestion.state.wsConnected) {
    log.warn("WSS failed to connect within timeout; continuing startup and waiting for reconnect");
  }
}

function collectFeatureRows(now: number): FeatureRow[] {
  const tokenIds = ingestion.getTrackedTokenIds();
  if (!tokenIds.length) return [];

  const rows: FeatureRow[] = [];
  for (const tokenId of tokenIds) {
    const book = store.getBook(tokenId);
    if (!book || !isBookSane(book)) continue;
    const marketId = book.marketId ?? null;
    const base = featureEngine.compute(tokenId, marketId, now);
    const feature: FeatureRow = {
      ...base,
      bestBid: book.bids[0]?.price ?? null,
      bestAsk: book.asks[0]?.price ?? null,
      recvTsMs: book.recvTsMs ?? book.lastEventMs ?? null,
      lastEventGlobalSeq: book.lastEventGlobalSeq ?? null
    };
    rows.push(feature);
  }
  return rows;
}

async function warmFeatureState(timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!shutdownRequested && Date.now() - startedAt < timeoutMs) {
    const rows = collectFeatureRows(Date.now());
    if (rows.length > 0) {
      insertFeatures(rows);
      return;
    }
    await sleep(250);
  }
  log.warn({ timeoutMs }, "Feature warmup did not produce rows before startup verification");
}

async function runFeatureLoop(): Promise<void> {
  while (!shutdownRequested) {
    try {
      health.marketsTracked = ingestion.state.marketsTracked;
      health.tokensTracked = ingestion.state.tokensTracked;
      health.wsConnected = ingestion.state.wsConnected;
      health.lastUpdate = ingestion.state.lastUpdate;

      const now = Date.now();
      const rows = collectFeatureRows(now);
      if (!rows.length) {
        await sleep(config.feature.loopIntervalMs);
        continue;
      }

      insertFeatures(rows);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "Feature loop iteration failed");
    }

    await sleep(config.feature.loopIntervalMs);
  }
}

async function shutdown(): Promise<void> {
  if (shutdownRequested) return;
  shutdownRequested = true;

  try {
    makerLoop.stop();
    takerLoop.stop();
    arbScanner.stop();
    shadowLoop.stop();
    regimeReportLoop.stop();
    await ingestion.stop();
    userWs?.close();
    stopRetention();
    stopVerification();
    eventsLog?.end();
    sqlite.close();
    log.info("Shutdown complete");
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "Shutdown failure");
  }
}

function setupShutdownHandlers(): void {
  const handler = async () => {
    await shutdown();
    process.exit(0);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

async function main(): Promise<void> {
  setupShutdownHandlers();

  await ingestion.start();
  latestConditionIds = ingestion.getTrackedConditionIds();

  if (config.liveExecution.userWsEnabled) {
    userWs = await startUserWsReconciler(config.liveExecution, { sqlite, logger: log }, latestConditionIds);
  }

  await waitForWssConnected(8_000);
  await warmFeatureState(8_000);

  await runStartupVerification(config.verification, {
    repoRoot,
    logger: log,
    sqlite
  });

  shadowLoop.start();
  regimeReportLoop.start();
  makerLoop.start();
  takerLoop.start();
  arbScanner.start();

  await runFeatureLoop();

  if (shutdownRequested) {
    await shutdown();
  }
}

main().catch(async (err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, "Worker crashed");
  await shutdown();
  process.exit(1);
});
