import type { Logger } from "../logger";
import { TaskScheduler } from "../utils/TaskScheduler";
import {
  canTransitionOrderStatus,
  isActiveOrderStatus,
  normalizeOrderStatus,
  type CanonicalOrderStatus
} from "../execution/orderStateMachine";
import { classifyMarketProfile } from "../trading/MarketProfile";
import { computeFeeEquivalentUsdc, getMakerRebatePoolPct } from "../trading/PolymarketFeeMath";

type ShadowConfig = {
  intervalMs: number;
  makerStalenessSec: number;
  markoutHorizonsMs: number[];
  makerQueueFillProb: number;
  makerPriceToleranceBps: number;
  forceSyntheticFills?: boolean;
  syntheticFillIntervalMs?: number;
  rebalanceEnabled?: boolean;
  rebalanceIntervalMs?: number;
  rebalanceTriggerFraction?: number;
  rebalanceTargetFraction?: number;
  /** How often to refresh the summary table (ms). Default: 15000 (15s) */
  summaryRefreshIntervalMs?: number;
  /** How often to recompute maker metrics cache (ms). Default: 120000 (2m) */
  makerMetricsRefreshIntervalMs?: number;
  /** Max real maker fills processed per metrics refresh. Default: 20000 */
  makerMetricsFillLimit?: number;
  /** Window hours for summary aggregation. Default: 24 */
  summaryWindowHours?: number;
};

type ShadowDeps = {
  sqlite: any;
  logger: Logger;
};

type TradePayload = {
  price?: number;
  size?: number;
  side?: "BUY" | "SELL";
  timestamp?: number;
};

type MakerFillRow = {
  walletId: number;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  ts: number;
  feeRateBps: number | null;
  marketQuestion: string | null;
  marketSlug: string | null;
  eventTitle: string | null;
  takerBaseFee: number | null;
};

type MakerState = {
  walletId: number;
  tokenId: string;
  position: number;
  avgEntry: number;
  realized: number;
};

const DEFAULT_MARKOUT_HORIZONS_MS = [1000, 5000, 30000, 300000];
const FILL_EPS = 1e-9;

/**
 * Deterministic hash -> [0,1) sampler used to avoid Math.random() path dependence
 * in shadow fill simulation.
 */
const deterministicUnitSample = (...parts: Array<string | number>): number => {
  const input = parts.map((p) => String(p)).join("|");
  let hash = 2166136261 >>> 0; // FNV-1a 32-bit
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
};

export class ShadowExecutionLoop {
  private readonly config: ShadowConfig;
  private readonly deps: ShadowDeps;
  private readonly scheduler: TaskScheduler;
  private readonly selectStateStmt: any;
  private readonly upsertStateStmt: any;
  private readonly selectTradesStmt: any;
  private readonly selectMakerOrdersStmt: any;
  private readonly selectMakerCrossCandidatesStmt: any;
  private readonly selectTakerOrdersStmt: any;
  private readonly selectOrderLifecycleStmt: any;
  private readonly updateOrderLifecycleStmt: any;
  private readonly insertFillStmt: any;
  private readonly selectFillBatchStmt: any;
  private readonly selectMarkoutCandidatesStmt: any;
  private readonly insertMarkoutStmt: any;
  private readonly selectMidBeforeStmt: any;
  private readonly selectMidAfterStmt: any;
  private readonly selectAnyMakerOrderStmt: any;
  private readonly upsertSummaryStmt: any;
  private readonly upsertMakerMetricsStmt: any;
  private readonly selectRebalancePositionsStmt: any;
  private readonly selectWalletLimitsStmt: any;
  private readonly selectLatestMidStmt: any;
  private readonly insertShadowOrderStmt: any;
  private lastSyntheticFillTs = 0;
  private lastSummaryRefreshTs = 0;
  private lastMakerMetricsRefreshTs = 0;
  private lastRebalanceTs = 0;

  constructor(config: ShadowConfig, deps: ShadowDeps) {
    this.config = {
      ...config,
      markoutHorizonsMs: config.markoutHorizonsMs?.length ? config.markoutHorizonsMs : DEFAULT_MARKOUT_HORIZONS_MS,
      makerQueueFillProb: Number.isFinite(config.makerQueueFillProb) ? config.makerQueueFillProb : 1,
      makerPriceToleranceBps: Number.isFinite(config.makerPriceToleranceBps) ? config.makerPriceToleranceBps : 0,
      forceSyntheticFills: config.forceSyntheticFills ?? true,
      syntheticFillIntervalMs: config.syntheticFillIntervalMs ?? 30_000,
      rebalanceEnabled: config.rebalanceEnabled ?? true,
      rebalanceIntervalMs: config.rebalanceIntervalMs ?? 60_000,
      rebalanceTriggerFraction: config.rebalanceTriggerFraction ?? 0.6,
      rebalanceTargetFraction: config.rebalanceTargetFraction ?? 0.2,
      summaryRefreshIntervalMs: config.summaryRefreshIntervalMs ?? 15_000,
      makerMetricsRefreshIntervalMs: config.makerMetricsRefreshIntervalMs ?? 120_000,
      makerMetricsFillLimit: Number.isFinite(config.makerMetricsFillLimit)
        ? Math.max(1000, Math.floor(config.makerMetricsFillLimit as number))
        : 20_000
    };
    this.deps = deps;

    this.selectStateStmt = this.deps.sqlite.prepare(
      "SELECT last_trade_seq as lastTradeSeq, last_fill_id as lastFillId FROM shadow_state WHERE id = 1"
    );
    this.upsertStateStmt = this.deps.sqlite.prepare(
      `INSERT INTO shadow_state (id, last_trade_seq, last_fill_id)
       VALUES (1, @lastTradeSeq, @lastFillId)
       ON CONFLICT(id) DO UPDATE SET
         last_trade_seq = excluded.last_trade_seq,
         last_fill_id = excluded.last_fill_id`
    );
    this.selectTradesStmt = this.deps.sqlite.prepare(
      `SELECT global_seq as globalSeq, recv_ts_ms as recvTsMs, token_id as tokenId, payload_json as payloadJson
       FROM clob_events
       WHERE msg_type = 'trade' AND global_seq > ?
       ORDER BY global_seq ASC
       LIMIT 1000`
    );
    this.selectMakerOrdersStmt = this.deps.sqlite.prepare(
      `SELECT id, ts, expected_cancel_ts as expectedCancelTs, price, size, side, kind,
              status, filled_size as filledSize, filled_price as filledPrice
       FROM shadow_orders
       WHERE token_id = ?
         AND kind IN ('MAKER_BID', 'MAKER_ASK')
         AND execution_mode = 'SHADOW'
         AND ts <= ?
         AND expected_cancel_ts IS NOT NULL
         AND expected_cancel_ts >= ?
      ORDER BY ts DESC
      LIMIT 200`
    );
    this.selectMakerCrossCandidatesStmt = this.deps.sqlite.prepare(
      `SELECT o.id, o.ts, o.token_id as tokenId, o.kind, o.side, o.price, o.size,
              o.status as status, o.filled_size as filledSize, o.filled_price as filledPrice,
              o.expected_cancel_ts as expectedCancelTs,
              lf.ts as featureTs, lf.best_bid as bestBid, lf.best_ask as bestAsk
       FROM shadow_orders o
       JOIN latest_features lf ON lf.token_id = o.token_id
       WHERE o.kind IN ('MAKER_BID', 'MAKER_ASK')
         AND o.execution_mode = 'SHADOW'
         AND o.ts <= @now
         AND (o.expected_cancel_ts IS NULL OR o.expected_cancel_ts >= @now)
         AND COALESCE(o.status, 'OPEN') IN ('OPEN', 'PENDING', 'PARTIAL')
       ORDER BY o.ts DESC
       LIMIT 5000`
    );
    this.selectAnyMakerOrderStmt = this.deps.sqlite.prepare(
      `SELECT id, ts, expected_cancel_ts as expectedCancelTs, price, size, side,
              status, filled_size as filledSize, filled_price as filledPrice
       FROM shadow_orders
       WHERE kind IN ('MAKER_BID', 'MAKER_ASK')
         AND execution_mode = 'SHADOW'
         AND expected_cancel_ts IS NOT NULL
         AND expected_cancel_ts >= ?
         AND ts <= ?
       ORDER BY ts DESC
       LIMIT 1`
    );
    this.selectTakerOrdersStmt = this.deps.sqlite.prepare(
      `SELECT id, ts, price, size, side, status, filled_size as filledSize, filled_price as filledPrice
       FROM shadow_orders
       WHERE kind IN ('TAKER_BUY', 'TAKER_SELL')
         AND execution_mode = 'SHADOW'
         AND COALESCE(status, 'OPEN') IN ('OPEN', 'PENDING', 'PARTIAL')
       ORDER BY ts ASC
       LIMIT 5000`
    );
    this.selectOrderLifecycleStmt = this.deps.sqlite.prepare(
      `SELECT id, size, status, filled_size as filledSize, filled_price as filledPrice
       FROM shadow_orders
       WHERE id = ?`
    );
    this.updateOrderLifecycleStmt = this.deps.sqlite.prepare(
      `UPDATE shadow_orders
       SET status = @status,
           filled_size = @filledSize,
           filled_price = @filledPrice,
           last_update_ts = @lastUpdateTs
       WHERE id = @id`
    );
    this.insertFillStmt = this.deps.sqlite.prepare(
      `INSERT INTO shadow_fills (ts, order_id, price, size, method, note)
       VALUES (@ts, @orderId, @price, @size, @method, @note)`
    );
    this.selectFillBatchStmt = this.deps.sqlite.prepare(
      `SELECT f.id, f.ts, f.price, f.size, f.method, o.token_id as tokenId, o.side as side
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE f.id > ?
         AND o.execution_mode = 'SHADOW'
       ORDER BY f.id ASC
       LIMIT 500`
    );
    this.selectMarkoutCandidatesStmt = this.deps.sqlite.prepare(
      `SELECT f.id, f.ts, f.price, f.size, f.method, o.token_id as tokenId, o.side as side
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       LEFT JOIN shadow_markouts m ON m.fill_id = f.id AND m.horizon_ms = @horizonMs
       WHERE m.id IS NULL
         AND o.execution_mode = 'SHADOW'
         AND f.ts <= @cutoff
       ORDER BY f.id ASC
       LIMIT @limit`
    );
    this.insertMarkoutStmt = this.deps.sqlite.prepare(
      `INSERT INTO shadow_markouts
       (fill_id, ts, horizon_ms, mid_at_fill, mid_at_horizon, markout_bps)
       VALUES (@fillId, @ts, @horizonMs, @midAtFill, @midAtHorizon, @markoutBps)`
    );
    this.selectMidBeforeStmt = this.deps.sqlite.prepare(
      `SELECT mid FROM features WHERE token_id = ? AND ts <= ? AND mid IS NOT NULL ORDER BY ts DESC LIMIT 1`
    );
    this.selectMidAfterStmt = this.deps.sqlite.prepare(
      `SELECT mid FROM features WHERE token_id = ? AND ts >= ? AND mid IS NOT NULL ORDER BY ts ASC LIMIT 1`
    );
    this.selectRebalancePositionsStmt = this.deps.sqlite.prepare(
      `SELECT o.wallet_id as walletId, o.token_id as tokenId,
              SUM(CASE WHEN o.side = 'BUY' THEN f.size ELSE -f.size END) as position
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE o.kind IN ('MAKER_BID','MAKER_ASK','INVENTORY_REBALANCE')
         AND o.execution_mode = 'SHADOW'
         AND f.method != 'synthetic_fill'
       GROUP BY o.wallet_id, o.token_id`
    );
    this.selectWalletLimitsStmt = this.deps.sqlite.prepare(
      `SELECT id as walletId, maker_inventory_target as target, maker_inventory_max_abs as maxAbs
       FROM wallets`
    );
    this.selectLatestMidStmt = this.deps.sqlite.prepare(
      `SELECT mid, market_id as marketId FROM latest_features WHERE token_id = ?`
    );
    this.insertShadowOrderStmt = this.deps.sqlite.prepare(
      `INSERT INTO shadow_orders
       (ts, wallet_id, token_id, market_id, side, kind, price, size, expected_cancel_ts, execution_mode, source,
        client_order_id, external_order_id, status, filled_size, filled_price, last_update_ts, book_snapshot_json,
        pred_source, decision)
       VALUES (@ts, @walletId, @tokenId, @marketId, @side, @kind, @price, @size, @expectedCancelTs, @executionMode, @source,
               @clientOrderId, @externalOrderId, @status, @filledSize, @filledPrice, @lastUpdateTs, @bookSnapshotJson,
               'synthetic', 'SUBMIT')`
    );

    this.upsertSummaryStmt = this.deps.sqlite.prepare(`
      INSERT INTO shadow_summary_latest (
        id, updated_ts, window_hours,
        maker_orders, maker_fills, maker_real_fills, maker_synthetic_fills,
        maker_markout_5s_bps, maker_markout_30s_bps, maker_last_ts,
        taker_orders, taker_fills, taker_real_fills, taker_synthetic_fills,
        taker_markout_5s_bps, taker_markout_30s_bps, taker_last_ts
      ) VALUES (
        1, @updatedTs, @windowHours,
        @makerOrders, @makerFills, @makerRealFills, @makerSyntheticFills,
        @makerMarkout5s, @makerMarkout30s, @makerLastTs,
        @takerOrders, @takerFills, @takerRealFills, @takerSyntheticFills,
        @takerMarkout5s, @takerMarkout30s, @takerLastTs
      )
      ON CONFLICT(id) DO UPDATE SET
        updated_ts = excluded.updated_ts,
        window_hours = excluded.window_hours,
        maker_orders = excluded.maker_orders,
        maker_fills = excluded.maker_fills,
        maker_real_fills = excluded.maker_real_fills,
        maker_synthetic_fills = excluded.maker_synthetic_fills,
        maker_markout_5s_bps = excluded.maker_markout_5s_bps,
        maker_markout_30s_bps = excluded.maker_markout_30s_bps,
        maker_last_ts = excluded.maker_last_ts,
        taker_orders = excluded.taker_orders,
        taker_fills = excluded.taker_fills,
        taker_real_fills = excluded.taker_real_fills,
        taker_synthetic_fills = excluded.taker_synthetic_fills,
        taker_markout_5s_bps = excluded.taker_markout_5s_bps,
        taker_markout_30s_bps = excluded.taker_markout_30s_bps,
        taker_last_ts = excluded.taker_last_ts
    `);

    this.upsertMakerMetricsStmt = this.deps.sqlite.prepare(`
      INSERT INTO shadow_maker_metrics_latest (
        wallet_id, updated_ts, window_hours,
        open_positions, total_realized, total_unrealized, fill_count,
        long_exposure, short_exposure,
        maker_volume_24h, fee_equivalent_24h, rebate_upper_bound_24h, rebate_pool_pct
      ) VALUES (
        @walletId, @updatedTs, @windowHours,
        @openPositions, @totalRealized, @totalUnrealized, @fillCount,
        @longExposure, @shortExposure,
        @makerVolume24h, @feeEquivalent24h, @rebateUpperBound24h, @rebatePoolPct
      )
      ON CONFLICT(wallet_id) DO UPDATE SET
        updated_ts = excluded.updated_ts,
        window_hours = excluded.window_hours,
        open_positions = excluded.open_positions,
        total_realized = excluded.total_realized,
        total_unrealized = excluded.total_unrealized,
        fill_count = excluded.fill_count,
        long_exposure = excluded.long_exposure,
        short_exposure = excluded.short_exposure,
        maker_volume_24h = excluded.maker_volume_24h,
        fee_equivalent_24h = excluded.fee_equivalent_24h,
        rebate_upper_bound_24h = excluded.rebate_upper_bound_24h,
        rebate_pool_pct = excluded.rebate_pool_pct
    `);

    this.scheduler = new TaskScheduler(() => this.tick(), {
      name: "ShadowExecutionLoop",
      intervalMs: this.config.intervalMs,
      logger: this.deps.logger
    });
  }

  public start(): void {
    this.deps.logger.info("Starting ShadowExecutionLoop...");
    this.scheduler.start();
  }

  public stop(): void {
    this.scheduler.stop();
  }

  private async tick(): Promise<void> {
    try {
      this.processTakerOrders();
      this.processBookCrosses();
      this.processTrades();
      this.simulateSyntheticFillsIfIdle();
      this.simulateInventoryRebalance();
      this.processMarkouts();
      this.refreshSummaryIfNeeded();
    } catch (err) {
      this.deps.logger.warn({ err: String(err) }, "Shadow execution loop error");
    }
  }

  private ensureState(): { lastTradeSeq: number; lastFillId: number } {
    const row = this.selectStateStmt.get() as { lastTradeSeq: number; lastFillId: number } | undefined;
    if (row) return row;
    this.upsertStateStmt.run({ lastTradeSeq: 0, lastFillId: 0 });
    return { lastTradeSeq: 0, lastFillId: 0 };
  }

  private resolveNextStatus(
    currentStatus: CanonicalOrderStatus | null,
    filledSize: number,
    totalSize: number | null
  ): CanonicalOrderStatus {
    if (totalSize != null && filledSize >= totalSize - FILL_EPS) {
      return "FILLED";
    }
    if (filledSize > FILL_EPS) {
      return "PARTIAL";
    }
    return currentStatus ?? "OPEN";
  }

  private isOrderOpenForFill(order: {
    status: string | null;
    size: number | null;
    filledSize: number | null;
  }): boolean {
    const status = normalizeOrderStatus(order.status);
    if (!isActiveOrderStatus(status)) return false;
    if (!Number.isFinite(order.size) || (order.size as number) <= 0) return true;
    const size = order.size as number;
    const filledSize = Number.isFinite(order.filledSize) ? (order.filledSize as number) : 0;
    return filledSize < size - FILL_EPS;
  }

  private appendFill(args: {
    orderId: number;
    ts: number;
    price: number;
    size: number;
    method: string;
    note: string;
  }): boolean {
    if (!Number.isFinite(args.price) || !Number.isFinite(args.size) || args.size <= FILL_EPS) {
      return false;
    }

    const row = this.selectOrderLifecycleStmt.get(args.orderId) as
      | {
          id: number;
          size: number | null;
          status: string | null;
          filledSize: number | null;
          filledPrice: number | null;
        }
      | undefined;
    if (!row) return false;

    const currentStatus = normalizeOrderStatus(row.status);
    if (!isActiveOrderStatus(currentStatus)) return false;

    const totalSize = Number.isFinite(row.size) && (row.size as number) > 0 ? (row.size as number) : null;
    const prevFilled = Number.isFinite(row.filledSize) ? (row.filledSize as number) : 0;
    const remaining = totalSize != null ? Math.max(0, totalSize - prevFilled) : args.size;
    const acceptedSize = Math.min(args.size, remaining);
    if (acceptedSize <= FILL_EPS) return false;

    const nextFilledSize = prevFilled + acceptedSize;
    const prevFilledPrice = Number.isFinite(row.filledPrice) ? (row.filledPrice as number) : null;
    const nextFilledPrice =
      prevFilledPrice != null && prevFilled > FILL_EPS
        ? (prevFilledPrice * prevFilled + args.price * acceptedSize) / nextFilledSize
        : args.price;
    const desiredStatus = this.resolveNextStatus(currentStatus, nextFilledSize, totalSize);
    if (!canTransitionOrderStatus(currentStatus, desiredStatus)) {
      this.deps.logger.warn(
        { orderId: args.orderId, fromStatus: currentStatus, toStatus: desiredStatus },
        "Shadow fill status transition blocked"
      );
      return false;
    }

    this.insertFillStmt.run({
      ts: args.ts,
      orderId: args.orderId,
      price: args.price,
      size: acceptedSize,
      method: args.method,
      note: args.note
    });

    this.updateOrderLifecycleStmt.run({
      id: args.orderId,
      status: desiredStatus,
      filledSize: nextFilledSize,
      filledPrice: Number.isFinite(nextFilledPrice) ? nextFilledPrice : null,
      lastUpdateTs: args.ts
    });
    return true;
  }

  private processTakerOrders(): void {
    const orders = this.selectTakerOrdersStmt.all() as Array<{
      id: number;
      ts: number;
      price: number | null;
      size: number | null;
      side: "BUY" | "SELL";
      status: string | null;
      filledSize: number | null;
      filledPrice: number | null;
    }>;
    if (!orders.length) return;

    for (const order of orders) {
      if (order.price == null || order.size == null) continue;
      if (!this.isOrderOpenForFill(order)) continue;
      this.appendFill({
        ts: order.ts,
        orderId: order.id,
        price: order.price,
        size: order.size,
        method: "taker_immediate",
        note: "shadow"
      });
    }
  }

  private processTrades(): void {
    const state = this.ensureState();
    const trades = this.selectTradesStmt.all(state.lastTradeSeq) as Array<{
      globalSeq: number;
      recvTsMs: number;
      tokenId: string;
      payloadJson: string;
    }>;
    if (!trades.length) return;

    let lastSeq = state.lastTradeSeq;
    const maxStalenessMs = Math.max(1000, (this.config.makerStalenessSec ?? 5) * 1000);

    for (const trade of trades) {
      lastSeq = Math.max(lastSeq, trade.globalSeq);
      const parsed = this.parseTrade(trade.payloadJson);
      if (!parsed || parsed.price == null || parsed.size == null || !parsed.side) continue;
      const tradeTs = parsed.timestamp ?? trade.recvTsMs;

      const orders = this.selectMakerOrdersStmt.all(trade.tokenId, tradeTs, tradeTs) as Array<{
        id: number;
        ts: number;
        expectedCancelTs: number;
        price: number | null;
        size: number | null;
        side: "BUY" | "SELL";
        kind: "MAKER_BID" | "MAKER_ASK";
        status: string | null;
        filledSize: number | null;
        filledPrice: number | null;
      }>;

      if (!orders.length) continue;

      for (const order of orders) {
        if (order.price == null || order.size == null) continue;
        if (!this.isOrderOpenForFill(order)) continue;
        if (tradeTs - order.ts > maxStalenessMs) continue;

        const isBid = order.kind === "MAKER_BID";
        const tol = (this.config.makerPriceToleranceBps / 10000) * order.price;
        const priceCross = isBid ? parsed.price <= order.price + tol : parsed.price >= order.price - tol;
        const sideOk = isBid ? parsed.side === "SELL" : parsed.side === "BUY";
        if (!priceCross || !sideOk) continue;

        if (this.config.makerQueueFillProb < 1) {
          const roll = deterministicUnitSample(
            "trade_match",
            trade.globalSeq,
            order.id,
            order.price ?? 0,
            order.size ?? 0
          );
          if (roll > this.config.makerQueueFillProb) continue;
        }

        const fillSize = Math.min(order.size, parsed.size);
        this.appendFill({
          ts: tradeTs,
          orderId: order.id,
          price: order.price,
          size: fillSize,
          method: "trade_match",
          note: `trade_seq=${trade.globalSeq}`
        });
      }
    }

    this.upsertStateStmt.run({ lastTradeSeq: lastSeq, lastFillId: state.lastFillId });
  }

  private processBookCrosses(): void {
    const now = Date.now();
    const maxStalenessMs = Math.max(1000, (this.config.makerStalenessSec ?? 5) * 1000);
    const tolBps = Math.max(0, this.config.makerPriceToleranceBps ?? 0);

    const rows = this.selectMakerCrossCandidatesStmt.all({ now }) as Array<{
      id: number;
      ts: number;
      tokenId: string;
      kind: "MAKER_BID" | "MAKER_ASK";
      side: "BUY" | "SELL";
      price: number | null;
      size: number | null;
      status: string | null;
      filledSize: number | null;
      filledPrice: number | null;
      expectedCancelTs: number | null;
      featureTs: number | null;
      bestBid: number | null;
      bestAsk: number | null;
    }>;
    if (!rows.length) return;

    for (const row of rows) {
      if (row.price == null || row.size == null) continue;
      if (!this.isOrderOpenForFill(row)) continue;
      if (row.featureTs == null || now - row.featureTs > maxStalenessMs) continue;
      if (row.expectedCancelTs != null && row.expectedCancelTs < now) continue;

      const tol = (tolBps / 10000) * row.price;
      const crossed =
        row.kind === "MAKER_BID"
          ? row.bestAsk != null && row.bestAsk <= row.price + tol
          : row.bestBid != null && row.bestBid >= row.price - tol;
      if (!crossed) continue;

      if (this.config.makerQueueFillProb < 1) {
        const roll = deterministicUnitSample("book_cross", row.id, row.tokenId, row.featureTs ?? now, row.price);
        if (roll > this.config.makerQueueFillProb) continue;
      }

      this.appendFill({
        ts: now,
        orderId: row.id,
        price: row.price,
        size: row.size,
        method: "book_cross",
        note: `feature_ts=${row.featureTs ?? now}`
      });
    }
  }

  private simulateSyntheticFillsIfIdle(): void {
    if (!this.config.forceSyntheticFills) return;
    const now = Date.now();
    const interval = this.config.syntheticFillIntervalMs ?? 30_000;
    if (now - this.lastSyntheticFillTs < interval) return;

    const orders = this.selectAnyMakerOrderStmt.all(now, now) as Array<{
      id: number;
      price: number | null;
      size: number | null;
      side: "BUY" | "SELL";
      status: string | null;
      filledSize: number | null;
      filledPrice: number | null;
    }>;
    if (!orders.length) return;

    const order = orders[0];
    if (!order || order.price == null || order.size == null) return;
    if (!this.isOrderOpenForFill(order)) return;

    if (this.config.makerQueueFillProb < 1) {
      const tickBucket = Math.floor(now / interval);
      const roll = deterministicUnitSample("synthetic_fill", tickBucket, order.id, order.price, order.size);
      if (roll > this.config.makerQueueFillProb) return;
    }

    if (
      this.appendFill({
        ts: now,
        orderId: order.id,
        price: order.price,
        size: order.size,
        method: "synthetic_fill",
        note: "Shadow synthetic fill"
      })
    ) {
      this.lastSyntheticFillTs = now;
    }
  }

  private simulateInventoryRebalance(): void {
    if (!this.config.rebalanceEnabled) return;
    const now = Date.now();
    const interval = this.config.rebalanceIntervalMs ?? 60_000;
    if (now - this.lastRebalanceTs < interval) return;

    const triggerFrac = this.config.rebalanceTriggerFraction ?? 0.6;
    const targetFrac = this.config.rebalanceTargetFraction ?? 0.2;
    if (triggerFrac <= 0 || targetFrac < 0 || targetFrac >= triggerFrac) {
      return;
    }

    const walletLimitsRows = this.selectWalletLimitsStmt.all() as Array<{
      walletId: number;
      target: number | null;
      maxAbs: number | null;
    }>;
    const walletLimits = new Map<number, { target: number; maxAbs: number }>();
    for (const row of walletLimitsRows) {
      const maxAbs = Number(row.maxAbs ?? 0);
      if (!Number.isFinite(maxAbs) || maxAbs <= 0) continue;
      walletLimits.set(row.walletId, {
        target: Number(row.target ?? 0),
        maxAbs
      });
    }
    if (walletLimits.size === 0) return;

    const positions = this.selectRebalancePositionsStmt.all() as Array<{
      walletId: number;
      tokenId: string;
      position: number | null;
    }>;
    if (!positions.length) return;

    for (const posRow of positions) {
      const limits = walletLimits.get(posRow.walletId);
      if (!limits) continue;
      const position = Number(posRow.position ?? 0);
      if (!Number.isFinite(position)) continue;

      const maxAbs = limits.maxAbs;
      const target = limits.target ?? 0;
      const delta = position - target;
      const absDelta = Math.abs(delta);
      const trigger = maxAbs * triggerFrac;
      const targetAbs = maxAbs * targetFrac;
      if (absDelta <= trigger) continue;

      const desiredAbs = Math.max(targetAbs, 0);
      const rebalanceSize = absDelta - desiredAbs;
      if (rebalanceSize <= 0) continue;

      const midRow = this.selectLatestMidStmt.get(posRow.tokenId) as
        | { mid: number | null; marketId: string | null }
        | undefined;
      const mid = midRow?.mid ?? null;
      if (!Number.isFinite(mid) || !mid || mid <= 0) continue;

      const side = delta > 0 ? "SELL" : "BUY";
      const order = {
        ts: now,
        walletId: posRow.walletId,
        tokenId: posRow.tokenId,
        marketId: midRow?.marketId ?? null,
        side,
        kind: "INVENTORY_REBALANCE",
        price: mid,
        size: rebalanceSize,
        expectedCancelTs: null,
        executionMode: "SHADOW",
        source: "inventory_rebalance",
        clientOrderId: null,
        externalOrderId: null,
        status: "OPEN",
        filledSize: 0,
        filledPrice: null,
        lastUpdateTs: null,
        bookSnapshotJson: null
      };

      const res = this.insertShadowOrderStmt.run(order);
      const orderId = Number(res.lastInsertRowid);
      if (!orderId || !Number.isFinite(orderId)) continue;

      this.appendFill({
        ts: now,
        orderId,
        price: mid,
        size: rebalanceSize,
        method: "inventory_rebalance",
        note: "Shadow inventory rebalance"
      });
    }

    this.lastRebalanceTs = now;
  }

  private processMarkouts(): void {
    const now = Date.now();
    const horizons = this.config.markoutHorizonsMs ?? [];
    if (!horizons.length) return;

    for (const horizonMs of horizons) {
      const cutoff = now - horizonMs;
      const fills = this.selectMarkoutCandidatesStmt.all({
        horizonMs,
        cutoff,
        limit: 500
      }) as Array<{
        id: number;
        ts: number;
        price: number | null;
        size: number | null;
        method: string | null;
        tokenId: string;
        side: "BUY" | "SELL";
      }>;
      if (!fills.length) continue;

      for (const fill of fills) {
        const midFillRow = this.selectMidBeforeStmt.get(fill.tokenId, fill.ts) as { mid: number } | undefined;
        const midAtFillRaw = midFillRow?.mid ?? null;
        const midAtFill =
          midAtFillRaw != null && Number.isFinite(midAtFillRaw) && midAtFillRaw > 0 ? midAtFillRaw : null;

        const targetTs = fill.ts + horizonMs;
        const midAfterRow = this.selectMidAfterStmt.get(fill.tokenId, targetTs) as { mid: number } | undefined;
        const midAtHorizonRaw = midAfterRow?.mid ?? null;
        const midAtHorizon =
          midAtHorizonRaw != null && Number.isFinite(midAtHorizonRaw) && midAtHorizonRaw > 0 ? midAtHorizonRaw : null;

        const canComputeMarkout =
          midAtFill != null &&
          midAtHorizon != null &&
          Number.isFinite(midAtFill) &&
          Number.isFinite(midAtHorizon) &&
          midAtFill > 0;
        const markoutBps = canComputeMarkout
          ? (fill.side === "BUY" ? (midAtHorizon - midAtFill) / midAtFill : (midAtFill - midAtHorizon) / midAtFill) *
            10000
          : null;

        this.insertMarkoutStmt.run({
          fillId: fill.id,
          ts: fill.ts,
          horizonMs,
          midAtFill,
          midAtHorizon,
          markoutBps
        });
      }
    }
  }

  private refreshSummaryIfNeeded(): void {
    const now = Date.now();
    const interval = this.config.summaryRefreshIntervalMs ?? 15_000;
    if (now - this.lastSummaryRefreshTs < interval) return;

    this.lastSummaryRefreshTs = now;
    const windowHours = this.config.summaryWindowHours ?? 24;
    const since = now - windowHours * 60 * 60 * 1000;

    const summary = this.computeShadowSummary(since, windowHours);
    this.upsertSummaryStmt.run(summary);
    const makerMetricsInterval = this.config.makerMetricsRefreshIntervalMs ?? 120_000;
    if (now - this.lastMakerMetricsRefreshTs < makerMetricsInterval) return;
    this.lastMakerMetricsRefreshTs = now;
    this.refreshMakerMetricsCache(windowHours);
  }

  private computeShadowSummary(
    since: number,
    windowHours: number
  ): {
    updatedTs: number;
    windowHours: number;
    makerOrders: number;
    makerFills: number;
    makerRealFills: number;
    makerSyntheticFills: number;
    makerMarkout5s: number | null;
    makerMarkout30s: number | null;
    makerLastTs: number | null;
    takerOrders: number;
    takerFills: number;
    takerRealFills: number;
    takerSyntheticFills: number;
    takerMarkout5s: number | null;
    takerMarkout30s: number | null;
    takerLastTs: number | null;
  } {
    const sqlite = this.deps.sqlite;

    const makerOrders = (
      sqlite
        .prepare(
          `SELECT COUNT(*) as c FROM shadow_orders
       WHERE ts >= ? AND kind IN ('MAKER_BID','MAKER_ASK') AND execution_mode = 'SHADOW'`
        )
        .get(since) as { c: number }
    ).c;

    const makerFillsRow = sqlite
      .prepare(
        `
      SELECT 
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN f.method != 'synthetic_fill' THEN 1 ELSE 0 END), 0) as real_fills
      FROM shadow_fills f
      JOIN shadow_orders o ON o.id = f.order_id
      WHERE f.ts >= ? AND o.kind IN ('MAKER_BID','MAKER_ASK') AND o.execution_mode = 'SHADOW'
    `
      )
      .get(since) as { total: number; real_fills: number };

    const makerFills = makerFillsRow.total ?? 0;
    const makerRealFills = makerFillsRow.real_fills ?? 0;
    const makerSyntheticFills = Math.max(0, makerFills - makerRealFills);

    const takerOrders = (
      sqlite
        .prepare(
          `SELECT COUNT(*) as c FROM shadow_orders
       WHERE ts >= ? AND kind IN ('TAKER_BUY','TAKER_SELL') AND execution_mode = 'SHADOW'`
        )
        .get(since) as { c: number }
    ).c;

    const takerFillsRow = sqlite
      .prepare(
        `
      SELECT 
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN f.method != 'synthetic_fill' THEN 1 ELSE 0 END), 0) as real_fills
      FROM shadow_fills f
      JOIN shadow_orders o ON o.id = f.order_id
      WHERE f.ts >= ? AND o.kind IN ('TAKER_BUY','TAKER_SELL') AND o.execution_mode = 'SHADOW'
    `
      )
      .get(since) as { total: number; real_fills: number };

    const takerFills = takerFillsRow.total ?? 0;
    const takerRealFills = takerFillsRow.real_fills ?? 0;
    const takerSyntheticFills = Math.max(0, takerFills - takerRealFills);

    const makerMarkout5s = (
      sqlite
        .prepare(
          `
      SELECT AVG(m.markout_bps) as avg_bps
      FROM shadow_markouts m
      JOIN shadow_fills f ON f.id = m.fill_id
      JOIN shadow_orders o ON o.id = f.order_id
      WHERE m.horizon_ms = 5000 AND m.ts >= ? AND o.kind IN ('MAKER_BID','MAKER_ASK')
        AND o.execution_mode = 'SHADOW'
    `
        )
        .get(since) as { avg_bps: number | null }
    ).avg_bps;

    const makerMarkout30s = (
      sqlite
        .prepare(
          `
      SELECT AVG(m.markout_bps) as avg_bps
      FROM shadow_markouts m
      JOIN shadow_fills f ON f.id = m.fill_id
      JOIN shadow_orders o ON o.id = f.order_id
      WHERE m.horizon_ms = 30000 AND m.ts >= ? AND o.kind IN ('MAKER_BID','MAKER_ASK')
        AND o.execution_mode = 'SHADOW'
    `
        )
        .get(since) as { avg_bps: number | null }
    ).avg_bps;

    const takerMarkout5s = (
      sqlite
        .prepare(
          `
      SELECT AVG(m.markout_bps) as avg_bps
      FROM shadow_markouts m
      JOIN shadow_fills f ON f.id = m.fill_id
      JOIN shadow_orders o ON o.id = f.order_id
      WHERE m.horizon_ms = 5000 AND m.ts >= ? AND o.kind IN ('TAKER_BUY','TAKER_SELL')
        AND o.execution_mode = 'SHADOW'
    `
        )
        .get(since) as { avg_bps: number | null }
    ).avg_bps;

    const takerMarkout30s = (
      sqlite
        .prepare(
          `
      SELECT AVG(m.markout_bps) as avg_bps
      FROM shadow_markouts m
      JOIN shadow_fills f ON f.id = m.fill_id
      JOIN shadow_orders o ON o.id = f.order_id
      WHERE m.horizon_ms = 30000 AND m.ts >= ? AND o.kind IN ('TAKER_BUY','TAKER_SELL')
        AND o.execution_mode = 'SHADOW'
    `
        )
        .get(since) as { avg_bps: number | null }
    ).avg_bps;

    const makerLastTs = (
      sqlite
        .prepare(
          `SELECT MAX(ts) as ts FROM shadow_orders
       WHERE kind IN ('MAKER_BID','MAKER_ASK') AND execution_mode = 'SHADOW'`
        )
        .get() as { ts: number | null }
    ).ts;

    const takerLastTs = (
      sqlite
        .prepare(
          `SELECT MAX(ts) as ts FROM shadow_orders
       WHERE kind IN ('TAKER_BUY','TAKER_SELL') AND execution_mode = 'SHADOW'`
        )
        .get() as { ts: number | null }
    ).ts;

    return {
      updatedTs: Date.now(),
      windowHours,
      makerOrders,
      makerFills,
      makerRealFills,
      makerSyntheticFills,
      makerMarkout5s: makerMarkout5s ?? null,
      makerMarkout30s: makerMarkout30s ?? null,
      makerLastTs: makerLastTs ?? null,
      takerOrders,
      takerFills,
      takerRealFills,
      takerSyntheticFills,
      takerMarkout5s: takerMarkout5s ?? null,
      takerMarkout30s: takerMarkout30s ?? null,
      takerLastTs: takerLastTs ?? null
    };
  }

  private parseTrade(payloadJson: string): TradePayload | null {
    try {
      const raw = JSON.parse(payloadJson) as Record<string, unknown>;
      const tsRaw = typeof raw.timestamp === "number" ? raw.timestamp : undefined;
      const tsMs = tsRaw != null ? (tsRaw < 1_000_000_000_000 ? tsRaw * 1000 : tsRaw) : undefined;
      return {
        price: typeof raw.price === "number" ? raw.price : Number(raw.price ?? NaN),
        size: typeof raw.size === "number" ? raw.size : Number(raw.size ?? NaN),
        side: raw.side === "SELL" ? "SELL" : raw.side === "BUY" ? "BUY" : undefined,
        timestamp: tsMs
      };
    } catch {
      return null;
    }
  }

  private applyShadowFill(state: MakerState, fill: MakerFillRow): MakerState {
    if (!Number.isFinite(fill.price) || !Number.isFinite(fill.size)) return state;
    const delta = fill.side === "BUY" ? fill.size : -fill.size;
    const nextPos = state.position + delta;

    if (state.position === 0) {
      return { ...state, position: nextPos, avgEntry: fill.price };
    }

    const sameDirection = (state.position > 0 && delta > 0) || (state.position < 0 && delta < 0);
    if (sameDirection) {
      const totalSize = Math.abs(state.position) + Math.abs(delta);
      const weightedAvg = (Math.abs(state.position) * state.avgEntry + Math.abs(delta) * fill.price) / totalSize;
      return { ...state, position: nextPos, avgEntry: weightedAvg };
    }

    const closingSize = Math.min(Math.abs(state.position), Math.abs(delta));
    const pnlPerUnit = state.position > 0 ? fill.price - state.avgEntry : state.avgEntry - fill.price;
    const realized = state.realized + pnlPerUnit * closingSize;
    const remaining = nextPos;

    if (remaining === 0) {
      return { ...state, position: 0, avgEntry: 0, realized };
    }

    return { ...state, position: remaining, avgEntry: fill.price, realized };
  }

  private computeShadowUnrealized(state: MakerState, mark: number): number {
    if (!Number.isFinite(mark) || mark <= 0) return 0;
    if (state.position === 0) return 0;
    return state.position > 0
      ? (mark - state.avgEntry) * state.position
      : (state.avgEntry - mark) * Math.abs(state.position);
  }

  private refreshMakerMetricsCache(windowHours: number): void {
    const sqlite = this.deps.sqlite;
    const tableExists = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shadow_maker_metrics_latest'")
      .get();
    if (!tableExists) return;

    const now = Date.now();
    const since = now - windowHours * 60 * 60 * 1000;
    const fillLimit = this.config.makerMetricsFillLimit ?? 20_000;

    const fillsDesc = sqlite
      .prepare(
        `SELECT
         o.wallet_id as walletId,
         o.token_id as tokenId,
         o.side as side,
         f.price as price,
         f.size as size,
         f.ts as ts,
         t.fee_rate_bps as feeRateBps,
         m.question as marketQuestion,
         m.slug as marketSlug,
         e.title as eventTitle,
         m.taker_base_fee as takerBaseFee
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       LEFT JOIN tokens t ON t.id = o.token_id
       LEFT JOIN markets m ON m.id = o.market_id
       LEFT JOIN market_events e ON e.id = m.event_id
       WHERE o.kind IN ('MAKER_BID','MAKER_ASK','INVENTORY_REBALANCE')
         AND o.execution_mode = 'SHADOW'
         AND f.method != 'synthetic_fill'
         AND f.ts >= @since
       ORDER BY f.ts DESC, f.id DESC
       LIMIT @limit`
      )
      .all({ since, limit: fillLimit }) as MakerFillRow[];
    const fills = fillsDesc.reverse();

    const states = new Map<string, MakerState>();
    const fillCountByWallet = new Map<number, number>();
    const volume24hByWallet = new Map<number, number>();
    const feeEq24hByWallet = new Map<number, number>();
    const rebateUpper24hByWallet = new Map<number, number>();

    for (const fill of fills) {
      const walletId = fill.walletId;
      fillCountByWallet.set(walletId, (fillCountByWallet.get(walletId) ?? 0) + 1);

      if (fill.ts >= since && Number.isFinite(fill.price) && Number.isFinite(fill.size)) {
        const volume = (volume24hByWallet.get(walletId) ?? 0) + fill.price * fill.size;
        volume24hByWallet.set(walletId, volume);
        const marketProfile = classifyMarketProfile({
          question: fill.marketQuestion,
          slug: fill.marketSlug,
          eventTitle: fill.eventTitle,
          feeRateBps: fill.feeRateBps,
          takerBaseFee: fill.takerBaseFee
        });
        const feeEquivalent = computeFeeEquivalentUsdc({
          marketProfile,
          shares: fill.size,
          price: fill.price,
          feeRateBps: fill.feeRateBps
        });
        if (feeEquivalent != null && Number.isFinite(feeEquivalent) && feeEquivalent > 0) {
          feeEq24hByWallet.set(walletId, (feeEq24hByWallet.get(walletId) ?? 0) + feeEquivalent);
          const rebatePoolPct = getMakerRebatePoolPct(marketProfile);
          if (rebatePoolPct > 0) {
            rebateUpper24hByWallet.set(
              walletId,
              (rebateUpper24hByWallet.get(walletId) ?? 0) + feeEquivalent * rebatePoolPct
            );
          }
        }
      }

      const key = `${walletId}:${fill.tokenId}`;
      const state = states.get(key) ?? {
        walletId,
        tokenId: fill.tokenId,
        position: 0,
        avgEntry: 0,
        realized: 0
      };
      states.set(key, this.applyShadowFill(state, fill));
    }

    const tokens = Array.from(new Set(Array.from(states.values()).map((s) => s.tokenId)));
    const marks = new Map<string, number>();
    if (tokens.length > 0) {
      const placeholders = tokens.map(() => "?").join(",");
      const rows = sqlite
        .prepare(
          `SELECT token_id as tokenId, mid
           FROM latest_features
           WHERE mid IS NOT NULL AND token_id IN (${placeholders})`
        )
        .all(...tokens) as Array<{ tokenId: string; mid: number }>;
      for (const row of rows) {
        if (Number.isFinite(row.mid)) {
          marks.set(row.tokenId, row.mid);
        }
      }
    }

    const metricsByWallet = new Map<
      number,
      {
        openPositions: number;
        totalRealized: number;
        totalUnrealized: number;
        longExposure: number;
        shortExposure: number;
      }
    >();

    for (const state of states.values()) {
      const metrics = metricsByWallet.get(state.walletId) ?? {
        openPositions: 0,
        totalRealized: 0,
        totalUnrealized: 0,
        longExposure: 0,
        shortExposure: 0
      };

      metrics.totalRealized += state.realized;
      if (state.position !== 0) {
        metrics.openPositions += 1;
      }

      const mark = marks.get(state.tokenId) ?? state.avgEntry;
      if (Number.isFinite(mark) && mark > 0) {
        if (state.position > 0) {
          metrics.longExposure += state.position * mark;
        } else if (state.position < 0) {
          metrics.shortExposure += Math.abs(state.position) * mark;
        }
        metrics.totalUnrealized += this.computeShadowUnrealized(state, mark);
      }

      metricsByWallet.set(state.walletId, metrics);
    }

    const walletRows = sqlite.prepare("SELECT id as walletId FROM wallets").all() as Array<{
      walletId: number;
    }>;
    const allWalletIds = walletRows.map((w) => w.walletId);

    const upsertRow = (
      walletId: number,
      metrics?: {
        openPositions: number;
        totalRealized: number;
        totalUnrealized: number;
        longExposure: number;
        shortExposure: number;
      }
    ) => {
      const fillCount = fillCountByWallet.get(walletId) ?? 0;
      const makerVolume24h = volume24hByWallet.get(walletId) ?? 0;
      const feeEquivalent24h = feeEq24hByWallet.get(walletId) ?? 0;
      const rebateUpperBound24h = rebateUpper24hByWallet.get(walletId) ?? 0;
      const rebatePoolPct = feeEquivalent24h > 0 ? rebateUpperBound24h / feeEquivalent24h : 0;
      this.upsertMakerMetricsStmt.run({
        walletId,
        updatedTs: now,
        windowHours,
        openPositions: metrics?.openPositions ?? 0,
        totalRealized: metrics?.totalRealized ?? 0,
        totalUnrealized: metrics?.totalUnrealized ?? 0,
        fillCount,
        longExposure: metrics?.longExposure ?? 0,
        shortExposure: metrics?.shortExposure ?? 0,
        makerVolume24h,
        feeEquivalent24h,
        rebateUpperBound24h,
        rebatePoolPct
      });
    };

    for (const walletId of allWalletIds) {
      upsertRow(walletId, metricsByWallet.get(walletId));
    }

    // Global aggregate (wallet_id = 0)
    const global = {
      openPositions: 0,
      totalRealized: 0,
      totalUnrealized: 0,
      longExposure: 0,
      shortExposure: 0
    };
    for (const metrics of metricsByWallet.values()) {
      global.openPositions += metrics.openPositions;
      global.totalRealized += metrics.totalRealized;
      global.totalUnrealized += metrics.totalUnrealized;
      global.longExposure += metrics.longExposure;
      global.shortExposure += metrics.shortExposure;
    }

    const globalFillCount = Array.from(fillCountByWallet.values()).reduce((sum, v) => sum + v, 0);
    const globalVolume24h = Array.from(volume24hByWallet.values()).reduce((sum, v) => sum + v, 0);
    const globalFeeEq24h = Array.from(feeEq24hByWallet.values()).reduce((sum, v) => sum + v, 0);
    const globalRebateUpper24h = Array.from(rebateUpper24hByWallet.values()).reduce((sum, v) => sum + v, 0);
    const globalRebatePoolPct = globalFeeEq24h > 0 ? globalRebateUpper24h / globalFeeEq24h : 0;
    this.upsertMakerMetricsStmt.run({
      walletId: 0,
      updatedTs: now,
      windowHours,
      openPositions: global.openPositions,
      totalRealized: global.totalRealized,
      totalUnrealized: global.totalUnrealized,
      fillCount: globalFillCount,
      longExposure: global.longExposure,
      shortExposure: global.shortExposure,
      makerVolume24h: globalVolume24h,
      feeEquivalent24h: globalFeeEq24h,
      rebateUpperBound24h: globalRebateUpper24h,
      rebatePoolPct: globalRebatePoolPct
    });
  }
}
