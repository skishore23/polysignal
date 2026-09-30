import type { Logger } from "../logger";
import { TaskScheduler } from "../utils/TaskScheduler";
import type { LiveExecutionGateway } from "../execution/clobExecution";
import { BeliefEngine, type BeliefContext } from "../belief";
import { computeCostBreakdown } from "../trading/CostModel";
import { validateEdgeCostSanity } from "../trading/EdgeSanity";
import {
  classifyMarketProfile,
  type MarketProfile,
  type MarketScope,
  isFeeEnabledProfile,
  isShadowOnlyProfile
} from "../trading/MarketProfile";
import {
  computeLiquidityOrderScore,
  estimateExpectedMakerRebateBps,
  normalizeRewardsMaxSpreadCents
} from "../trading/PolymarketFeeMath";
import { decideMakerExpectedEv, decideMarketProfileScope } from "../trading/DecisionEngine";
import {
  compileWalletMarketGate,
  evaluateWalletMarketGate,
  type CompiledWalletMarketGate
} from "../trading/WalletMarketGate";
import type { RegimeGate, RegimeDecision } from "../regime/RegimeGate";
import type { MakerTradeFlowGateConfig, RegimeModulationConfig } from "../config";

type MakerLoopConfig = {
  intervalMs: number;
  enableBidQuotes?: boolean;
  enableAskQuotes?: boolean;
  quoteSize: number;
  maxNotionalPerOrderUsd: number;
  minExpectedEvBps: number;
  maxInventoryAbs: number;
  inventoryLambdaBps: number;
  quoteHalfSpreadBps: number;
  maxSpread: number;
  minDepth: number;
  slippageBps: number;
  adverseSelectionBps: number;
  queueLossBps: number;
  rebateBps: number;
  rebateShareAssumption?: number;
  liquidityRewardBpsWhenScoring?: number;
  orderTtlMs: number;
  priceToleranceBps: number;
  marketScope?: MarketScope;
  executionMode: "PAPER" | "FULL";
  regimeModulation?: RegimeModulationConfig;
  tradeFlowGate?: MakerTradeFlowGateConfig;
};

type MakerDeps = {
  sqlite: any;
  logger: Logger;
  belief: BeliefEngine;
  execution?: LiveExecutionGateway;
  regimeGate?: RegimeGate;
};

type FeatureRow = {
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
  minimumTickSize: number | null;
  rewardsMinSize: number | null;
  rewardsMaxSpread: number | null;
  rewardsRatesJson: string | null;
};

type WalletRow = {
  walletId: number;
  sizeMultiplier: number;
  inventoryTarget: number;
  inventoryMaxAbs: number;
  marketFilterJson: string | null;
};

type WalletRuntime = WalletRow & {
  marketGate: CompiledWalletMarketGate;
};

type OpenOrderRow = {
  id: number;
  walletId: number;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number | null;
  size: number | null;
  ts: number;
  expectedCancelTs: number | null;
  externalOrderId: string | null;
  status: string | null;
};

type RecentTradeCounts = {
  byToken: Map<string, number>;
  byMarket: Map<string, number>;
};

const toDecisionGroupId = (): string => `maker:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

const finiteOr = (value: number | null | undefined, fallback: number): number =>
  Number.isFinite(value) ? (value as number) : fallback;

const bps = (x: number): number => x * 10_000;

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

const roundDownToTick = (price: number, tickSize: number): number => {
  if (!Number.isFinite(price)) return NaN;
  const steps = Math.floor(price / tickSize);
  return Number((steps * tickSize).toFixed(10));
};

const roundUpToTick = (price: number, tickSize: number): number => {
  if (!Number.isFinite(price)) return NaN;
  const steps = Math.ceil(price / tickSize);
  return Number((steps * tickSize).toFixed(10));
};

const clampBinaryPrice = (price: number, tickSize: number): number => {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) return NaN;
  const floor = tickSize;
  const ceil = 1 - tickSize;
  return Math.max(floor, Math.min(ceil, price));
};

const parseRewardMultiplier = (raw: string | null): number => {
  if (!raw) return 1;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value =
      parsed.in_game_multiplier ??
      parsed.inGameMultiplier ??
      parsed.in_play_multiplier ??
      parsed.inPlayMultiplier ??
      parsed.pre_game_multiplier ??
      parsed.preGameMultiplier ??
      parsed.pre_play_multiplier ??
      parsed.prePlayMultiplier ??
      parsed.multiplier ??
      parsed.b ??
      null;
    const multiplier =
      typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : null;
    return Number.isFinite(multiplier) && (multiplier as number) > 0 ? (multiplier as number) : 1;
  } catch {
    return 1;
  }
};

const estimateLocalOrderScoring = (input: {
  mid: number;
  price: number;
  size: number;
  rewardsMinSize: number | null;
  rewardsMaxSpread: number | null;
  rewardsRatesJson: string | null;
}): boolean => {
  const maxSpreadCents = normalizeRewardsMaxSpreadCents(input.rewardsMaxSpread);
  if (maxSpreadCents == null) return false;
  const score = computeLiquidityOrderScore({
    midpointPrice: input.mid,
    orderPrice: input.price,
    sizeShares: input.size,
    maxSpreadCents,
    minSizeShares: input.rewardsMinSize ?? 0,
    multiplier: parseRewardMultiplier(input.rewardsRatesJson)
  });
  return score > 0;
};

export class MakerLoop {
  private readonly config: MakerLoopConfig;
  private readonly deps: MakerDeps;
  private readonly scheduler: TaskScheduler;
  private readonly flowGateSkipLogTs = new Map<string, number>();

  private readonly selectFeaturesStmt: any;
  private readonly selectWalletsStmt: any;
  private readonly selectInventoryStmt: any;
  private readonly selectActiveOrdersStmt: any;
  private readonly selectRecentTradeCountsStmt: any;
  private readonly selectRecentMarketTradeCountsStmt: any;
  private readonly cancelOrderStmt: any;
  private readonly insertShadowOrderStmt: any;
  private readonly insertDecisionLogStmt: any;
  private readonly insertSubmitOrderAndDecisionTx: any;

  constructor(config: MakerLoopConfig, deps: MakerDeps) {
    this.config = {
      ...config,
      enableBidQuotes: config.enableBidQuotes ?? true,
      enableAskQuotes: config.enableAskQuotes ?? true,
      rebateShareAssumption: finiteOr(config.rebateShareAssumption, 0.05),
      liquidityRewardBpsWhenScoring: finiteOr(config.liquidityRewardBpsWhenScoring, 1),
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
      tradeFlowGate: config.tradeFlowGate ?? {
        enabled: true,
        lookbackSec: 600,
        minTradeEvents: 2,
        mode: "PASSIVE_DECAY",
        staleCancelAgeSec: 45
      }
    };
    this.deps = deps;

    this.selectFeaturesStmt = deps.sqlite.prepare(
      `SELECT
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
         m.taker_base_fee as takerBaseFee,
         m.minimum_tick_size as minimumTickSize,
         m.rewards_min_size as rewardsMinSize,
         m.rewards_max_spread as rewardsMaxSpread,
         m.rewards_rates_json as rewardsRatesJson
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
         maker_inventory_target as inventoryTarget,
         maker_inventory_max_abs as inventoryMaxAbs,
         market_filter_json as marketFilterJson
       FROM wallets
       WHERE maker_enabled = 1`
    );

    this.selectInventoryStmt = deps.sqlite.prepare(
      `SELECT
         o.wallet_id as walletId,
         o.token_id as tokenId,
         SUM(CASE WHEN o.side = 'BUY' THEN f.size ELSE -f.size END) as position
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE o.kind IN ('MAKER_BID', 'MAKER_ASK', 'INVENTORY_REBALANCE')
         AND f.method != 'synthetic_fill'
       GROUP BY o.wallet_id, o.token_id`
    );

    this.selectActiveOrdersStmt = deps.sqlite.prepare(
      `SELECT
         id,
         wallet_id as walletId,
         token_id as tokenId,
         side,
         price,
         size,
         ts,
         expected_cancel_ts as expectedCancelTs,
         external_order_id as externalOrderId,
         status
       FROM shadow_orders
       WHERE kind IN ('MAKER_BID', 'MAKER_ASK')
         AND COALESCE(status, 'OPEN') IN ('OPEN', 'PENDING', 'PARTIAL')`
    );

    this.selectRecentTradeCountsStmt = deps.sqlite.prepare(
      `SELECT token_id as tokenId, COUNT(*) as tradeCount
       FROM clob_events
       WHERE msg_type = 'trade'
         AND recv_ts_ms >= ?
       GROUP BY token_id`
    );
    this.selectRecentMarketTradeCountsStmt = deps.sqlite.prepare(
      `SELECT t.market_id as marketId, COUNT(*) as tradeCount
       FROM clob_events e
       JOIN tokens t ON t.id = e.token_id
       WHERE e.msg_type = 'trade'
         AND e.recv_ts_ms >= ?
         AND t.market_id IS NOT NULL
       GROUP BY t.market_id`
    );

    this.cancelOrderStmt = deps.sqlite.prepare(
      `UPDATE shadow_orders
       SET status = 'CANCELLED',
           last_update_ts = @lastUpdateTs
       WHERE id = @id`
    );

    this.insertShadowOrderStmt = deps.sqlite.prepare(
      `INSERT INTO shadow_orders
       (ts, wallet_id, token_id, market_id, side, kind, price, size, expected_cancel_ts, execution_mode,
        source, client_order_id, external_order_id, status, filled_size, filled_price, last_update_ts,
        strategy_lane, decision_group_id, pred_source,
        pred_edge_bps, spread_bps, fees_bps, expected_slippage_bps, expected_adverse_bps,
        expected_queue_bps, cost_bps, net_edge_bps, decision, decision_reason,
        mid_px, spread_px, bid_px, ask_px, bid_depth, ask_depth,
        inventory_i_before, inventory_i_after, inventory_delta_abs, inventory_penalty_bps, prior_p_hat)
       VALUES (@ts, @walletId, @tokenId, @marketId, @side, @kind, @price, @size, @expectedCancelTs, @executionMode,
               @source, @clientOrderId, @externalOrderId, @status, @filledSize, @filledPrice, @lastUpdateTs,
               @strategyLane, @decisionGroupId, @predSource,
               @predEdgeBps, @spreadBps, @feesBps, @expectedSlippageBps, @expectedAdverseBps,
               @expectedQueueBps, @costBps, @netEdgeBps, @decision, @decisionReason,
               @midPx, @spreadPx, @bidPx, @askPx, @bidDepth, @askDepth,
               @inventoryIBefore, @inventoryIAfter, @inventoryDeltaAbs, @inventoryPenaltyBps, @priorPHat)`
    );

    this.insertDecisionLogStmt = deps.sqlite.prepare(
      `INSERT INTO decision_log
       (ts, token_id, wallet_id, kind, strategy_lane, decision_group_id, decision, decision_reason, pred_edge_bps, cost_bps, net_edge_bps,
        spread_bps, fees_bps, expected_slippage_bps, mid_px, spread_px, delta_hat, size, bid_px, ask_px, bid_depth, ask_depth)
       VALUES (@ts, @tokenId, @walletId, @kind, @strategyLane, @decisionGroupId, @decision, @decisionReason, @predEdgeBps, @costBps, @netEdgeBps,
               @spreadBps, @feesBps, @expectedSlippageBps, @midPx, @spreadPx, @deltaHat, @size, @bidPx, @askPx, @bidDepth, @askDepth)`
    );
    this.insertSubmitOrderAndDecisionTx = deps.sqlite.transaction(
      (orderRow: Record<string, unknown>, decisionRow: Record<string, unknown>) => {
        this.insertShadowOrderStmt.run(orderRow);
        this.insertDecisionLogStmt.run(decisionRow);
      }
    );

    this.scheduler = new TaskScheduler(() => this.tick(), {
      name: "MakerLoop",
      intervalMs: this.config.intervalMs,
      logger: deps.logger
    });
  }

  public start(): void {
    this.deps.logger.info(
      {
        marketScope: this.config.marketScope,
        enableBidQuotes: this.config.enableBidQuotes,
        enableAskQuotes: this.config.enableAskQuotes,
        tradeFlowGate: this.config.tradeFlowGate
      },
      "Starting MakerLoop (fee-aware EV gated)"
    );
    this.scheduler.start();
  }

  public stop(): void {
    this.scheduler.stop();
  }

  private async tick(): Promise<void> {
    const ts = Date.now();
    const features = this.selectFeaturesStmt.all() as FeatureRow[];
    const wallets = this.selectWalletsStmt.all() as WalletRow[];
    if (!features.length || !wallets.length) return;
    const walletRuntimes: WalletRuntime[] = wallets.map((wallet) => ({
      ...wallet,
      marketGate: compileWalletMarketGate({
        marketFilterJson: wallet.marketFilterJson
      })
    }));

    const inventoryMap = this.loadInventoryMap();
    const openOrderMap = this.loadOpenOrderMap();
    const recentTradeCounts = this.loadRecentTradeCounts(ts);

    for (const feature of features) {
      const mid = finiteOr(feature.mid, NaN);
      const bid = finiteOr(feature.bestBid, NaN);
      const ask = finiteOr(feature.bestAsk, NaN);
      const spread = finiteOr(feature.spread, ask - bid);
      const bidDepth = finiteOr(feature.bidDepthTop, 0);
      const askDepth = finiteOr(feature.askDepthTop, 0);
      if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) continue;
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) continue;
      if (!Number.isFinite(spread) || spread < 0 || spread > this.config.maxSpread) continue;
      if (Math.min(bidDepth, askDepth) < this.config.minDepth) continue;

      const marketProfile = classifyMarketProfile({
        question: feature.marketQuestion,
        slug: feature.marketSlug,
        eventTitle: feature.eventTitle,
        feeRateBps: feature.feeRateBps,
        takerBaseFee: feature.takerBaseFee
      });
      const scopeDecision = decideMarketProfileScope(marketProfile, this.config.marketScope ?? "PROFILE_KNOWN_ONLY");
      if (!scopeDecision.ok || marketProfile === "UNKNOWN") {
        if (isFeeEnabledProfile(marketProfile)) {
          this.deps.logger.debug(
            {
              tokenId: feature.tokenId,
              marketId: feature.marketId,
              marketProfile,
              reason: marketProfile === "UNKNOWN" ? "market_profile_unknown_fail_closed" : scopeDecision.reason
            },
            "Maker skip: market profile scope gate"
          );
        }
        continue;
      }

      const prior = await this.deps.belief.estimate({
        tokenId: feature.tokenId,
        marketId: feature.marketId,
        midPx: mid,
        spreadPx: spread,
        bidDepthTop: feature.bidDepthTop,
        askDepthTop: feature.askDepthTop,
        obi: feature.obi,
        vol30m: feature.vol30m,
        ts
      } satisfies BeliefContext);
      if (!prior) continue;

      const pHat = prior.probability;
      const depthScale = Math.max(1, this.config.minDepth * 2);
      const fillProbBid = clamp(
        0.05 + (bidDepth / depthScale) * 0.5 + (spread / this.config.maxSpread) * 0.35,
        0.05,
        0.95
      );
      const fillProbAsk = clamp(
        0.05 + (askDepth / depthScale) * 0.5 + (spread / this.config.maxSpread) * 0.35,
        0.05,
        0.95
      );
      const tickSize =
        Number.isFinite(feature.minimumTickSize) && (feature.minimumTickSize as number) > 0
          ? (feature.minimumTickSize as number)
          : 0.001;

      for (const wallet of walletRuntimes) {
        const openBidOrder = openOrderMap.get(`${wallet.walletId}:${feature.tokenId}:BUY`) ?? null;
        const openAskOrder = openOrderMap.get(`${wallet.walletId}:${feature.tokenId}:SELL`) ?? null;
        const tokenFlowTradeCount = recentTradeCounts?.byToken.get(feature.tokenId) ?? 0;
        const marketFlowTradeCount =
          feature.marketId != null ? (recentTradeCounts?.byMarket.get(feature.marketId) ?? 0) : 0;
        const flowTradeCount = Math.max(tokenFlowTradeCount, marketFlowTradeCount);
        if (
          this.config.tradeFlowGate?.enabled &&
          recentTradeCounts != null &&
          flowTradeCount < this.config.tradeFlowGate.minTradeEvents
        ) {
          const flowDecisionReason = "maker_flow_gate_no_trades";
          const flowCancelReason =
            this.config.tradeFlowGate.mode === "IMMEDIATE_CANCEL"
              ? "maker_flow_gate_immediate_cancel"
              : "maker_flow_gate_passive_decay_cancel";
          if (openBidOrder && this.shouldCancelOnFlowGate(openBidOrder, ts)) {
            await this.cancelOpenOrder(openBidOrder, ts);
            this.logSkipDecision({
              ts,
              tokenId: feature.tokenId,
              walletId: wallet.walletId,
              kind: "MAKER_BID",
              decisionReason: flowCancelReason,
              mid,
              spread,
              bid,
              ask,
              bidDepth,
              askDepth,
              pHat,
              size: openBidOrder.size ?? 0
            });
          }
          if (openAskOrder && this.shouldCancelOnFlowGate(openAskOrder, ts)) {
            await this.cancelOpenOrder(openAskOrder, ts);
            this.logSkipDecision({
              ts,
              tokenId: feature.tokenId,
              walletId: wallet.walletId,
              kind: "MAKER_ASK",
              decisionReason: flowCancelReason,
              mid,
              spread,
              bid,
              ask,
              bidDepth,
              askDepth,
              pHat,
              size: openAskOrder.size ?? 0
            });
          }
          this.logSkipDecision({
            ts,
            tokenId: feature.tokenId,
            walletId: wallet.walletId,
            kind: "MAKER_BID",
            decisionReason: flowDecisionReason,
            mid,
            spread,
            bid,
            ask,
            bidDepth,
            askDepth,
            pHat,
            size: 0
          });
          this.logSkipDecision({
            ts,
            tokenId: feature.tokenId,
            walletId: wallet.walletId,
            kind: "MAKER_ASK",
            decisionReason: flowDecisionReason,
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

        const invKey = `${wallet.walletId}:${feature.tokenId}`;
        const position = inventoryMap.get(invKey) ?? 0;
        const target = finiteOr(wallet.inventoryTarget, 0);
        const maxInv = finiteOr(wallet.inventoryMaxAbs, this.config.maxInventoryAbs);
        const skew = clamp((position - target) / Math.max(1, maxInv), -1, 1);

        const modulation = this.config.regimeModulation!;
        const baseHalfSpreadBps = Math.max(this.config.quoteHalfSpreadBps, bps(spread / mid) / 2);
        const tickBps = bps(tickSize / mid);
        const minHalfSpreadBps = tickBps * Math.max(1, modulation.spreadTicksMin);
        const maxHalfSpreadBps = tickBps * Math.max(modulation.spreadTicksMin, modulation.spreadTicksMax);
        const effectiveHalfSpreadBps = clamp(
          baseHalfSpreadBps * (modulation.enabled ? modulation.spreadMultiplier : 1),
          minHalfSpreadBps,
          maxHalfSpreadBps
        );
        const halfSpreadPx = mid * (effectiveHalfSpreadBps / 10_000);
        const reservation = clamp(pHat - skew * 0.02, 0.01, 0.99);
        const bidPx = clampBinaryPrice(
          roundDownToTick(Math.min(ask - tickSize, reservation - halfSpreadPx), tickSize),
          tickSize
        );
        const askPx = clampBinaryPrice(
          roundUpToTick(Math.max(bid + tickSize, reservation + halfSpreadPx), tickSize),
          tickSize
        );
        if (!Number.isFinite(bidPx) || !Number.isFinite(askPx) || bidPx >= askPx) continue;

        const regimeFeature = {
          spread,
          bidDepthTop: feature.bidDepthTop,
          askDepthTop: feature.askDepthTop,
          obi: feature.obi,
          vol30m: feature.vol30m,
          micropriceMinusMid: feature.micropriceMinusMid
        };
        const bidRegime = this.decideRegime("MAKER_BID", wallet.walletId, regimeFeature);
        const askRegime = this.decideRegime("MAKER_ASK", wallet.walletId, regimeFeature);
        const bidRegimeMultiplier = this.resolveRegimeSizeMultiplier(bidRegime.sizeMultiplier);
        const askRegimeMultiplier = this.resolveRegimeSizeMultiplier(askRegime.sizeMultiplier);

        const sizeBase = this.config.quoteSize * Math.max(0.1, wallet.sizeMultiplier || 1);
        const bidSize = Math.max(
          1,
          Math.min(sizeBase * bidRegimeMultiplier, this.config.maxNotionalPerOrderUsd / bidPx)
        );
        const askSize = Math.max(
          1,
          Math.min(sizeBase * askRegimeMultiplier, this.config.maxNotionalPerOrderUsd / askPx)
        );
        const effectiveMaxInvBid =
          maxInv * clamp(bidRegimeMultiplier, modulation.inventoryScaleFloor, modulation.inventoryScaleCap);
        const effectiveMaxInvAsk =
          maxInv * clamp(askRegimeMultiplier, modulation.inventoryScaleFloor, modulation.inventoryScaleCap);

        const invPenaltyBid =
          Math.max(0, Math.abs(position + bidSize) - Math.abs(position)) * this.config.inventoryLambdaBps;
        const invPenaltyAsk =
          Math.max(0, Math.abs(position - askSize) - Math.abs(position)) * this.config.inventoryLambdaBps;
        const expectedRebateBidBps = estimateExpectedMakerRebateBps({
          marketProfile,
          shares: bidSize,
          price: bidPx,
          rebateShareAssumption: this.config.rebateShareAssumption ?? 0.05,
          feeRateBps: feature.feeRateBps
        });
        const expectedRebateAskBps = estimateExpectedMakerRebateBps({
          marketProfile,
          shares: askSize,
          price: askPx,
          rebateShareAssumption: this.config.rebateShareAssumption ?? 0.05,
          feeRateBps: feature.feeRateBps
        });
        const localBidScoring = estimateLocalOrderScoring({
          mid,
          price: bidPx,
          size: bidSize,
          rewardsMinSize: feature.rewardsMinSize,
          rewardsMaxSpread: feature.rewardsMaxSpread,
          rewardsRatesJson: feature.rewardsRatesJson
        });
        const localAskScoring = estimateLocalOrderScoring({
          mid,
          price: askPx,
          size: askSize,
          rewardsMinSize: feature.rewardsMinSize,
          rewardsMaxSpread: feature.rewardsMaxSpread,
          rewardsRatesJson: feature.rewardsRatesJson
        });
        const expectedLiquidityBidBps = localBidScoring ? (this.config.liquidityRewardBpsWhenScoring ?? 1) : 0;
        const expectedLiquidityAskBps = localAskScoring ? (this.config.liquidityRewardBpsWhenScoring ?? 1) : 0;

        const bidCost = computeCostBreakdown({
          role: "MAKER",
          side: "BUY",
          midPx: mid,
          quotePx: bidPx,
          spreadPx: spread,
          sizeShares: bidSize,
          marketProfile,
          feeRateBps: feature.feeRateBps,
          slippageBps: this.config.slippageBps,
          adverseSelectionBps: this.config.adverseSelectionBps,
          queueLossBps: this.config.queueLossBps,
          rebateBps: expectedRebateBidBps > 0 ? 0 : this.config.rebateBps,
          expectedRebateBps: expectedRebateBidBps,
          expectedLiquidityRewardsBps: expectedLiquidityBidBps,
          inventoryPenaltyBps: invPenaltyBid
        });
        const askCost = computeCostBreakdown({
          role: "MAKER",
          side: "SELL",
          midPx: mid,
          quotePx: askPx,
          spreadPx: spread,
          sizeShares: askSize,
          marketProfile,
          feeRateBps: feature.feeRateBps,
          slippageBps: this.config.slippageBps,
          adverseSelectionBps: this.config.adverseSelectionBps,
          queueLossBps: this.config.queueLossBps,
          rebateBps: expectedRebateAskBps > 0 ? 0 : this.config.rebateBps,
          expectedRebateBps: expectedRebateAskBps,
          expectedLiquidityRewardsBps: expectedLiquidityAskBps,
          inventoryPenaltyBps: invPenaltyAsk
        });

        const bidDirectionalEdge = ((pHat - bidPx) / mid) * 10_000;
        const askDirectionalEdge = ((askPx - pHat) / mid) * 10_000;
        const bidEvDecision = decideMakerExpectedEv({
          side: "BUY",
          pHat,
          midPx: mid,
          quotePx: bidPx,
          spreadPx: spread,
          sizeShares: bidSize,
          marketProfile,
          feeRateBps: feature.feeRateBps,
          slippageBps: this.config.slippageBps,
          adverseSelectionBps: this.config.adverseSelectionBps,
          queueLossBps: this.config.queueLossBps,
          rebateBps: expectedRebateBidBps > 0 ? 0 : this.config.rebateBps,
          expectedRebateBps: expectedRebateBidBps,
          expectedLiquidityRewardsBps: expectedLiquidityBidBps,
          inventoryPenaltyBps: invPenaltyBid,
          fillProbability: fillProbBid,
          minExpectedEvBps: this.config.minExpectedEvBps
        });
        const askEvDecision = decideMakerExpectedEv({
          side: "SELL",
          pHat,
          midPx: mid,
          quotePx: askPx,
          spreadPx: spread,
          sizeShares: askSize,
          marketProfile,
          feeRateBps: feature.feeRateBps,
          slippageBps: this.config.slippageBps,
          adverseSelectionBps: this.config.adverseSelectionBps,
          queueLossBps: this.config.queueLossBps,
          rebateBps: expectedRebateAskBps > 0 ? 0 : this.config.rebateBps,
          expectedRebateBps: expectedRebateAskBps,
          expectedLiquidityRewardsBps: expectedLiquidityAskBps,
          inventoryPenaltyBps: invPenaltyAsk,
          fillProbability: fillProbAsk,
          minExpectedEvBps: this.config.minExpectedEvBps
        });

        const bidMarketGate = evaluateWalletMarketGate(wallet.marketGate, {
          marketId: feature.marketId,
          marketVolumeUsd: feature.marketVolumeUsd,
          marketLiquidityUsd: feature.marketLiquidityUsd,
          marketActive: feature.marketActive === 1,
          kind: "MAKER_BID"
        });
        const askMarketGate = evaluateWalletMarketGate(wallet.marketGate, {
          marketId: feature.marketId,
          marketVolumeUsd: feature.marketVolumeUsd,
          marketLiquidityUsd: feature.marketLiquidityUsd,
          marketActive: feature.marketActive === 1,
          kind: "MAKER_ASK"
        });
        const bidEdgeSanity = validateEdgeCostSanity({
          predEdgeBps: bidDirectionalEdge,
          netEdgeBps: bidEvDecision.expectedEvBps,
          cost: bidCost
        });
        const askEdgeSanity = validateEdgeCostSanity({
          predEdgeBps: askDirectionalEdge,
          netEdgeBps: askEvDecision.expectedEvBps,
          cost: askCost
        });

        const canBid =
          this.config.enableBidQuotes &&
          bidRegime.allowed &&
          bidEvDecision.ok &&
          bidMarketGate.ok &&
          bidEdgeSanity.ok &&
          position + bidSize <= effectiveMaxInvBid;
        const canAsk =
          this.config.enableAskQuotes &&
          askRegime.allowed &&
          askEvDecision.ok &&
          askMarketGate.ok &&
          askEdgeSanity.ok &&
          position - askSize >= -effectiveMaxInvAsk;

        if (!bidRegime.allowed) {
          if (openBidOrder) {
            await this.cancelOpenOrder(openBidOrder, ts);
          }
          this.logSkipDecision({
            ts,
            tokenId: feature.tokenId,
            walletId: wallet.walletId,
            kind: "MAKER_BID",
            decisionReason: `regime_block:${bidRegime.reasonCode}`,
            mid,
            spread,
            bid,
            ask,
            bidDepth,
            askDepth,
            pHat,
            size: bidSize
          });
        }

        if (!askRegime.allowed) {
          if (openAskOrder) {
            await this.cancelOpenOrder(openAskOrder, ts);
          }
          this.logSkipDecision({
            ts,
            tokenId: feature.tokenId,
            walletId: wallet.walletId,
            kind: "MAKER_ASK",
            decisionReason: `regime_block:${askRegime.reasonCode}`,
            mid,
            spread,
            bid,
            ask,
            bidDepth,
            askDepth,
            pHat,
            size: askSize
          });
        }

        if (canBid) {
          await this.upsertMakerSide({
            ts,
            walletId: wallet.walletId,
            tokenId: feature.tokenId,
            marketId: feature.marketId,
            side: "BUY",
            kind: "MAKER_BID",
            price: bidPx,
            size: bidSize,
            mid,
            spread,
            bid,
            ask,
            bidDepth,
            askDepth,
            prior,
            predEdgeBps: bidDirectionalEdge,
            netEdgeBps: bidEvDecision.expectedEvBps,
            cost: bidCost,
            invBefore: position,
            invAfter: position + bidSize,
            openOrder: openBidOrder,
            marketProfile,
            feeRateBps: feature.feeRateBps,
            localScoring: localBidScoring,
            shadowOnly: isShadowOnlyProfile(marketProfile),
            regimeDecision: bidRegime,
            spreadDebug: {
              baseHalfSpreadBps,
              effectiveHalfSpreadBps
            }
          });
        }

        if (canAsk) {
          await this.upsertMakerSide({
            ts,
            walletId: wallet.walletId,
            tokenId: feature.tokenId,
            marketId: feature.marketId,
            side: "SELL",
            kind: "MAKER_ASK",
            price: askPx,
            size: askSize,
            mid,
            spread,
            bid,
            ask,
            bidDepth,
            askDepth,
            prior,
            predEdgeBps: askDirectionalEdge,
            netEdgeBps: askEvDecision.expectedEvBps,
            cost: askCost,
            invBefore: position,
            invAfter: position - askSize,
            openOrder: openAskOrder,
            marketProfile,
            feeRateBps: feature.feeRateBps,
            localScoring: localAskScoring,
            shadowOnly: isShadowOnlyProfile(marketProfile),
            regimeDecision: askRegime,
            spreadDebug: {
              baseHalfSpreadBps,
              effectiveHalfSpreadBps
            }
          });
        }
      }
    }
  }

  private async upsertMakerSide(input: {
    ts: number;
    walletId: number;
    tokenId: string;
    marketId: string | null;
    side: "BUY" | "SELL";
    kind: "MAKER_BID" | "MAKER_ASK";
    price: number;
    size: number;
    mid: number;
    spread: number;
    bid: number;
    ask: number;
    bidDepth: number;
    askDepth: number;
    prior: { source: string; probability: number };
    predEdgeBps: number;
    netEdgeBps: number;
    cost: ReturnType<typeof computeCostBreakdown>;
    invBefore: number;
    invAfter: number;
    openOrder: OpenOrderRow | null;
    marketProfile: MarketProfile;
    feeRateBps: number | null;
    localScoring: boolean;
    shadowOnly: boolean;
    regimeDecision: RegimeDecision;
    spreadDebug: {
      baseHalfSpreadBps: number;
      effectiveHalfSpreadBps: number;
    };
  }): Promise<void> {
    if (
      input.openOrder?.price != null &&
      input.openOrder?.size != null &&
      Number.isFinite(input.openOrder.price) &&
      Number.isFinite(input.openOrder.size)
    ) {
      const priceDriftBps = Math.abs(((input.price - (input.openOrder.price as number)) / input.mid) * 10_000);
      const sizeDrift = Math.abs(input.size - (input.openOrder.size as number)) / Math.max(1, input.size);
      if (priceDriftBps <= this.config.priceToleranceBps && sizeDrift <= 0.1) {
        return;
      }
      await this.cancelOpenOrder(input.openOrder, input.ts);
    }

    const decisionGroupId = toDecisionGroupId();
    let clientOrderId = `${decisionGroupId}:${input.walletId}`;
    let externalOrderId: string | null = null;
    const shouldAttemptLive =
      this.config.executionMode === "FULL" && this.deps.execution?.isEnabled() && !input.shadowOnly;
    let status: string = shouldAttemptLive ? "PENDING" : "OPEN";
    let filledSize = 0;
    let filledPrice: number | null = null;
    let scoringEligible = input.localScoring;
    let scoringSource: "api" | "local" = "local";
    const liveExecution = this.deps.execution;

    if (shouldAttemptLive && liveExecution) {
      const result = await liveExecution.placeMakerOrder({
        walletId: input.walletId,
        tokenId: input.tokenId,
        side: input.side,
        price: input.price,
        size: input.size,
        kind: input.kind,
        reason: "maker_expected_ev",
        decisionGroupId,
        feeRateBps: input.feeRateBps,
        postOnly: true
      });
      if (!result) return;
      clientOrderId = result.clientOrderId;
      externalOrderId = result.externalOrderId;
      status = result.status ?? status;
      filledSize = finiteOr(result.filledSize, 0);
      filledPrice = result.filledPrice;

      if (externalOrderId) {
        const scoring = await liveExecution.checkOrderScoring(externalOrderId);
        if (typeof scoring === "boolean") {
          scoringEligible = scoring;
          scoringSource = "api";
        }
      }
    }

    const decisionReason = [
      "maker_ev_above_threshold",
      `profile=${input.marketProfile}`,
      `scoring=${scoringEligible ? "1" : "0"}`,
      `scoring_source=${scoringSource}`,
      `shadow_only=${input.shadowOnly ? "1" : "0"}`,
      `regime_mode=${input.regimeDecision.mode}`,
      `regime_reason=${input.regimeDecision.reasonCode}`,
      `regime_size_multiplier=${input.regimeDecision.sizeMultiplier.toFixed(4)}`,
      `half_spread_bps_base=${input.spreadDebug.baseHalfSpreadBps.toFixed(4)}`,
      `half_spread_bps_effective=${input.spreadDebug.effectiveHalfSpreadBps.toFixed(4)}`
    ].join(";");

    const orderRow = {
      ts: input.ts,
      walletId: input.walletId,
      tokenId: input.tokenId,
      marketId: input.marketId,
      side: input.side,
      kind: input.kind,
      price: input.price,
      size: input.size,
      expectedCancelTs: input.ts + this.config.orderTtlMs,
      executionMode: shouldAttemptLive ? "FULL" : "SHADOW",
      source: "maker_loop",
      clientOrderId,
      externalOrderId,
      status,
      filledSize,
      filledPrice,
      lastUpdateTs: input.ts,
      strategyLane: "MAKER",
      decisionGroupId,
      predSource: input.prior.source,
      predEdgeBps: input.predEdgeBps,
      spreadBps: input.cost.spreadBps,
      feesBps: input.cost.feeBps,
      expectedSlippageBps: input.cost.slippageBps,
      expectedAdverseBps: input.cost.adverseSelectionBps,
      expectedQueueBps: input.cost.queueLossBps,
      costBps: input.cost.totalCostBps,
      netEdgeBps: input.netEdgeBps,
      decision: "SUBMIT",
      decisionReason,
      midPx: input.mid,
      spreadPx: input.spread,
      bidPx: input.bid,
      askPx: input.ask,
      bidDepth: input.bidDepth,
      askDepth: input.askDepth,
      inventoryIBefore: input.invBefore,
      inventoryIAfter: input.invAfter,
      inventoryDeltaAbs: Math.abs(input.invAfter) - Math.abs(input.invBefore),
      inventoryPenaltyBps: input.cost.inventoryPenaltyBps,
      priorPHat: input.prior.probability
    };

    const decisionRow = {
      ts: input.ts,
      tokenId: input.tokenId,
      walletId: input.walletId,
      kind: input.kind,
      strategyLane: "MAKER",
      decisionGroupId,
      decision: "SUBMIT",
      decisionReason,
      predEdgeBps: input.predEdgeBps,
      costBps: input.cost.totalCostBps,
      netEdgeBps: input.netEdgeBps,
      spreadBps: input.cost.spreadBps,
      feesBps: input.cost.feeBps,
      expectedSlippageBps: input.cost.slippageBps,
      midPx: input.mid,
      spreadPx: input.spread,
      deltaHat: input.prior.probability - input.mid,
      size: input.size,
      bidPx: input.bid,
      askPx: input.ask,
      bidDepth: input.bidDepth,
      askDepth: input.askDepth
    };
    this.insertSubmitOrderAndDecisionTx(orderRow, decisionRow);
  }

  private logSkipDecision(input: {
    ts: number;
    tokenId: string;
    walletId: number;
    kind: "MAKER_BID" | "MAKER_ASK";
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
    if (input.decisionReason === "maker_flow_gate_no_trades") {
      // Keep heartbeat visibility per wallet; global dedupe masks active wallets as stalled.
      const key = `${input.walletId}:${input.tokenId}:${input.kind}:${input.decisionReason}`;
      const lastTs = this.flowGateSkipLogTs.get(key) ?? 0;
      if (input.ts - lastTs < 300_000) return;
      this.flowGateSkipLogTs.set(key, input.ts);
    }

    const decisionGroupId = `${input.kind.toLowerCase()}:skip:${input.ts}:${input.walletId}`;
    this.insertDecisionLogStmt.run({
      ts: input.ts,
      tokenId: input.tokenId,
      walletId: input.walletId,
      kind: input.kind,
      strategyLane: "MAKER",
      decisionGroupId,
      decision: "SKIP",
      decisionReason: input.decisionReason,
      predEdgeBps: null,
      costBps: null,
      netEdgeBps: null,
      spreadBps: bps(input.spread / input.mid),
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
    kind: "MAKER_BID" | "MAKER_ASK",
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
      lane: "maker",
      executionMode: this.config.executionMode
    });
  }

  private resolveRegimeSizeMultiplier(raw: number): number {
    const modulation = this.config.regimeModulation!;
    if (!modulation.enabled) return 1;
    return clamp(raw, modulation.sizeMultiplierMin, modulation.sizeMultiplierMax);
  }

  private loadRecentTradeCounts(nowTs: number): RecentTradeCounts | null {
    const gate = this.config.tradeFlowGate;
    if (!gate?.enabled) return null;
    const sinceTs = nowTs - Math.max(1, gate.lookbackSec) * 1000;
    const byToken = new Map<string, number>();
    const byMarket = new Map<string, number>();
    try {
      const tokenRows = this.selectRecentTradeCountsStmt.all(sinceTs) as Array<{
        tokenId: string;
        tradeCount: number;
      }>;
      for (const row of tokenRows) {
        byToken.set(row.tokenId, finiteOr(row.tradeCount, 0));
      }
      const marketRows = this.selectRecentMarketTradeCountsStmt.all(sinceTs) as Array<{
        marketId: string | null;
        tradeCount: number;
      }>;
      for (const row of marketRows) {
        if (typeof row.marketId !== "string" || row.marketId.length === 0) continue;
        byMarket.set(row.marketId, finiteOr(row.tradeCount, 0));
      }
    } catch {
      return null;
    }
    return { byToken, byMarket };
  }

  private shouldCancelOnFlowGate(order: OpenOrderRow | null, nowTs: number): boolean {
    if (!order) return false;
    const gate = this.config.tradeFlowGate;
    if (!gate?.enabled) return false;
    if (gate.mode === "IMMEDIATE_CANCEL") return true;
    const ageSec = (nowTs - order.ts) / 1000;
    if (ageSec >= gate.staleCancelAgeSec) return true;
    return order.expectedCancelTs != null && order.expectedCancelTs <= nowTs;
  }

  private async cancelOpenOrder(order: OpenOrderRow, ts: number): Promise<void> {
    if (this.config.executionMode === "FULL" && this.deps.execution?.isEnabled() && order.externalOrderId) {
      await this.deps.execution.cancelOrder(order.externalOrderId);
    }
    this.cancelOrderStmt.run({ id: order.id, lastUpdateTs: ts });
  }

  private loadInventoryMap(): Map<string, number> {
    const rows = this.selectInventoryStmt.all() as Array<{
      walletId: number;
      tokenId: string;
      position: number | null;
    }>;
    const out = new Map<string, number>();
    for (const row of rows) {
      out.set(`${row.walletId}:${row.tokenId}`, finiteOr(row.position, 0));
    }
    return out;
  }

  private loadOpenOrderMap(): Map<string, OpenOrderRow> {
    const rows = this.selectActiveOrdersStmt.all() as OpenOrderRow[];
    const out = new Map<string, OpenOrderRow>();
    for (const row of rows) {
      out.set(`${row.walletId}:${row.tokenId}:${row.side}`, row);
    }
    return out;
  }
}
