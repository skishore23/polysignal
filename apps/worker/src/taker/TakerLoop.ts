import type { Logger } from "../logger";
import { TaskScheduler } from "../utils/TaskScheduler";
import type { LiveExecutionGateway } from "../execution/clobExecution";
import {
  buildShadowPositionLedger,
  shadowPositionKey,
  type ShadowFillInput,
  type ShadowPositionState
} from "@polysignal/data";
import { BeliefEngine, type BeliefContext } from "../belief";
import { applyCostToEdge, computeCostBreakdown } from "../trading/CostModel";
import { validateEdgeCostSanity } from "../trading/EdgeSanity";
import {
  classifyMarketProfile,
  isShadowOnlyProfile,
  type MarketScope
} from "../trading/MarketProfile";
import { decideMarketProfileScope } from "../trading/DecisionEngine";
import {
  compileWalletMarketGate,
  evaluateWalletMarketGate,
  normalizeWalletTakerSide,
  type CompiledWalletMarketGate
} from "../trading/WalletMarketGate";
import type { RegimeGate, RegimeDecision } from "../regime/RegimeGate";
import type {
  RegimeModulationConfig,
  TakerAdaptiveSideGateConfig,
  TakerCloseConfig,
  TakerToxicityConfig
} from "../config";

type TakerLoopConfig = {
  enabled?: boolean;
  intervalMs: number;
  baseOrderSize: number;
  maxNotionalPerOrderUsd: number;
  minNetEdgeBps: number;
  maxLongPerToken: number;
  maxShortPerToken: number;
  maxSpread: number;
  minDepth: number;
  slippageBps: number;
  adverseSelectionBps: number;
  queueLossBps: number;
  inventoryPenaltyBps: number;
  orderTtlMs: number;
  marketScope?: MarketScope;
  executionMode: "PAPER" | "FULL";
  regimeModulation?: RegimeModulationConfig;
  close?: TakerCloseConfig;
  toxicity?: TakerToxicityConfig;
  adaptiveSideGate?: TakerAdaptiveSideGateConfig;
  maxFeatureStalenessSec?: number;
};

type TakerDeps = {
  sqlite: any;
  logger: Logger;
  belief: BeliefEngine;
  execution?: LiveExecutionGateway;
  regimeGate?: RegimeGate;
};

type CandidateRow = {
  featureTs: number | null;
  tokenId: string;
  marketId: string | null;
  marketQuestion: string | null;
  marketSlug: string | null;
  eventTitle: string | null;
  marketVolumeUsd: number | null;
  marketLiquidityUsd: number | null;
  marketActive: number | null;
  mid: number | null;
  spread: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  bidDepthTop: number | null;
  askDepthTop: number | null;
  obi: number | null;
  vol30m: number | null;
  micropriceMinusMid: number | null;
  feeRateBps: number | null;
  takerBaseFee: number | null;
};

type WalletRow = {
  walletId: number;
  sizeMultiplier: number;
  takerSide: string | null;
  marketFilterJson: string | null;
};

type WalletRuntime = WalletRow & {
  takerSideNormalized: "BUY" | "SELL" | "BOTH" | "NONE";
  marketGate: CompiledWalletMarketGate;
};

type CloseHysteresisState = {
  belowTicks: number;
  belowSinceTs: number | null;
  lastCloseAttemptTs: number | null;
};

type TakerToxicityDecision = {
  blocked: boolean;
  reasonCode: string;
  detail: string | null;
};

type TakerSideMarkoutStats = {
  fills: number;
  avgMarkoutBps: number | null;
};

const toDecisionGroupId = (): string => `taker:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

const toKind = (side: "BUY" | "SELL"): "TAKER_BUY" | "TAKER_SELL" =>
  side === "BUY" ? "TAKER_BUY" : "TAKER_SELL";

const finiteOr = (value: number | null | undefined, fallback: number): number =>
  Number.isFinite(value) ? (value as number) : fallback;

const walletAllowsTakerSide = (
  takerSide: "BUY" | "SELL" | "BOTH" | "NONE",
  side: "BUY" | "SELL"
): boolean => {
  if (takerSide === "NONE") return false;
  if (takerSide === "BOTH") return true;
  return takerSide === side;
};

export class TakerLoop {
  private readonly config: TakerLoopConfig;
  private readonly deps: TakerDeps;
  private readonly scheduler: TaskScheduler;

  private readonly selectCandidatesStmt: any;
  private readonly selectWalletsStmt: any;
  private readonly selectPositionFillsStmt: any;
  private readonly selectKillSwitchStmt: any;
  private readonly selectRecentTradesStmt: any | null;
  private readonly selectSideMarkoutStatsStmt: any | null;
  private readonly insertShadowOrderStmt: any;
  private readonly insertDecisionLogStmt: any;
  private readonly insertSubmitOrderAndDecisionTx: any;
  private readonly closeHysteresisByKey = new Map<string, CloseHysteresisState>();
  private readonly toxicityBlockUntilByToken = new Map<string, number>();
  private readonly adaptiveSideBlockUntilBySide = new Map<"BUY" | "SELL", number>();
  private adaptiveSideStats: Record<"BUY" | "SELL", TakerSideMarkoutStats> = {
    BUY: { fills: 0, avgMarkoutBps: null },
    SELL: { fills: 0, avgMarkoutBps: null }
  };

  constructor(config: TakerLoopConfig, deps: TakerDeps) {
    this.config = {
      ...config,
      enabled: config.enabled ?? true,
      marketScope: config.marketScope ?? "PROFILE_KNOWN_ONLY",
      regimeModulation: config.regimeModulation ?? {
        enabled: true,
        sizeMultiplierMin: 0.1,
        sizeMultiplierMax: 1,
        inventoryScaleFloor: 0.5,
        inventoryScaleCap: 1.5,
        spreadMultiplier: 1,
        spreadTicksMin: 1,
        spreadTicksMax: 200
      },
      close: config.close ?? {
        enabled: true,
        maxHoldSec: 900,
        closeMinEdgeToHoldBps: 0.5,
        edgeBelowTicks: 3,
        edgeBelowMs: 30_000,
        closeCooldownSec: 20
      },
      toxicity: config.toxicity ?? {
        enabled: true,
        lookbackSec: 30,
        minTradeEvents: 12,
        shockBps: 250,
        dominantSideRatio: 0.95,
        micropriceShockBps: 100,
        cooldownMs: 5_000
      },
      adaptiveSideGate: config.adaptiveSideGate ?? {
        enabled: true,
        lookbackSec: 1_800,
        horizonMs: 300_000,
        minFills: 200,
        minAvgMarkoutBps: 0,
        blockMs: 600_000
      },
      maxFeatureStalenessSec: finiteOr(config.maxFeatureStalenessSec, 60)
    };
    this.deps = deps;

    this.selectCandidatesStmt = deps.sqlite.prepare(
      `SELECT
         lf.ts as featureTs,
         lf.token_id as tokenId,
         lf.market_id as marketId,
         m.question as marketQuestion,
         m.slug as marketSlug,
         e.title as eventTitle,
         m.volume as marketVolumeUsd,
         m.liquidity as marketLiquidityUsd,
         m.active as marketActive,
         lf.mid as mid,
         lf.spread as spread,
         lf.best_bid as bestBid,
         lf.best_ask as bestAsk,
         lf.bid_depth_top as bidDepthTop,
         lf.ask_depth_top as askDepthTop,
         lf.obi as obi,
         lf.vol30m as vol30m,
         lf.microprice_minus_mid as micropriceMinusMid,
         t.fee_rate_bps as feeRateBps,
         m.taker_base_fee as takerBaseFee
       FROM latest_features lf
       LEFT JOIN tokens t ON t.id = lf.token_id
       LEFT JOIN markets m ON m.id = lf.market_id
       LEFT JOIN market_events e ON e.id = m.event_id
       WHERE m.active = 1
         AND lf.mid IS NOT NULL
         AND lf.best_bid IS NOT NULL
         AND lf.best_ask IS NOT NULL`
    );

    this.selectWalletsStmt = deps.sqlite.prepare(
      `SELECT
         id as walletId,
         size_multiplier as sizeMultiplier,
         taker_side as takerSide,
         market_filter_json as marketFilterJson
       FROM wallets
       WHERE auto_trade_enabled = 1
         AND COALESCE(maker_enabled, 0) = 0`
    );

    this.selectPositionFillsStmt = deps.sqlite.prepare(
      `SELECT
         o.wallet_id as walletId,
         o.token_id as tokenId,
         o.side as side,
         f.price as price,
         f.size as size,
         f.ts as ts
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE o.kind IN ('TAKER_BUY', 'TAKER_SELL')
         AND f.method != 'synthetic_fill'
       ORDER BY f.ts ASC`
    );

    this.selectKillSwitchStmt = deps.sqlite.prepare(
      `SELECT value
       FROM settings
       WHERE key IN ('kill_switch', 'trading_kill_switch')
       ORDER BY CASE key WHEN 'kill_switch' THEN 0 ELSE 1 END
       LIMIT 1`
    );
    try {
      this.selectRecentTradesStmt = deps.sqlite.prepare(
        `SELECT recv_ts_ms as recvTsMs, payload_json as payloadJson
         FROM clob_events
         WHERE msg_type = 'trade'
           AND token_id = ?
           AND recv_ts_ms >= ?
         ORDER BY recv_ts_ms ASC
         LIMIT 256`
      );
    } catch {
      this.selectRecentTradesStmt = null;
    }
    try {
      this.selectSideMarkoutStatsStmt = deps.sqlite.prepare(
        `SELECT
           o.kind as kind,
           COUNT(*) as fills,
           AVG(m.markout_bps) as avgMarkoutBps
         FROM shadow_markouts m
         JOIN shadow_fills f ON f.id = m.fill_id
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE m.horizon_ms = ?
           AND f.method != 'synthetic_fill'
           AND f.ts >= ?
           AND o.kind IN ('TAKER_BUY', 'TAKER_SELL')
         GROUP BY o.kind`
      );
    } catch {
      this.selectSideMarkoutStatsStmt = null;
    }

    this.insertShadowOrderStmt = deps.sqlite.prepare(
      `INSERT INTO shadow_orders
       (ts, wallet_id, token_id, market_id, side, kind, price, size, expected_cancel_ts, execution_mode,
        source, client_order_id, external_order_id, status, filled_size, filled_price, last_update_ts,
        strategy_lane, decision_group_id, pred_source,
        pred_edge_bps, spread_bps, fees_bps, expected_slippage_bps, expected_adverse_bps,
        expected_queue_bps, cost_bps, net_edge_bps, decision, decision_reason,
        mid_px, spread_px, bid_px, ask_px, bid_depth, ask_depth, prior_p_hat)
       VALUES (@ts, @walletId, @tokenId, @marketId, @side, @kind, @price, @size, @expectedCancelTs, @executionMode,
               @source, @clientOrderId, @externalOrderId, @status, @filledSize, @filledPrice, @lastUpdateTs,
               @strategyLane, @decisionGroupId, @predSource,
               @predEdgeBps, @spreadBps, @feesBps, @expectedSlippageBps, @expectedAdverseBps,
               @expectedQueueBps, @costBps, @netEdgeBps, @decision, @decisionReason,
               @midPx, @spreadPx, @bidPx, @askPx, @bidDepth, @askDepth, @priorPHat)`
    );

    this.insertDecisionLogStmt = deps.sqlite.prepare(
      `INSERT INTO decision_log
       (ts, token_id, wallet_id, kind, strategy_lane, decision_group_id, decision, decision_reason, pred_edge_bps, cost_bps, net_edge_bps,
        spread_bps, fees_bps, expected_slippage_bps, mid_px, spread_px, delta_hat, size, bid_px, ask_px, bid_depth, ask_depth)
       VALUES (@ts, @tokenId, @walletId, @kind, @strategyLane, @decisionGroupId, @decision, @decisionReason, @predEdgeBps, @costBps, @netEdgeBps,
               @spreadBps, @feesBps, @expectedSlippageBps, @midPx, @spreadPx, @deltaHat, @size, @bidPx, @askPx, @bidDepth, @askDepth)`
    );
    this.insertSubmitOrderAndDecisionTx = deps.sqlite.transaction((orderRow: Record<string, unknown>, decisionRow: Record<string, unknown>) => {
      this.insertShadowOrderStmt.run(orderRow);
      this.insertDecisionLogStmt.run(decisionRow);
    });

    this.scheduler = new TaskScheduler(() => this.tick(), {
      name: "TakerLoop",
      intervalMs: this.config.intervalMs,
      logger: deps.logger
    });
  }

  public start(): void {
    if (!this.config.enabled) {
      this.deps.logger.info("TakerLoop disabled via config");
      return;
    }
    this.deps.logger.info(
      {
        marketScope: this.config.marketScope,
        close: this.config.close,
        adaptiveSideGate: this.config.adaptiveSideGate
      },
      "Starting TakerLoop (p_hat + dynamic fee cost)"
    );
    this.scheduler.start();
  }

  public stop(): void {
    this.scheduler.stop();
  }

  private refreshAdaptiveSideGate(ts: number): void {
    const cfg = this.config.adaptiveSideGate;
    if (!cfg?.enabled || !this.selectSideMarkoutStatsStmt) return;
    const sinceTs = ts - Math.max(1, cfg.lookbackSec) * 1000;
    const rows = this.selectSideMarkoutStatsStmt.all(cfg.horizonMs, sinceTs) as Array<{
      kind: "TAKER_BUY" | "TAKER_SELL";
      fills: number;
      avgMarkoutBps: number | null;
    }>;

    const buyStats: TakerSideMarkoutStats = { fills: 0, avgMarkoutBps: null };
    const sellStats: TakerSideMarkoutStats = { fills: 0, avgMarkoutBps: null };
    for (const row of rows) {
      const stats =
        row.kind === "TAKER_BUY"
          ? buyStats
          : row.kind === "TAKER_SELL"
            ? sellStats
            : null;
      if (!stats) continue;
      stats.fills = finiteOr(row.fills, 0);
      stats.avgMarkoutBps = Number.isFinite(row.avgMarkoutBps) ? (row.avgMarkoutBps as number) : null;
    }
    this.adaptiveSideStats = { BUY: buyStats, SELL: sellStats };

    for (const side of ["BUY", "SELL"] as const) {
      const stats = this.adaptiveSideStats[side];
      if (stats.fills < cfg.minFills) continue;
      if (stats.avgMarkoutBps == null || stats.avgMarkoutBps >= cfg.minAvgMarkoutBps) continue;
      const currentUntil = this.adaptiveSideBlockUntilBySide.get(side) ?? 0;
      const nextUntil = Math.max(currentUntil, ts + Math.max(1_000, cfg.blockMs));
      if (nextUntil > currentUntil) {
        this.adaptiveSideBlockUntilBySide.set(side, nextUntil);
        this.deps.logger.warn(
          {
            side,
            fills: stats.fills,
            avgMarkoutBps: Number(stats.avgMarkoutBps.toFixed(4)),
            minAvgMarkoutBps: cfg.minAvgMarkoutBps,
            blockMs: cfg.blockMs
          },
          "Adaptive side gate blocking taker side"
        );
      }
    }
  }

  private isAdaptiveSideBlocked(side: "BUY" | "SELL", ts: number): boolean {
    const cfg = this.config.adaptiveSideGate;
    if (!cfg?.enabled) return false;
    const until = this.adaptiveSideBlockUntilBySide.get(side) ?? 0;
    return ts < until;
  }

  private async tick(): Promise<void> {
    if (!this.config.enabled) return;
    if (this.isKillSwitchActive()) return;
    const ts = Date.now();
    this.refreshAdaptiveSideGate(ts);
    const candidates = this.selectCandidatesStmt.all() as CandidateRow[];
    const wallets = this.selectWalletsStmt.all() as WalletRow[];
    if (!candidates.length || !wallets.length) return;

    const walletRuntimes: WalletRuntime[] = wallets.map((wallet) => ({
      ...wallet,
      takerSideNormalized: normalizeWalletTakerSide(wallet.takerSide),
      marketGate: compileWalletMarketGate({
        marketFilterJson: wallet.marketFilterJson
      })
    }));

    const positionStates = this.loadPositionStates();
    const positions = new Map<string, number>();
    for (const [key, state] of positionStates) {
      positions.set(key, state.position);
    }

    const candidateByToken = new Map<string, CandidateRow>();
    for (const candidate of candidates) {
      candidateByToken.set(candidate.tokenId, candidate);
    }

    const closeAttempted = await this.runRiskClosePass({
      ts,
      walletRuntimes,
      candidateByToken,
      positionStates,
      positions
    });

    for (const candidate of candidates) {
      if (!this.isFeatureFresh(candidate, ts)) continue;
      const mid = finiteOr(candidate.mid, NaN);
      const bid = finiteOr(candidate.bestBid, NaN);
      const ask = finiteOr(candidate.bestAsk, NaN);
      const spread = finiteOr(candidate.spread, ask - bid);
      const bidDepth = finiteOr(candidate.bidDepthTop, 0);
      const askDepth = finiteOr(candidate.askDepthTop, 0);
      if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) continue;
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) continue;
      if (!Number.isFinite(spread) || spread < 0 || spread > this.config.maxSpread) continue;
      if (Math.min(bidDepth, askDepth) < this.config.minDepth) continue;

      const marketProfile = classifyMarketProfile({
        question: candidate.marketQuestion,
        slug: candidate.marketSlug,
        eventTitle: candidate.eventTitle,
        feeRateBps: candidate.feeRateBps,
        takerBaseFee: candidate.takerBaseFee
      });
      const scopeDecision = decideMarketProfileScope(marketProfile, this.config.marketScope ?? "PROFILE_KNOWN_ONLY");
      if (!scopeDecision.ok || marketProfile === "UNKNOWN") continue;

      const beliefContext: BeliefContext = {
        tokenId: candidate.tokenId,
        marketId: candidate.marketId,
        midPx: mid,
        spreadPx: spread,
        bidDepthTop: candidate.bidDepthTop,
        askDepthTop: candidate.askDepthTop,
        obi: candidate.obi,
        vol30m: candidate.vol30m,
        ts
      };
      const prior = await this.deps.belief.estimate(beliefContext);
      if (!prior) continue;
      const pHat = prior.probability;

      const predEdgeBuyBps = ((pHat - ask) / mid) * 10_000;
      const buySizeEstimate = Math.max(1, Math.min(this.config.baseOrderSize, this.config.maxNotionalPerOrderUsd / ask));
      const costBuy = computeCostBreakdown({
        role: "TAKER",
        side: "BUY",
        midPx: mid,
        quotePx: ask,
        spreadPx: spread,
        sizeShares: buySizeEstimate,
        marketProfile,
        feeRateBps: finiteOr(candidate.feeRateBps, 0),
        slippageBps: this.config.slippageBps,
        adverseSelectionBps: this.config.adverseSelectionBps,
        queueLossBps: this.config.queueLossBps,
        rebateBps: 0,
        inventoryPenaltyBps: this.config.inventoryPenaltyBps
      });
      const netBuyBps = applyCostToEdge(predEdgeBuyBps, costBuy);

      const predEdgeSellBps = ((bid - pHat) / mid) * 10_000;
      const sellSizeEstimate = Math.max(1, Math.min(this.config.baseOrderSize, this.config.maxNotionalPerOrderUsd / bid));
      const costSell = computeCostBreakdown({
        role: "TAKER",
        side: "SELL",
        midPx: mid,
        quotePx: bid,
        spreadPx: spread,
        sizeShares: sellSizeEstimate,
        marketProfile,
        feeRateBps: finiteOr(candidate.feeRateBps, 0),
        slippageBps: this.config.slippageBps,
        adverseSelectionBps: this.config.adverseSelectionBps,
        queueLossBps: this.config.queueLossBps,
        rebateBps: 0,
        inventoryPenaltyBps: this.config.inventoryPenaltyBps
      });
      const netSellBps = applyCostToEdge(predEdgeSellBps, costSell);
      const buyEdgeSanity = validateEdgeCostSanity({
        predEdgeBps: predEdgeBuyBps,
        netEdgeBps: netBuyBps,
        cost: costBuy
      });
      const sellEdgeSanity = validateEdgeCostSanity({
        predEdgeBps: predEdgeSellBps,
        netEdgeBps: netSellBps,
        cost: costSell
      });

      const buyBlocked = this.isAdaptiveSideBlocked("BUY", ts);
      const sellBlocked = this.isAdaptiveSideBlocked("SELL", ts);
      const side: "BUY" | "SELL" | null =
        !buyBlocked &&
        buyEdgeSanity.ok &&
        netBuyBps >= this.config.minNetEdgeBps &&
        (sellBlocked || !sellEdgeSanity.ok || netBuyBps >= netSellBps)
          ? "BUY"
          : !sellBlocked && sellEdgeSanity.ok && netSellBps >= this.config.minNetEdgeBps
            ? "SELL"
            : null;
      if (!side) continue;

      const quotePx = side === "BUY" ? ask : bid;
      const kind = toKind(side);
      const toxicityDecision = this.evaluateToxicityGate({
        tokenId: candidate.tokenId,
        ts,
        mid,
        micropriceMinusMid: finiteOr(candidate.micropriceMinusMid, 0)
      });

      for (const wallet of walletRuntimes) {
        const key = shadowPositionKey(wallet.walletId, candidate.tokenId);
        if (closeAttempted.has(key)) continue;
        if (!walletAllowsTakerSide(wallet.takerSideNormalized, side)) continue;
        const marketGateDecision = evaluateWalletMarketGate(wallet.marketGate, {
          marketId: candidate.marketId,
          marketVolumeUsd: candidate.marketVolumeUsd,
          marketLiquidityUsd: candidate.marketLiquidityUsd,
          marketActive: candidate.marketActive === 1,
          kind
        });
        if (!marketGateDecision.ok) continue;
        if (toxicityDecision.blocked) {
          this.logSkipDecision({
            ts,
            tokenId: candidate.tokenId,
            walletId: wallet.walletId,
            kind,
            decisionGroupId: toDecisionGroupId(),
            decisionReason: `toxicity_gate:${toxicityDecision.reasonCode}${toxicityDecision.detail ? `;${toxicityDecision.detail}` : ""}`,
            mid,
            spread,
            bid,
            ask,
            bidDepth,
            askDepth,
            pHat,
            size: 0
          });
          continue;
        }

        const regimeDecision = this.decideRegime(kind, wallet.walletId, {
          spread,
          bidDepthTop: candidate.bidDepthTop,
          askDepthTop: candidate.askDepthTop,
          obi: candidate.obi,
          vol30m: candidate.vol30m,
          micropriceMinusMid: candidate.micropriceMinusMid
        });
        const decisionGroupId = toDecisionGroupId();
        if (!regimeDecision.allowed) {
          this.logSkipDecision({
            ts,
            tokenId: candidate.tokenId,
            walletId: wallet.walletId,
            kind,
            decisionGroupId,
            decisionReason: `regime_block:${regimeDecision.reasonCode}`,
            mid,
            spread,
            bid,
            ask,
            bidDepth,
            askDepth,
            pHat,
            size: 0
          });
          continue;
        }

        const currentPos = positions.get(key) ?? 0;
        const regimeSizeMultiplier = this.resolveRegimeSizeMultiplier(regimeDecision.sizeMultiplier);
        const scaledSize = this.config.baseOrderSize * Math.max(0.1, wallet.sizeMultiplier || 1) * regimeSizeMultiplier;
        const capSize = this.config.maxNotionalPerOrderUsd / quotePx;
        const size = Math.max(1, Math.min(scaledSize, capSize));
        const nextPos = side === "BUY" ? currentPos + size : currentPos - size;
        if (nextPos > this.config.maxLongPerToken || nextPos < -this.config.maxShortPerToken) {
          continue;
        }

        const expectedCancelTs = ts + this.config.orderTtlMs;
        const liveCost = side === "BUY"
          ? computeCostBreakdown({
              role: "TAKER",
              side: "BUY",
              midPx: mid,
              quotePx: ask,
              spreadPx: spread,
              sizeShares: size,
              marketProfile,
              feeRateBps: finiteOr(candidate.feeRateBps, 0),
              slippageBps: this.config.slippageBps,
              adverseSelectionBps: this.config.adverseSelectionBps,
              queueLossBps: this.config.queueLossBps,
              rebateBps: 0,
              inventoryPenaltyBps: this.config.inventoryPenaltyBps
            })
          : computeCostBreakdown({
              role: "TAKER",
              side: "SELL",
              midPx: mid,
              quotePx: bid,
              spreadPx: spread,
              sizeShares: size,
              marketProfile,
              feeRateBps: finiteOr(candidate.feeRateBps, 0),
              slippageBps: this.config.slippageBps,
              adverseSelectionBps: this.config.adverseSelectionBps,
              queueLossBps: this.config.queueLossBps,
              rebateBps: 0,
              inventoryPenaltyBps: this.config.inventoryPenaltyBps
            });
        const trace = side === "BUY"
          ? {
              predEdgeBps: predEdgeBuyBps,
              netEdgeBps: applyCostToEdge(predEdgeBuyBps, liveCost),
              cost: liveCost
            }
          : {
              predEdgeBps: predEdgeSellBps,
              netEdgeBps: applyCostToEdge(predEdgeSellBps, liveCost),
              cost: liveCost
            };
        if (trace.netEdgeBps < this.config.minNetEdgeBps) continue;
        const edgeSanity = validateEdgeCostSanity({
          predEdgeBps: trace.predEdgeBps,
          netEdgeBps: trace.netEdgeBps,
          cost: trace.cost
        });
        if (!edgeSanity.ok) continue;

        let externalOrderId: string | null = null;
        let clientOrderId = `${decisionGroupId}:${wallet.walletId}`;
        const shadowOnly = isShadowOnlyProfile(marketProfile);
        const shouldAttemptLive = this.config.executionMode === "FULL" &&
          this.deps.execution?.isEnabled() &&
          !shadowOnly;
        let status: string = shouldAttemptLive ? "PENDING" : "OPEN";
        let filledSize = 0;
        let filledPrice: number | null = null;
        const liveExecution = this.deps.execution;

        if (shouldAttemptLive && liveExecution) {
          const result = await liveExecution.placeTakerOrder({
            walletId: wallet.walletId,
            tokenId: candidate.tokenId,
            side,
            price: quotePx,
            size,
            kind,
            reason: "p_hat_net_edge",
            decisionGroupId,
            feeRateBps: finiteOr(candidate.feeRateBps, 0),
            postOnly: false
          });
          if (!result) continue;
          externalOrderId = result.externalOrderId;
          clientOrderId = result.clientOrderId;
          status = result.status ?? status;
          filledSize = finiteOr(result.filledSize, 0);
          filledPrice = result.filledPrice;
        }

        const orderRow = {
          ts,
          walletId: wallet.walletId,
          tokenId: candidate.tokenId,
          marketId: candidate.marketId,
          side,
          kind,
          price: quotePx,
          size,
          expectedCancelTs,
          executionMode: shouldAttemptLive ? "FULL" : "SHADOW",
          source: "taker_loop",
          clientOrderId,
          externalOrderId,
          status,
          filledSize,
          filledPrice,
          lastUpdateTs: ts,
          strategyLane: "TAKER",
          decisionGroupId,
          predSource: prior.source,
          predEdgeBps: trace.predEdgeBps,
          spreadBps: trace.cost.spreadBps,
          feesBps: trace.cost.feeBps,
          expectedSlippageBps: trace.cost.slippageBps,
          expectedAdverseBps: trace.cost.adverseSelectionBps,
          expectedQueueBps: trace.cost.queueLossBps,
          costBps: trace.cost.totalCostBps,
          netEdgeBps: trace.netEdgeBps,
          decision: "SUBMIT",
          decisionReason: `net_edge_above_threshold;profile=${marketProfile};shadow_only=${shadowOnly ? "1" : "0"};regime_mode=${regimeDecision.mode};regime_reason=${regimeDecision.reasonCode};regime_size_multiplier=${regimeDecision.sizeMultiplier.toFixed(4)}`,
          midPx: mid,
          spreadPx: spread,
          bidPx: bid,
          askPx: ask,
          bidDepth,
          askDepth,
          priorPHat: pHat
        };

        const decisionRow = {
          ts,
          tokenId: candidate.tokenId,
          walletId: wallet.walletId,
          kind,
          strategyLane: "TAKER",
          decisionGroupId,
          decision: "SUBMIT",
          decisionReason: `net_edge_above_threshold;profile=${marketProfile};shadow_only=${shadowOnly ? "1" : "0"};regime_mode=${regimeDecision.mode};regime_reason=${regimeDecision.reasonCode};regime_size_multiplier=${regimeDecision.sizeMultiplier.toFixed(4)}`,
          predEdgeBps: trace.predEdgeBps,
          costBps: trace.cost.totalCostBps,
          netEdgeBps: trace.netEdgeBps,
          spreadBps: trace.cost.spreadBps,
          feesBps: trace.cost.feeBps,
          expectedSlippageBps: trace.cost.slippageBps,
          midPx: mid,
          spreadPx: spread,
          deltaHat: pHat - mid,
          size,
          bidPx: bid,
          askPx: ask,
          bidDepth,
          askDepth
        };
        this.insertSubmitOrderAndDecisionTx(orderRow, decisionRow);

        positions.set(key, nextPos);
      }
    }
  }

  private logSkipDecision(input: {
    ts: number;
    tokenId: string;
    walletId: number;
    kind: "TAKER_BUY" | "TAKER_SELL";
    decisionGroupId: string;
    decisionReason: string;
    mid: number;
    spread: number;
    bid: number;
    ask: number;
    bidDepth: number;
    askDepth: number;
    pHat: number;
    size: number;
  }): void {
    this.insertDecisionLogStmt.run({
      ts: input.ts,
      tokenId: input.tokenId,
      walletId: input.walletId,
      kind: input.kind,
      strategyLane: "TAKER",
      decisionGroupId: input.decisionGroupId,
      decision: "SKIP",
      decisionReason: input.decisionReason,
      predEdgeBps: null,
      costBps: null,
      netEdgeBps: null,
      spreadBps: (input.spread / input.mid) * 10_000,
      feesBps: null,
      expectedSlippageBps: null,
      midPx: input.mid,
      spreadPx: input.spread,
      deltaHat: input.pHat - input.mid,
      size: input.size,
      bidPx: input.bid,
      askPx: input.ask,
      bidDepth: input.bidDepth,
      askDepth: input.askDepth
    });
  }

  private decideRegime(
    kind: "TAKER_BUY" | "TAKER_SELL",
    walletId: number,
    feature: {
      spread: number;
      bidDepthTop: number | null;
      askDepthTop: number | null;
      obi: number | null;
      vol30m: number | null;
      micropriceMinusMid: number | null;
    }
  ): RegimeDecision {
    if (!this.deps.regimeGate) {
      return {
        allowed: true,
        state: null,
        reason: "disabled",
        mode: "full",
        sizeMultiplier: 1,
        reasonCode: "disabled",
        reasonDetail: null,
        scoreBps: null,
        edgeLcbBps: null,
        edgeUcbBps: null,
        pFillLcb: null,
        wavgBps: null,
        count: null,
        fillRate: null,
        nOrders: null,
        nFills: null,
        nMarkouts: null
      };
    }
    return this.deps.regimeGate.decide(kind, walletId, feature, {
      lane: "taker",
      executionMode: this.config.executionMode
    });
  }

  private resolveRegimeSizeMultiplier(raw: number): number {
    const modulation = this.config.regimeModulation!;
    if (!modulation.enabled) return 1;
    return Math.max(modulation.sizeMultiplierMin, Math.min(modulation.sizeMultiplierMax, raw));
  }

  private async runRiskClosePass(input: {
    ts: number;
    walletRuntimes: WalletRuntime[];
    candidateByToken: Map<string, CandidateRow>;
    positionStates: Map<string, ShadowPositionState>;
    positions: Map<string, number>;
  }): Promise<Set<string>> {
    const closed = new Set<string>();
    const closeCfg = this.config.close;
    if (!closeCfg?.enabled) return closed;

    for (const wallet of input.walletRuntimes) {
      for (const state of input.positionStates.values()) {
        if (state.walletId !== wallet.walletId || state.position === 0) continue;

        const key = shadowPositionKey(wallet.walletId, state.tokenId);
        const hysteresis = this.getOrCreateCloseState(key);
        const closeCooldownMs = Math.max(0, closeCfg.closeCooldownSec) * 1000;
        if (
          hysteresis.lastCloseAttemptTs != null &&
          input.ts - hysteresis.lastCloseAttemptTs < closeCooldownMs
        ) {
          continue;
        }

        const candidate = input.candidateByToken.get(state.tokenId);
        if (!candidate || !this.isFeatureFresh(candidate, input.ts)) continue;

        const mid = finiteOr(candidate.mid, NaN);
        const bid = finiteOr(candidate.bestBid, NaN);
        const ask = finiteOr(candidate.bestAsk, NaN);
        const spread = finiteOr(candidate.spread, ask - bid);
        const bidDepth = finiteOr(candidate.bidDepthTop, 0);
        const askDepth = finiteOr(candidate.askDepthTop, 0);
        if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) continue;
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) continue;
        if (!Number.isFinite(spread) || spread < 0 || spread > this.config.maxSpread) continue;
        if (Math.min(bidDepth, askDepth) < this.config.minDepth) continue;
        if (candidate.marketActive !== 1) continue;

        const marketProfile = classifyMarketProfile({
          question: candidate.marketQuestion,
          slug: candidate.marketSlug,
          eventTitle: candidate.eventTitle,
          feeRateBps: candidate.feeRateBps,
          takerBaseFee: candidate.takerBaseFee
        });
        const scopeDecision = decideMarketProfileScope(
          marketProfile,
          this.config.marketScope ?? "PROFILE_KNOWN_ONLY"
        );
        if (!scopeDecision.ok || marketProfile === "UNKNOWN") continue;

        const closeSide: "BUY" | "SELL" = state.position > 0 ? "SELL" : "BUY";
        if (!walletAllowsTakerSide(wallet.takerSideNormalized, closeSide)) continue;
        const closeKind = toKind(closeSide);
        const marketGateDecision = evaluateWalletMarketGate(wallet.marketGate, {
          marketId: candidate.marketId,
          marketVolumeUsd: candidate.marketVolumeUsd,
          marketLiquidityUsd: candidate.marketLiquidityUsd,
          marketActive: candidate.marketActive === 1,
          kind: closeKind
        });
        if (!marketGateDecision.ok) continue;

        const beliefContext: BeliefContext = {
          tokenId: candidate.tokenId,
          marketId: candidate.marketId,
          midPx: mid,
          spreadPx: spread,
          bidDepthTop: candidate.bidDepthTop,
          askDepthTop: candidate.askDepthTop,
          obi: candidate.obi,
          vol30m: candidate.vol30m,
          ts: input.ts
        };
        const prior = await this.deps.belief.estimate(beliefContext);
        if (!prior) continue;
        const pHat = prior.probability;

        const quotePx = closeSide === "BUY" ? ask : bid;
        const capSize = this.config.maxNotionalPerOrderUsd / quotePx;
        const tentativeSize = Math.min(Math.abs(state.position), capSize);
        if (!Number.isFinite(tentativeSize) || tentativeSize <= 0) continue;

        const closeCost = closeSide === "BUY"
          ? computeCostBreakdown({
              role: "TAKER",
              side: "BUY",
              midPx: mid,
              quotePx: ask,
              spreadPx: spread,
              sizeShares: tentativeSize,
              marketProfile,
              feeRateBps: finiteOr(candidate.feeRateBps, 0),
              slippageBps: this.config.slippageBps,
              adverseSelectionBps: this.config.adverseSelectionBps,
              queueLossBps: this.config.queueLossBps,
              rebateBps: 0,
              inventoryPenaltyBps: this.config.inventoryPenaltyBps
            })
          : computeCostBreakdown({
              role: "TAKER",
              side: "SELL",
              midPx: mid,
              quotePx: bid,
              spreadPx: spread,
              sizeShares: tentativeSize,
              marketProfile,
              feeRateBps: finiteOr(candidate.feeRateBps, 0),
              slippageBps: this.config.slippageBps,
              adverseSelectionBps: this.config.adverseSelectionBps,
              queueLossBps: this.config.queueLossBps,
              rebateBps: 0,
              inventoryPenaltyBps: this.config.inventoryPenaltyBps
            });

        const predCloseEdgeBps = closeSide === "BUY"
          ? ((pHat - ask) / mid) * 10_000
          : ((bid - pHat) / mid) * 10_000;
        const netCloseEdgeBps = applyCostToEdge(predCloseEdgeBps, closeCost);
        const predHoldEdgeBps = state.position > 0
          ? ((pHat - mid) / mid) * 10_000
          : ((mid - pHat) / mid) * 10_000;
        const edgeBelow = predHoldEdgeBps < closeCfg.closeMinEdgeToHoldBps;
        if (edgeBelow) {
          hysteresis.belowTicks += 1;
          if (hysteresis.belowSinceTs == null) hysteresis.belowSinceTs = input.ts;
        } else {
          hysteresis.belowTicks = 0;
          hysteresis.belowSinceTs = null;
        }

        const maxHoldTriggered =
          state.openTs != null && input.ts - state.openTs >= closeCfg.maxHoldSec * 1000;
        const inventoryTriggered =
          state.position > this.config.maxLongPerToken ||
          state.position < -this.config.maxShortPerToken;
        const edgeDecayTriggered =
          edgeBelow &&
          (hysteresis.belowTicks >= closeCfg.edgeBelowTicks ||
            (hysteresis.belowSinceTs != null &&
              input.ts - hysteresis.belowSinceTs >= closeCfg.edgeBelowMs));
        const edgeDecayActionable = edgeDecayTriggered && netCloseEdgeBps >= 0;

        let closeReason: "close:max_hold" | "close:inventory_cap" | "close:edge_decay" | null = null;
        if (maxHoldTriggered) closeReason = "close:max_hold";
        else if (inventoryTriggered) closeReason = "close:inventory_cap";
        else if (edgeDecayActionable) closeReason = "close:edge_decay";
        if (!closeReason) continue;

        const size = tentativeSize;
        const expectedCancelTs = input.ts + this.config.orderTtlMs;
        const decisionGroupId = toDecisionGroupId();
        let externalOrderId: string | null = null;
        let clientOrderId = `${decisionGroupId}:${wallet.walletId}`;
        const shadowOnly = isShadowOnlyProfile(marketProfile);
        const shouldAttemptLive =
          this.config.executionMode === "FULL" &&
          this.deps.execution?.isEnabled() &&
          !shadowOnly;
        let status: string = shouldAttemptLive ? "PENDING" : "OPEN";
        let filledSize = 0;
        let filledPrice: number | null = null;
        const liveExecution = this.deps.execution;

        if (shouldAttemptLive && liveExecution) {
          const result = await liveExecution.placeTakerOrder({
            walletId: wallet.walletId,
            tokenId: candidate.tokenId,
            side: closeSide,
            price: quotePx,
            size,
            kind: closeKind,
            reason: closeReason,
            decisionGroupId,
            feeRateBps: finiteOr(candidate.feeRateBps, 0),
            postOnly: false
          });
          if (!result) continue;
          externalOrderId = result.externalOrderId;
          clientOrderId = result.clientOrderId;
          status = result.status ?? status;
          filledSize = finiteOr(result.filledSize, 0);
          filledPrice = result.filledPrice;
        }

        const closeDecisionReason = [
          closeReason,
          `profile=${marketProfile}`,
          `shadow_only=${shadowOnly ? "1" : "0"}`,
          `regime_bypass=1`,
          `hold_edge_bps=${predHoldEdgeBps.toFixed(4)}`,
          `close_net_edge_bps=${netCloseEdgeBps.toFixed(4)}`
        ].join(";");

        const closeOrderRow = {
          ts: input.ts,
          walletId: wallet.walletId,
          tokenId: candidate.tokenId,
          marketId: candidate.marketId,
          side: closeSide,
          kind: closeKind,
          price: quotePx,
          size,
          expectedCancelTs,
          executionMode: shouldAttemptLive ? "FULL" : "SHADOW",
          source: "taker_loop",
          clientOrderId,
          externalOrderId,
          status,
          filledSize,
          filledPrice,
          lastUpdateTs: input.ts,
          strategyLane: "TAKER",
          decisionGroupId,
          predSource: prior.source,
          predEdgeBps: predCloseEdgeBps,
          spreadBps: closeCost.spreadBps,
          feesBps: closeCost.feeBps,
          expectedSlippageBps: closeCost.slippageBps,
          expectedAdverseBps: closeCost.adverseSelectionBps,
          expectedQueueBps: closeCost.queueLossBps,
          costBps: closeCost.totalCostBps,
          netEdgeBps: netCloseEdgeBps,
          decision: "SUBMIT",
          decisionReason: closeDecisionReason,
          midPx: mid,
          spreadPx: spread,
          bidPx: bid,
          askPx: ask,
          bidDepth,
          askDepth,
          priorPHat: pHat
        };

        const closeDecisionRow = {
          ts: input.ts,
          tokenId: candidate.tokenId,
          walletId: wallet.walletId,
          kind: closeKind,
          strategyLane: "TAKER",
          decisionGroupId,
          decision: "SUBMIT",
          decisionReason: closeDecisionReason,
          predEdgeBps: predCloseEdgeBps,
          costBps: closeCost.totalCostBps,
          netEdgeBps: netCloseEdgeBps,
          spreadBps: closeCost.spreadBps,
          feesBps: closeCost.feeBps,
          expectedSlippageBps: closeCost.slippageBps,
          midPx: mid,
          spreadPx: spread,
          deltaHat: pHat - mid,
          size,
          bidPx: bid,
          askPx: ask,
          bidDepth,
          askDepth
        };
        this.insertSubmitOrderAndDecisionTx(closeOrderRow, closeDecisionRow);

        input.positions.set(
          key,
          (input.positions.get(key) ?? state.position) + (closeSide === "BUY" ? size : -size)
        );
        closed.add(key);
        hysteresis.lastCloseAttemptTs = input.ts;
        hysteresis.belowTicks = 0;
        hysteresis.belowSinceTs = null;
      }
    }

    return closed;
  }

  private getOrCreateCloseState(key: string): CloseHysteresisState {
    const existing = this.closeHysteresisByKey.get(key);
    if (existing) return existing;
    const created: CloseHysteresisState = {
      belowTicks: 0,
      belowSinceTs: null,
      lastCloseAttemptTs: null
    };
    this.closeHysteresisByKey.set(key, created);
    return created;
  }

  private isFeatureFresh(candidate: CandidateRow, nowTs: number): boolean {
    if (!Number.isFinite(candidate.featureTs)) return false;
    const maxAgeMs = Math.max(1, finiteOr(this.config.maxFeatureStalenessSec, 60)) * 1000;
    return nowTs - (candidate.featureTs as number) <= maxAgeMs;
  }

  private isKillSwitchActive(): boolean {
    try {
      const row = this.selectKillSwitchStmt.get() as { value: string | number | null } | undefined;
      if (!row || row.value == null) return false;
      const raw = String(row.value).trim().toLowerCase();
      return raw === "1" || raw === "true" || raw === "on" || raw === "enabled";
    } catch {
      return false;
    }
  }

  private parseTradePayload(payloadJson: string): { side: "BUY" | "SELL" | null; price: number | null } {
    try {
      const parsed = JSON.parse(payloadJson) as { side?: unknown; price?: unknown };
      const rawSide = typeof parsed.side === "string" ? parsed.side.trim().toUpperCase() : "";
      const side = rawSide === "BUY" || rawSide === "SELL" ? (rawSide as "BUY" | "SELL") : null;
      const price = typeof parsed.price === "number" && Number.isFinite(parsed.price) ? parsed.price : null;
      return { side, price };
    } catch {
      return { side: null, price: null };
    }
  }

  private evaluateToxicityGate(input: {
    tokenId: string;
    ts: number;
    mid: number;
    micropriceMinusMid: number;
  }): TakerToxicityDecision {
    const cfg = this.config.toxicity;
    if (!cfg?.enabled || !this.selectRecentTradesStmt) {
      return { blocked: false, reasonCode: "disabled", detail: null };
    }

    const blockUntil = this.toxicityBlockUntilByToken.get(input.tokenId) ?? 0;
    if (blockUntil > input.ts) {
      return {
        blocked: true,
        reasonCode: "cooldown_active",
        detail: `until_ms=${blockUntil}`
      };
    }
    if (blockUntil > 0) {
      this.toxicityBlockUntilByToken.delete(input.tokenId);
    }

    const lookbackSince = input.ts - cfg.lookbackSec * 1000;
    let rows: Array<{ recvTsMs: number; payloadJson: string }> = [];
    try {
      rows = this.selectRecentTradesStmt.all(input.tokenId, lookbackSince) as Array<{
        recvTsMs: number;
        payloadJson: string;
      }>;
    } catch {
      return { blocked: false, reasonCode: "query_error", detail: null };
    }
    if (!rows.length) return { blocked: false, reasonCode: "no_recent_trades", detail: null };

    let buyCount = 0;
    let sellCount = 0;
    let firstPrice: number | null = null;
    let lastPrice: number | null = null;
    let validCount = 0;

    for (const row of rows) {
      const parsed = this.parseTradePayload(row.payloadJson);
      if (parsed.price == null || parsed.price <= 0) continue;
      if (parsed.side !== "BUY" && parsed.side !== "SELL") continue;
      validCount += 1;
      if (parsed.side === "BUY") buyCount += 1;
      else sellCount += 1;
      if (firstPrice == null) firstPrice = parsed.price;
      lastPrice = parsed.price;
    }
    if (validCount < cfg.minTradeEvents || firstPrice == null || lastPrice == null) {
      return { blocked: false, reasonCode: "insufficient_trade_events", detail: null };
    }

    const dominantSideRatio = Math.max(buyCount, sellCount) / Math.max(1, validCount);
    const tradeShockBps = Number.isFinite(input.mid) && input.mid > 0
      ? Math.abs((lastPrice - firstPrice) / input.mid) * 10_000
      : 0;
    const microShockBps = Number.isFinite(input.mid) && input.mid > 0
      ? Math.abs((input.micropriceMinusMid / input.mid) * 10_000)
      : 0;

    const directionallyOneSided = dominantSideRatio >= cfg.dominantSideRatio;
    const tradeShockTriggered = directionallyOneSided && tradeShockBps >= cfg.shockBps;
    const microShockTriggered = directionallyOneSided && microShockBps >= cfg.micropriceShockBps;

    if (!tradeShockTriggered && !microShockTriggered) {
      return { blocked: false, reasonCode: "pass", detail: null };
    }

    const reasonCode = tradeShockTriggered ? "trade_shock" : "microprice_shock";
    const blockMs = Math.max(1_000, cfg.cooldownMs);
    const nextUntil = input.ts + blockMs;
    this.toxicityBlockUntilByToken.set(input.tokenId, nextUntil);
    return {
      blocked: true,
      reasonCode,
      detail: `trades=${validCount};dominance=${dominantSideRatio.toFixed(3)};trade_shock_bps=${tradeShockBps.toFixed(2)};micro_shock_bps=${microShockBps.toFixed(2)}`
    };
  }

  private loadPositionStates(): Map<string, ShadowPositionState> {
    const rows = this.selectPositionFillsStmt.all() as Array<{
      walletId: number;
      tokenId: string;
      side: string;
      price: number;
      size: number;
      ts: number;
    }>;
    const fills: ShadowFillInput[] = [];
    for (const row of rows) {
      if (row.side !== "BUY" && row.side !== "SELL") continue;
      fills.push({
        walletId: row.walletId,
        tokenId: row.tokenId,
        side: row.side,
        price: row.price,
        size: row.size,
        ts: row.ts
      });
    }
    return buildShadowPositionLedger(fills);
  }
}
