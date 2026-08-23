import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RETENTION_CONFIG,
  type RetentionConfig,
} from "@polysignal/storage";
import type { MarketScope } from "./trading/MarketProfile";
import type { RegimeGateConfig } from "./regime/RegimeGate";
import type { RegimeReportConfig } from "./regime/RegimeReportLoop";

type VerificationStartupConfig = {
  enabled: boolean;
  quick: boolean;
  hardFail: boolean;
};

type VerificationBackgroundConfig = {
  enabled: boolean;
  intervalMinutes: number;
  hardFail: boolean;
};

type VerificationMarketDataConfig = {
  windowHours: number;
  cleanupNullFeatures: boolean;
  cleanupBatchSize: number;
  cleanupMaxBatches: number;
};

export type VerificationRealismConfig = {
  enforcement: "warn" | "hard";
  makerRealFillRateMin: number;
  makerRealFillsPerDayMin: number;
  takerCloseRatioMin: number;
  takerOneSidedMax: number;
  requireRuntimeLiveness: boolean;
};

export type VerificationConfig = {
  startup: VerificationStartupConfig;
  background: VerificationBackgroundConfig;
  marketData: VerificationMarketDataConfig;
  realism: VerificationRealismConfig;
};

export type ExecutionMode = "PAPER" | "FULL";

export type RegimeModulationConfig = {
  enabled: boolean;
  sizeMultiplierMin: number;
  sizeMultiplierMax: number;
  inventoryScaleFloor: number;
  inventoryScaleCap: number;
  spreadMultiplier: number;
  spreadTicksMin: number;
  spreadTicksMax: number;
};

export type WorkerRegimeGatingConfig = RegimeGateConfig & {
  modulation: RegimeModulationConfig;
};

export type MakerTradeFlowGateMode = "PASSIVE_DECAY" | "IMMEDIATE_CANCEL";

export type MakerTradeFlowGateConfig = {
  enabled: boolean;
  lookbackSec: number;
  minTradeEvents: number;
  mode: MakerTradeFlowGateMode;
  staleCancelAgeSec: number;
};

export type TakerCloseConfig = {
  enabled: boolean;
  maxHoldSec: number;
  closeMinEdgeToHoldBps: number;
  edgeBelowTicks: number;
  edgeBelowMs: number;
  closeCooldownSec: number;
};

export type TakerToxicityConfig = {
  enabled: boolean;
  lookbackSec: number;
  minTradeEvents: number;
  shockBps: number;
  dominantSideRatio: number;
  micropriceShockBps: number;
  cooldownMs: number;
};

export type TakerAdaptiveSideGateConfig = {
  enabled: boolean;
  lookbackSec: number;
  horizonMs: number;
  minFills: number;
  minAvgMarkoutBps: number;
  blockMs: number;
};

type WorkerFileConfig = {
  topN: number;
  activeTokenLimit: number;
  activeTokenWindowMinutes: number;
  universeRefreshSec: number;
  makerIntervalMs: number;
  takerIntervalMs: number;
  arbIntervalMs: number;
  makerMaxStalenessSec: number;
  takerMaxStalenessSec: number;
  featureLoopIntervalMs: number;
  fees: {
    slippageBps: number;
    adverseSelectionBps: number;
    queueLossBps: number;
    rebateBps: number;
  };
  belief: {
    minConfidence: number;
    providerWeights: Record<string, number>;
    sportsbook: {
      enabled: boolean;
      baseUrl: string | null;
      apiKey: string | null;
      timeoutMs: number;
    };
  };
  arb: {
    enabled: boolean;
    minNetEdgeBps: number;
    maxNotionalUsd: number;
    maxConcurrentGroups: number;
    enableNegRisk: boolean;
  };
  taker: {
    enabled: boolean;
    baseOrderSize: number;
    maxNotionalPerOrderUsd: number;
    minNetEdgeBps: number;
    maxLongPerToken: number;
    maxShortPerToken: number;
    maxSpread: number;
    minDepth: number;
    inventoryPenaltyBps: number;
    close: TakerCloseConfig;
  };
  makerEv: {
    quoteSize: number;
    maxNotionalPerOrderUsd: number;
    minExpectedEvBps: number;
    maxInventoryAbs: number;
    inventoryLambdaBps: number;
    quoteHalfSpreadBps: number;
    maxSpread: number;
    minDepth: number;
    priceToleranceBps: number;
    rebateShareAssumption: number;
    liquidityRewardBpsWhenScoring: number;
    tradeFlowGate: MakerTradeFlowGateConfig;
  };
  marketScope: MarketScope;
  executionSafeguards: {
    orderTtlMs: number;
    maxBatchOrders: number;
  };
  regimeGating: WorkerRegimeGatingConfig;
  regimeReport: RegimeReportConfig;
};

export type WorkerConfig = {
  dbPath: string;
  eventsPath: string;
  eventsLogEnabled: boolean;
  port: number;
  clobWsUrl: string;
  clobEventsSampleRate: number;
  universe: {
    topN: number;
    activeTokenLimit: number;
    activeTokenWindowMinutes: number;
    refreshSec: number;
  };
  feature: {
    loopIntervalMs: number;
    topKLevels: number;
    makerMaxStalenessSec: number;
    takerMaxStalenessSec: number;
  };
  fees: WorkerFileConfig["fees"];
  marketScope: WorkerFileConfig["marketScope"];
  belief: WorkerFileConfig["belief"];
  arb: WorkerFileConfig["arb"] & {
    intervalMs: number;
  };
  taker: WorkerFileConfig["taker"] & {
    intervalMs: number;
  };
  makerEv: WorkerFileConfig["makerEv"] & {
    intervalMs: number;
  };
  executionSafeguards: WorkerFileConfig["executionSafeguards"];
  liveExecution: {
    enabled: boolean;
    host: string;
    chainId: number;
    privateKey: string | null;
    apiKey: string | null;
    apiSecret: string | null;
    apiPassphrase: string | null;
    signatureType: number;
    funder: string | null;
    userWsUrl: string;
    userWsEnabled: boolean;
  };
  executionPolicy: {
    mode: ExecutionMode;
  };
  retention: RetentionConfig;
  retentionIntervalHours: number;
  verification: VerificationConfig;
  regimeGating: WorkerRegimeGatingConfig;
  regimeReport: RegimeReportConfig;
};

function readJsonFile<T>(filePath: string): T | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

function toStringOrNull(value: unknown, fallback: string | null): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return fallback;
}

function toNumberRecord(value: unknown, fallback: Record<string, number>): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const out: Record<string, number> = { ...fallback };
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return out;
}

function toStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return out.length ? out : fallback;
}

function toMarketScope(value: unknown, fallback: MarketScope): MarketScope {
  if (value === "PROFILE_KNOWN_ONLY" || value === "ALL") {
    return value;
  }
  return fallback;
}

function toStringEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
}

function loadWorkerFileConfig(repoRoot: string): WorkerFileConfig {
  const defaults: WorkerFileConfig = {
    topN: 200,
    activeTokenLimit: 200,
    activeTokenWindowMinutes: 60,
    universeRefreshSec: 300,
    makerIntervalMs: 1_500,
    takerIntervalMs: 10_000,
    arbIntervalMs: 5_000,
    makerMaxStalenessSec: 120,
    takerMaxStalenessSec: 60,
    featureLoopIntervalMs: 1_000,
    fees: {
      slippageBps: 5,
      adverseSelectionBps: 2,
      queueLossBps: 1,
      rebateBps: 0
    },
    belief: {
      minConfidence: 0.55,
      providerWeights: {
        sportsbook: 1.2,
        microstructure: 1.0
      },
      sportsbook: {
        enabled: false,
        baseUrl: null,
        apiKey: null,
        timeoutMs: 1_500
      }
    },
    arb: {
      enabled: true,
      minNetEdgeBps: 3,
      maxNotionalUsd: 100,
      maxConcurrentGroups: 5,
      enableNegRisk: true
    },
    taker: {
      enabled: true,
      baseOrderSize: 100,
      maxNotionalPerOrderUsd: 100,
      minNetEdgeBps: 1,
      maxLongPerToken: 500,
      maxShortPerToken: 500,
      maxSpread: 0.03,
      minDepth: 10,
      inventoryPenaltyBps: 0.5,
      close: {
        enabled: true,
        maxHoldSec: 900,
        closeMinEdgeToHoldBps: 0.5,
        edgeBelowTicks: 3,
        edgeBelowMs: 30_000,
        closeCooldownSec: 20
      }
    },
    makerEv: {
      quoteSize: 50,
      maxNotionalPerOrderUsd: 100,
      minExpectedEvBps: 0.5,
      maxInventoryAbs: 500,
      inventoryLambdaBps: 10,
      quoteHalfSpreadBps: 8,
      maxSpread: 0.03,
      minDepth: 10,
      priceToleranceBps: 8,
      rebateShareAssumption: 0.05,
      liquidityRewardBpsWhenScoring: 1,
      tradeFlowGate: {
        enabled: true,
        lookbackSec: 600,
        minTradeEvents: 2,
        mode: "PASSIVE_DECAY",
        staleCancelAgeSec: 45
      }
    },
    marketScope: "PROFILE_KNOWN_ONLY",
    executionSafeguards: {
      orderTtlMs: 5_000,
      maxBatchOrders: 15
    },
    regimeGating: {
      enabled: false,
      markovPath: "data/markov_regime.json",
      strategyPath: "data/strategy_regime_report.json",
      manifestPath: "data/regime_manifest.json",
      minCount: 20,
      minWavgBps: 0,
      minFillRate: 0,
      reloadMs: 60_000,
      failOpen: true,
      explicitHardBlocks: [],
      probabilistic: {
        kEdge: 50,
        zEdge: 1.64,
        zFill: 1.64,
        sigmaPriorBps: 25,
        winsorClipBps: 250,
        riskPenaltyBps: 0.5,
        costBufferBps: 1.0,
        hardBlockUpperBps: 0,
        hardBlockMinCount: 30,
        walletBlendK: 50,
        minScoreByKind: {
          TAKER_BUY: 1.5,
          TAKER_SELL: 0.5,
          MAKER_BID: 0,
          MAKER_ASK: 0
        },
        exploreMinByKind: {
          TAKER_BUY: 0.1,
          TAKER_SELL: 0.2,
          MAKER_BID: 0.25,
          MAKER_ASK: 0.25
        },
        exploreMaxByKind: {
          TAKER_BUY: 0.25,
          TAKER_SELL: 0.35,
          MAKER_BID: 0.4,
          MAKER_ASK: 0.4
        },
        explicitHardBlocks: []
      },
      liveness: {
        enabled: false,
        lookbackMs: 300_000,
        feedFreshMaxAgeSec: 60,
        minOrders5mMaker: 1,
        minOrders5mTaker: 1,
        relaxDurationMs: 60_000,
        relaxCooldownMs: 60_000,
        maxExploreOrdersPerWindow: 10,
        allowInLive: false
      },
      modulation: {
        enabled: true,
        sizeMultiplierMin: 0.1,
        sizeMultiplierMax: 1,
        inventoryScaleFloor: 0.5,
        inventoryScaleCap: 1.5,
        spreadMultiplier: 1,
        spreadTicksMin: 1,
        spreadTicksMax: 200
      }
    },
    regimeReport: {
      enabled: false,
      intervalMs: 300_000,
      hours: 24,
      horizonMs: 300_000,
      bins: 3,
      stepMs: 1000,
      sampleLimit: 200_000,
      features: ["spread", "depth", "obi", "vol", "micro"],
      outputDir: "data",
      minFillsToWrite: 20,
      winsorClipBps: 250
    }
  };

  const configPath = path.join(repoRoot, "configs", "worker.json");
  const raw = readJsonFile<Partial<WorkerFileConfig>>(configPath) ?? {};

  return {
    topN: toNumber(raw.topN, defaults.topN),
    activeTokenLimit: toNumber(raw.activeTokenLimit, defaults.activeTokenLimit),
    activeTokenWindowMinutes: toNumber(raw.activeTokenWindowMinutes, defaults.activeTokenWindowMinutes),
    universeRefreshSec: toNumber(raw.universeRefreshSec, defaults.universeRefreshSec),
    makerIntervalMs: toNumber(raw.makerIntervalMs, defaults.makerIntervalMs),
    takerIntervalMs: toNumber(raw.takerIntervalMs, defaults.takerIntervalMs),
    arbIntervalMs: toNumber(raw.arbIntervalMs, defaults.arbIntervalMs),
    makerMaxStalenessSec: toNumber(raw.makerMaxStalenessSec, defaults.makerMaxStalenessSec),
    takerMaxStalenessSec: toNumber(raw.takerMaxStalenessSec, defaults.takerMaxStalenessSec),
    featureLoopIntervalMs: toNumber(raw.featureLoopIntervalMs, defaults.featureLoopIntervalMs),
    fees: {
      slippageBps: toNumber(raw.fees?.slippageBps, defaults.fees.slippageBps),
      adverseSelectionBps: toNumber(raw.fees?.adverseSelectionBps, defaults.fees.adverseSelectionBps),
      queueLossBps: toNumber(raw.fees?.queueLossBps, defaults.fees.queueLossBps),
      rebateBps: toNumber(raw.fees?.rebateBps, defaults.fees.rebateBps)
    },
    belief: {
      minConfidence: toNumber(raw.belief?.minConfidence, defaults.belief.minConfidence),
      providerWeights: toNumberRecord(raw.belief?.providerWeights, defaults.belief.providerWeights),
      sportsbook: {
        enabled: toBool(raw.belief?.sportsbook?.enabled, defaults.belief.sportsbook.enabled),
        baseUrl: toStringOrNull(raw.belief?.sportsbook?.baseUrl, defaults.belief.sportsbook.baseUrl),
        apiKey: toStringOrNull(raw.belief?.sportsbook?.apiKey, defaults.belief.sportsbook.apiKey),
        timeoutMs: toNumber(raw.belief?.sportsbook?.timeoutMs, defaults.belief.sportsbook.timeoutMs)
      }
    },
    arb: {
      enabled: toBool(raw.arb?.enabled, defaults.arb.enabled),
      minNetEdgeBps: toNumber(raw.arb?.minNetEdgeBps, defaults.arb.minNetEdgeBps),
      maxNotionalUsd: toNumber(raw.arb?.maxNotionalUsd, defaults.arb.maxNotionalUsd),
      maxConcurrentGroups: toNumber(raw.arb?.maxConcurrentGroups, defaults.arb.maxConcurrentGroups),
      enableNegRisk: toBool(raw.arb?.enableNegRisk, defaults.arb.enableNegRisk)
    },
    taker: {
      enabled: toBool(raw.taker?.enabled, defaults.taker.enabled),
      baseOrderSize: toNumber(raw.taker?.baseOrderSize, defaults.taker.baseOrderSize),
      maxNotionalPerOrderUsd: toNumber(raw.taker?.maxNotionalPerOrderUsd, defaults.taker.maxNotionalPerOrderUsd),
      minNetEdgeBps: toNumber(raw.taker?.minNetEdgeBps, defaults.taker.minNetEdgeBps),
      maxLongPerToken: toNumber(raw.taker?.maxLongPerToken, defaults.taker.maxLongPerToken),
      maxShortPerToken: toNumber(raw.taker?.maxShortPerToken, defaults.taker.maxShortPerToken),
      maxSpread: toNumber(raw.taker?.maxSpread, defaults.taker.maxSpread),
      minDepth: toNumber(raw.taker?.minDepth, defaults.taker.minDepth),
      inventoryPenaltyBps: toNumber(raw.taker?.inventoryPenaltyBps, defaults.taker.inventoryPenaltyBps),
      close: {
        enabled: toBool(raw.taker?.close?.enabled, defaults.taker.close.enabled),
        maxHoldSec: toNumber(raw.taker?.close?.maxHoldSec, defaults.taker.close.maxHoldSec),
        closeMinEdgeToHoldBps: toNumber(
          raw.taker?.close?.closeMinEdgeToHoldBps,
          defaults.taker.close.closeMinEdgeToHoldBps
        ),
        edgeBelowTicks: Math.max(
          1,
          Math.floor(toNumber(raw.taker?.close?.edgeBelowTicks, defaults.taker.close.edgeBelowTicks))
        ),
        edgeBelowMs: Math.max(1_000, toNumber(raw.taker?.close?.edgeBelowMs, defaults.taker.close.edgeBelowMs)),
        closeCooldownSec: Math.max(
          0,
          toNumber(raw.taker?.close?.closeCooldownSec, defaults.taker.close.closeCooldownSec)
        )
      }
    },
    makerEv: {
      quoteSize: toNumber(raw.makerEv?.quoteSize, defaults.makerEv.quoteSize),
      maxNotionalPerOrderUsd: toNumber(raw.makerEv?.maxNotionalPerOrderUsd, defaults.makerEv.maxNotionalPerOrderUsd),
      minExpectedEvBps: toNumber(raw.makerEv?.minExpectedEvBps, defaults.makerEv.minExpectedEvBps),
      maxInventoryAbs: toNumber(raw.makerEv?.maxInventoryAbs, defaults.makerEv.maxInventoryAbs),
      inventoryLambdaBps: toNumber(raw.makerEv?.inventoryLambdaBps, defaults.makerEv.inventoryLambdaBps),
      quoteHalfSpreadBps: toNumber(raw.makerEv?.quoteHalfSpreadBps, defaults.makerEv.quoteHalfSpreadBps),
      maxSpread: toNumber(raw.makerEv?.maxSpread, defaults.makerEv.maxSpread),
      minDepth: toNumber(raw.makerEv?.minDepth, defaults.makerEv.minDepth),
      priceToleranceBps: toNumber(raw.makerEv?.priceToleranceBps, defaults.makerEv.priceToleranceBps),
      rebateShareAssumption: toNumber(
        raw.makerEv?.rebateShareAssumption,
        defaults.makerEv.rebateShareAssumption
      ),
      liquidityRewardBpsWhenScoring: toNumber(
        raw.makerEv?.liquidityRewardBpsWhenScoring,
        defaults.makerEv.liquidityRewardBpsWhenScoring
      ),
      tradeFlowGate: {
        enabled: toBool(raw.makerEv?.tradeFlowGate?.enabled, defaults.makerEv.tradeFlowGate.enabled),
        lookbackSec: Math.max(
          10,
          toNumber(raw.makerEv?.tradeFlowGate?.lookbackSec, defaults.makerEv.tradeFlowGate.lookbackSec)
        ),
        minTradeEvents: Math.max(
          1,
          Math.floor(
            toNumber(
              raw.makerEv?.tradeFlowGate?.minTradeEvents,
              defaults.makerEv.tradeFlowGate.minTradeEvents
            )
          )
        ),
        mode: toStringEnum(
          raw.makerEv?.tradeFlowGate?.mode,
          ["PASSIVE_DECAY", "IMMEDIATE_CANCEL"] as const,
          defaults.makerEv.tradeFlowGate.mode
        ),
        staleCancelAgeSec: Math.max(
          1,
          toNumber(
            raw.makerEv?.tradeFlowGate?.staleCancelAgeSec,
            defaults.makerEv.tradeFlowGate.staleCancelAgeSec
          )
        )
      }
    },
    marketScope: toMarketScope(raw.marketScope, defaults.marketScope),
    executionSafeguards: {
      orderTtlMs: toNumber(raw.executionSafeguards?.orderTtlMs, defaults.executionSafeguards.orderTtlMs),
      maxBatchOrders: toNumber(raw.executionSafeguards?.maxBatchOrders, defaults.executionSafeguards.maxBatchOrders)
    },
    regimeGating: {
      enabled: toBool(raw.regimeGating?.enabled, defaults.regimeGating.enabled),
      markovPath: toStringOrNull(raw.regimeGating?.markovPath, defaults.regimeGating.markovPath) ?? defaults.regimeGating.markovPath,
      strategyPath: toStringOrNull(raw.regimeGating?.strategyPath, defaults.regimeGating.strategyPath) ?? defaults.regimeGating.strategyPath,
      manifestPath:
        toStringOrNull(
          raw.regimeGating?.manifestPath,
          defaults.regimeGating.manifestPath ?? null
        ) ?? undefined,
      minCount: toNumber(raw.regimeGating?.minCount, defaults.regimeGating.minCount),
      minWavgBps: toNumber(raw.regimeGating?.minWavgBps, defaults.regimeGating.minWavgBps),
      minFillRate: toNumber(raw.regimeGating?.minFillRate, defaults.regimeGating.minFillRate),
      reloadMs: toNumber(raw.regimeGating?.reloadMs, defaults.regimeGating.reloadMs),
      failOpen: toBool(raw.regimeGating?.failOpen, defaults.regimeGating.failOpen),
      explicitHardBlocks: toStringArray(raw.regimeGating?.explicitHardBlocks, defaults.regimeGating.explicitHardBlocks ?? []),
      probabilistic: {
        kEdge: toNumber(raw.regimeGating?.probabilistic?.kEdge, defaults.regimeGating.probabilistic?.kEdge ?? 50),
        zEdge: toNumber(raw.regimeGating?.probabilistic?.zEdge, defaults.regimeGating.probabilistic?.zEdge ?? 1.64),
        zFill: toNumber(raw.regimeGating?.probabilistic?.zFill, defaults.regimeGating.probabilistic?.zFill ?? 1.64),
        sigmaPriorBps: toNumber(
          raw.regimeGating?.probabilistic?.sigmaPriorBps,
          defaults.regimeGating.probabilistic?.sigmaPriorBps ?? 25
        ),
        winsorClipBps: toNumber(
          raw.regimeGating?.probabilistic?.winsorClipBps,
          defaults.regimeGating.probabilistic?.winsorClipBps ?? 250
        ),
        riskPenaltyBps: toNumber(
          raw.regimeGating?.probabilistic?.riskPenaltyBps,
          defaults.regimeGating.probabilistic?.riskPenaltyBps ?? 0.5
        ),
        costBufferBps: toNumber(
          raw.regimeGating?.probabilistic?.costBufferBps,
          defaults.regimeGating.probabilistic?.costBufferBps ?? 1
        ),
        hardBlockUpperBps: toNumber(
          raw.regimeGating?.probabilistic?.hardBlockUpperBps,
          defaults.regimeGating.probabilistic?.hardBlockUpperBps ?? 0
        ),
        hardBlockMinCount: toNumber(
          raw.regimeGating?.probabilistic?.hardBlockMinCount,
          defaults.regimeGating.probabilistic?.hardBlockMinCount ?? 30
        ),
        walletBlendK: toNumber(
          raw.regimeGating?.probabilistic?.walletBlendK,
          defaults.regimeGating.probabilistic?.walletBlendK ?? 50
        ),
        minScoreByKind: toNumberRecord(
          raw.regimeGating?.probabilistic?.minScoreByKind,
          defaults.regimeGating.probabilistic?.minScoreByKind ?? {}
        ),
        exploreMinByKind: toNumberRecord(
          raw.regimeGating?.probabilistic?.exploreMinByKind,
          defaults.regimeGating.probabilistic?.exploreMinByKind ?? {}
        ),
        exploreMaxByKind: toNumberRecord(
          raw.regimeGating?.probabilistic?.exploreMaxByKind,
          defaults.regimeGating.probabilistic?.exploreMaxByKind ?? {}
        ),
        explicitHardBlocks: toStringArray(
          raw.regimeGating?.probabilistic?.explicitHardBlocks,
          defaults.regimeGating.probabilistic?.explicitHardBlocks ?? []
        )
      },
      liveness: {
        enabled: toBool(raw.regimeGating?.liveness?.enabled, defaults.regimeGating.liveness?.enabled ?? false),
        lookbackMs: toNumber(raw.regimeGating?.liveness?.lookbackMs, defaults.regimeGating.liveness?.lookbackMs ?? 300_000),
        feedFreshMaxAgeSec: toNumber(
          raw.regimeGating?.liveness?.feedFreshMaxAgeSec,
          defaults.regimeGating.liveness?.feedFreshMaxAgeSec ?? 60
        ),
        minOrders5mMaker: toNumber(
          raw.regimeGating?.liveness?.minOrders5mMaker,
          defaults.regimeGating.liveness?.minOrders5mMaker ?? 1
        ),
        minOrders5mTaker: toNumber(
          raw.regimeGating?.liveness?.minOrders5mTaker,
          defaults.regimeGating.liveness?.minOrders5mTaker ?? 1
        ),
        relaxDurationMs: toNumber(
          raw.regimeGating?.liveness?.relaxDurationMs,
          defaults.regimeGating.liveness?.relaxDurationMs ?? 60_000
        ),
        relaxCooldownMs: toNumber(
          raw.regimeGating?.liveness?.relaxCooldownMs,
          defaults.regimeGating.liveness?.relaxCooldownMs ?? 60_000
        ),
        maxExploreOrdersPerWindow: toNumber(
          raw.regimeGating?.liveness?.maxExploreOrdersPerWindow,
          defaults.regimeGating.liveness?.maxExploreOrdersPerWindow ?? 10
        ),
        allowInLive: toBool(
          raw.regimeGating?.liveness?.allowInLive,
          defaults.regimeGating.liveness?.allowInLive ?? false
        )
      },
      modulation: {
        enabled: toBool(raw.regimeGating?.modulation?.enabled, defaults.regimeGating.modulation.enabled),
        sizeMultiplierMin: toNumber(
          raw.regimeGating?.modulation?.sizeMultiplierMin,
          defaults.regimeGating.modulation.sizeMultiplierMin
        ),
        sizeMultiplierMax: toNumber(
          raw.regimeGating?.modulation?.sizeMultiplierMax,
          defaults.regimeGating.modulation.sizeMultiplierMax
        ),
        inventoryScaleFloor: toNumber(
          raw.regimeGating?.modulation?.inventoryScaleFloor,
          defaults.regimeGating.modulation.inventoryScaleFloor
        ),
        inventoryScaleCap: toNumber(
          raw.regimeGating?.modulation?.inventoryScaleCap,
          defaults.regimeGating.modulation.inventoryScaleCap
        ),
        spreadMultiplier: toNumber(
          raw.regimeGating?.modulation?.spreadMultiplier,
          defaults.regimeGating.modulation.spreadMultiplier
        ),
        spreadTicksMin: toNumber(
          raw.regimeGating?.modulation?.spreadTicksMin,
          defaults.regimeGating.modulation.spreadTicksMin
        ),
        spreadTicksMax: toNumber(
          raw.regimeGating?.modulation?.spreadTicksMax,
          defaults.regimeGating.modulation.spreadTicksMax
        )
      }
    },
    regimeReport: {
      enabled: toBool(raw.regimeReport?.enabled, defaults.regimeReport.enabled),
      intervalMs: toNumber(raw.regimeReport?.intervalMs, defaults.regimeReport.intervalMs),
      hours: toNumber(raw.regimeReport?.hours, defaults.regimeReport.hours),
      horizonMs: toNumber(raw.regimeReport?.horizonMs, defaults.regimeReport.horizonMs),
      bins: toNumber(raw.regimeReport?.bins, defaults.regimeReport.bins),
      stepMs: toNumber(raw.regimeReport?.stepMs, defaults.regimeReport.stepMs),
      sampleLimit: toNumber(raw.regimeReport?.sampleLimit, defaults.regimeReport.sampleLimit),
      features: toStringArray(raw.regimeReport?.features, defaults.regimeReport.features),
      outputDir: toStringOrNull(raw.regimeReport?.outputDir, defaults.regimeReport.outputDir) ?? defaults.regimeReport.outputDir,
      minFillsToWrite: toNumber(raw.regimeReport?.minFillsToWrite, defaults.regimeReport.minFillsToWrite),
      winsorClipBps: toNumber(raw.regimeReport?.winsorClipBps, defaults.regimeReport.winsorClipBps)
    }
  };
}

function loadVerificationConfig(repoRoot: string): VerificationConfig {
  const defaults: VerificationConfig = {
    startup: {
      enabled: true,
      quick: true,
      hardFail: false
    },
    background: { enabled: true, intervalMinutes: 30, hardFail: false },
    marketData: {
      windowHours: 6,
      cleanupNullFeatures: true,
      cleanupBatchSize: 250_000,
      cleanupMaxBatches: 12
    },
    realism: {
      enforcement: "warn",
      makerRealFillRateMin: 0.02,
      makerRealFillsPerDayMin: 20,
      takerCloseRatioMin: 0.15,
      takerOneSidedMax: 0.85,
      requireRuntimeLiveness: true
    }
  };

  const configPath = path.join(repoRoot, "configs", "verification.json");
  const raw = readJsonFile<Partial<VerificationConfig>>(configPath) ?? {};

  return {
    startup: {
      enabled: toBool(raw.startup?.enabled, defaults.startup.enabled),
      quick: toBool(raw.startup?.quick, defaults.startup.quick),
      hardFail: toBool(raw.startup?.hardFail, defaults.startup.hardFail)
    },
    background: {
      enabled: toBool(raw.background?.enabled, defaults.background.enabled),
      intervalMinutes: toNumber(raw.background?.intervalMinutes, defaults.background.intervalMinutes),
      hardFail: toBool(raw.background?.hardFail, defaults.background.hardFail)
    },
    marketData: {
      windowHours: toNumber(raw.marketData?.windowHours, defaults.marketData.windowHours),
      cleanupNullFeatures: toBool(raw.marketData?.cleanupNullFeatures, defaults.marketData.cleanupNullFeatures),
      cleanupBatchSize: toNumber(raw.marketData?.cleanupBatchSize, defaults.marketData.cleanupBatchSize),
      cleanupMaxBatches: toNumber(raw.marketData?.cleanupMaxBatches, defaults.marketData.cleanupMaxBatches)
    },
    realism: {
      enforcement: toStringEnum(
        raw.realism?.enforcement,
        ["warn", "hard"] as const,
        defaults.realism.enforcement
      ),
      makerRealFillRateMin: Math.max(
        0,
        toNumber(raw.realism?.makerRealFillRateMin, defaults.realism.makerRealFillRateMin)
      ),
      makerRealFillsPerDayMin: Math.max(
        0,
        toNumber(raw.realism?.makerRealFillsPerDayMin, defaults.realism.makerRealFillsPerDayMin)
      ),
      takerCloseRatioMin: Math.max(
        0,
        toNumber(raw.realism?.takerCloseRatioMin, defaults.realism.takerCloseRatioMin)
      ),
      takerOneSidedMax: Math.max(
        0,
        Math.min(1, toNumber(raw.realism?.takerOneSidedMax, defaults.realism.takerOneSidedMax))
      ),
      requireRuntimeLiveness: toBool(
        raw.realism?.requireRuntimeLiveness,
        defaults.realism.requireRuntimeLiveness
      )
    }
  };
}

export function getRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function resolveRepoPath(repoRoot: string, value: string | undefined, fallback: string): string {
  const configured = value?.trim();
  if (!configured) return path.join(repoRoot, fallback);
  return path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
}

function workerPort(): number {
  const raw = process.env.WORKER_PORT;
  if (raw == null || raw === "") return 3001;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
    throw new Error(`Invalid WORKER_PORT: ${raw}`);
  }
  return n;
}

export function loadConfig(): WorkerConfig {
  const repoRoot = getRepoRoot();
  const workerFileConfig = loadWorkerFileConfig(repoRoot);
  const executionMode: ExecutionMode = "PAPER";
  const liveExecutionEnabled = false;
  const clobEventsSampleRateRaw = Number(process.env.CLOB_EVENTS_SAMPLE_RATE ?? 0);
  const clobEventsSampleRate = Number.isFinite(clobEventsSampleRateRaw)
    ? Math.max(0, Math.min(1, clobEventsSampleRateRaw))
    : 0;

  return {
    dbPath: resolveRepoPath(repoRoot, process.env.DB_PATH, "data/dev.db"),
    eventsPath: resolveRepoPath(repoRoot, process.env.EVENTS_PATH, "data/events.jsonl"),
    eventsLogEnabled: true,
    port: workerPort(),
    clobWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    clobEventsSampleRate,
    universe: {
      topN: workerFileConfig.topN,
      activeTokenLimit: workerFileConfig.activeTokenLimit,
      activeTokenWindowMinutes: workerFileConfig.activeTokenWindowMinutes,
      refreshSec: workerFileConfig.universeRefreshSec
    },
    feature: {
      loopIntervalMs: workerFileConfig.featureLoopIntervalMs,
      topKLevels: 10,
      makerMaxStalenessSec: workerFileConfig.makerMaxStalenessSec,
      takerMaxStalenessSec: workerFileConfig.takerMaxStalenessSec
    },
    fees: workerFileConfig.fees,
    marketScope: workerFileConfig.marketScope,
    belief: workerFileConfig.belief,
    arb: {
      ...workerFileConfig.arb,
      intervalMs: workerFileConfig.arbIntervalMs
    },
    taker: {
      ...workerFileConfig.taker,
      intervalMs: workerFileConfig.takerIntervalMs
    },
    makerEv: {
      ...workerFileConfig.makerEv,
      intervalMs: workerFileConfig.makerIntervalMs
    },
    executionSafeguards: workerFileConfig.executionSafeguards,
    liveExecution: {
      enabled: liveExecutionEnabled,
      host: process.env.POLY_HOST ?? "https://clob.polymarket.com",
      chainId: Number(process.env.POLY_CHAIN_ID ?? 137),
      privateKey: process.env.POLY_PRIVATE_KEY ?? null,
      apiKey: process.env.POLY_API_KEY ?? null,
      apiSecret: process.env.POLY_API_SECRET ?? null,
      apiPassphrase: process.env.POLY_API_PASSPHRASE ?? null,
      signatureType: Number(process.env.POLY_SIGNATURE_TYPE ?? 0),
      funder: process.env.POLY_FUNDER ?? null,
      userWsUrl: process.env.POLY_USER_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/user",
      userWsEnabled: process.env.POLY_USER_WS_ENABLED === "1"
    },
    executionPolicy: {
      mode: executionMode
    },
    retention: DEFAULT_RETENTION_CONFIG,
    retentionIntervalHours: 1,
    verification: loadVerificationConfig(repoRoot),
    regimeGating: workerFileConfig.regimeGating,
    regimeReport: workerFileConfig.regimeReport
  };
}
