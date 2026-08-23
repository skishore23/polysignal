import type { Logger } from "../logger";
import type { LiveExecutionGateway } from "../execution/clobExecution";

export type ArbLeg = {
  tokenId: string;
  marketId: string | null;
  side: "BUY" | "SELL";
  price: number;
  size: number;
};

export type ExecuteArbRequest = {
  ts: number;
  opportunityId: number;
  decisionGroupId: string;
  expectedNetEdgeBps: number;
  legs: ArbLeg[];
  shadowOnly?: boolean;
};

type ArbExecutorConfig = {
  executionMode: "PAPER" | "FULL";
  orderTtlMs: number;
  maxBatchOrders: number;
};

type ArbExecutorDeps = {
  sqlite: any;
  logger: Logger;
  execution?: LiveExecutionGateway;
};

const toKind = (side: "BUY" | "SELL"): "TAKER_BUY" | "TAKER_SELL" =>
  side === "BUY" ? "TAKER_BUY" : "TAKER_SELL";
const ARB_WALLET_FALLBACK_NAME = "Core · Arb";
const ARB_WALLET_PREFIX = "BTC 5m · Arb ";
const ARB_WALLET_CACHE_TTL_MS = 60_000;

export class ArbExecutor {
  private readonly config: ArbExecutorConfig;
  private readonly deps: ArbExecutorDeps;
  private readonly selectExistingExecutionStmt: any;
  private readonly insertExecutionStmt: any;
  private readonly retryFailedExecutionStmt: any;
  private readonly updateExecutionStmt: any;
  private readonly insertShadowOrderStmt: any;
  private readonly selectArbWalletsStmt: any | null;
  private readonly selectFallbackArbWalletStmt: any | null;
  private readonly insertFallbackArbWalletStmt: any | null;
  private arbWalletIdsCache: number[] | null = null;
  private arbWalletIdsCacheTs = 0;

  constructor(config: ArbExecutorConfig, deps: ArbExecutorDeps) {
    this.config = config;
    this.deps = deps;
    this.selectExistingExecutionStmt = deps.sqlite.prepare(
      `SELECT id, status
       FROM arb_executions
       WHERE opportunity_id = ?
       ORDER BY id DESC
       LIMIT 1`
    );
    this.insertExecutionStmt = deps.sqlite.prepare(
      `INSERT INTO arb_executions
       (ts, opportunity_id, decision_group_id, status, expected_net_edge_bps, leg_count, realized_pnl, error)
       VALUES (@ts, @opportunityId, @decisionGroupId, @status, @expectedNetEdgeBps, @legCount, @realizedPnl, @error)`
    );
    this.retryFailedExecutionStmt = deps.sqlite.prepare(
      `UPDATE arb_executions
       SET ts = @ts,
           decision_group_id = @decisionGroupId,
           status = @status,
           expected_net_edge_bps = @expectedNetEdgeBps,
           leg_count = @legCount,
           realized_pnl = @realizedPnl,
           error = @error
       WHERE id = @id`
    );
    this.updateExecutionStmt = deps.sqlite.prepare(
      `UPDATE arb_executions
       SET status = @status,
           realized_pnl = @realizedPnl,
           error = @error
       WHERE id = @id`
    );
    this.insertShadowOrderStmt = deps.sqlite.prepare(
      `INSERT INTO shadow_orders
       (ts, wallet_id, token_id, market_id, side, kind, price, size, expected_cancel_ts, execution_mode, source,
        client_order_id, external_order_id, status, filled_size, filled_price, last_update_ts, strategy_lane,
        decision_group_id, pred_source, decision, decision_reason, net_edge_bps)
       VALUES (@ts, @walletId, @tokenId, @marketId, @side, @kind, @price, @size, @expectedCancelTs, @executionMode, @source,
               @clientOrderId, @externalOrderId, @status, @filledSize, @filledPrice, @lastUpdateTs, @strategyLane,
               @decisionGroupId, @predSource, @decision, @decisionReason, @netEdgeBps)`
    );
    try {
      this.selectArbWalletsStmt = deps.sqlite.prepare(
        `SELECT id
         FROM wallets
         WHERE name LIKE ?
         ORDER BY id ASC`
      );
      this.selectFallbackArbWalletStmt = deps.sqlite.prepare(
        `SELECT id
         FROM wallets
         WHERE name = ?
         LIMIT 1`
      );
      this.insertFallbackArbWalletStmt = deps.sqlite.prepare(
        `INSERT INTO wallets
         (name, auto_trade_enabled, taker_side, maker_enabled, created_at)
         VALUES (?, 0, 'NONE', 0, ?)`
      );
    } catch {
      this.selectArbWalletsStmt = null;
      this.selectFallbackArbWalletStmt = null;
      this.insertFallbackArbWalletStmt = null;
    }
  }

  private resolveArbWalletIds(forceRefresh = false): number[] {
    const now = Date.now();
    if (!forceRefresh && this.arbWalletIdsCache != null && now - this.arbWalletIdsCacheTs < ARB_WALLET_CACHE_TTL_MS) {
      return this.arbWalletIdsCache;
    }
    if (!this.selectArbWalletsStmt || !this.selectFallbackArbWalletStmt || !this.insertFallbackArbWalletStmt) {
      return [];
    }

    try {
      const scopedRows = this.selectArbWalletsStmt.all(`${ARB_WALLET_PREFIX}%`) as Array<{ id: number }> | undefined;
      const scopedIds = (scopedRows ?? [])
        .map((row) => Number(row.id))
        .filter((id) => Number.isFinite(id) && id > 0);
      if (scopedIds.length > 0) {
        this.arbWalletIdsCache = scopedIds;
        this.arbWalletIdsCacheTs = now;
        return this.arbWalletIdsCache;
      }

      const existing = this.selectFallbackArbWalletStmt.get(ARB_WALLET_FALLBACK_NAME) as { id: number } | undefined;
      if (existing?.id != null && Number.isFinite(existing.id) && existing.id > 0) {
        this.arbWalletIdsCache = [Number(existing.id)];
        this.arbWalletIdsCacheTs = now;
        return this.arbWalletIdsCache;
      }

      try {
        const res = this.insertFallbackArbWalletStmt.run(ARB_WALLET_FALLBACK_NAME, Date.now());
        const insertedId = Number(res.lastInsertRowid);
        if (Number.isFinite(insertedId) && insertedId > 0) {
          this.arbWalletIdsCache = [insertedId];
          this.arbWalletIdsCacheTs = now;
          this.deps.logger.info({ arbWalletId: insertedId }, "Created ARB attribution wallet");
          return this.arbWalletIdsCache;
        }
      } catch {
        const raceExisting = this.selectFallbackArbWalletStmt.get(ARB_WALLET_FALLBACK_NAME) as
          | { id: number }
          | undefined;
        if (raceExisting?.id != null && Number.isFinite(raceExisting.id) && raceExisting.id > 0) {
          this.arbWalletIdsCache = [Number(raceExisting.id)];
          this.arbWalletIdsCacheTs = now;
          return this.arbWalletIdsCache;
        }
      }
    } catch (err) {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to resolve ARB attribution wallet; falling back to null wallet_id"
      );
    }
    this.arbWalletIdsCache = [];
    this.arbWalletIdsCacheTs = now;
    return this.arbWalletIdsCache;
  }

  private pickArbWalletId(decisionGroupId: string): number | null {
    let walletIds = this.resolveArbWalletIds();
    if (walletIds.length === 0) {
      walletIds = this.resolveArbWalletIds(true);
    }
    if (walletIds.length === 0) return null;
    if (walletIds.length === 1) return walletIds[0] ?? null;
    let hash = 0;
    for (let i = 0; i < decisionGroupId.length; i += 1) {
      hash = (hash * 31 + decisionGroupId.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % walletIds.length;
    return walletIds[idx] ?? walletIds[0] ?? null;
  }

  public async execute(request: ExecuteArbRequest): Promise<boolean> {
    if (!request.legs.length) return false;
    if (request.legs.length > this.config.maxBatchOrders) return false;
    const arbWalletId = this.pickArbWalletId(request.decisionGroupId);
    if (arbWalletId == null) {
      this.deps.logger.warn(
        { opportunityId: request.opportunityId, decisionGroupId: request.decisionGroupId },
        "Skipping ARB execution: attribution wallet unresolved"
      );
      return false;
    }

    const existing = this.selectExistingExecutionStmt.get(request.opportunityId) as
      | { id: number; status: string | null }
      | undefined;
    if (existing && existing.status && existing.status !== "FAILED") {
      return false;
    }

    let executionId = 0;
    if (existing?.id != null && existing.status === "FAILED") {
      executionId = Number(existing.id);
      this.retryFailedExecutionStmt.run({
        id: executionId,
        ts: request.ts,
        decisionGroupId: request.decisionGroupId,
        status: "QUEUED",
        expectedNetEdgeBps: request.expectedNetEdgeBps,
        legCount: request.legs.length,
        realizedPnl: null,
        error: null
      });
    } else {
      const executionRes = this.insertExecutionStmt.run({
        ts: request.ts,
        opportunityId: request.opportunityId,
        decisionGroupId: request.decisionGroupId,
        status: "QUEUED",
        expectedNetEdgeBps: request.expectedNetEdgeBps,
        legCount: request.legs.length,
        realizedPnl: null,
        error: null
      });
      executionId = Number(executionRes.lastInsertRowid);
    }

    try {
      const shouldAttemptLive = this.config.executionMode === "FULL" &&
        this.deps.execution?.isEnabled() &&
        request.shadowOnly !== true;
      const liveExecution = this.deps.execution;
      let acceptedLiveAcks = 0;
      if (shouldAttemptLive && liveExecution) {
        const responses = await liveExecution.batchPlaceOrders(
          request.legs.map((leg) => ({
            walletId: arbWalletId,
            tokenId: leg.tokenId,
            side: leg.side,
            price: leg.price,
            size: leg.size,
            kind: toKind(leg.side),
            reason: "arb_execution",
            decisionGroupId: request.decisionGroupId,
            postOnly: false
          }))
        );
        for (const [i, leg] of request.legs.entries()) {
          const response = responses[i] ?? null;
          if (
            response?.status &&
            (response.status === "PENDING" ||
              response.status === "OPEN" ||
              response.status === "PARTIAL" ||
              response.status === "FILLED")
          ) {
            acceptedLiveAcks += 1;
          }
          this.insertShadowOrderStmt.run({
            ts: request.ts,
            walletId: arbWalletId,
            tokenId: leg.tokenId,
            marketId: leg.marketId,
            side: leg.side,
            kind: toKind(leg.side),
            price: leg.price,
            size: leg.size,
            expectedCancelTs: request.ts + this.config.orderTtlMs,
            executionMode: shouldAttemptLive ? "FULL" : "SHADOW",
            source: "arb_executor",
            clientOrderId: response?.clientOrderId ?? `${request.decisionGroupId}:${i}`,
            externalOrderId: response?.externalOrderId ?? null,
            status: response?.status ?? "PENDING",
            filledSize: response?.filledSize ?? 0,
            filledPrice: response?.filledPrice ?? null,
            lastUpdateTs: request.ts,
            strategyLane: "ARB",
            decisionGroupId: request.decisionGroupId,
            predSource: "arb",
            decision: "SUBMIT",
            decisionReason: request.shadowOnly ? "arb_trigger_shadow_only_profile" : "arb_trigger",
            netEdgeBps: request.expectedNetEdgeBps
          });
        }
        if (acceptedLiveAcks <= 0) {
          this.updateExecutionStmt.run({
            id: executionId,
            status: "FAILED",
            realizedPnl: null,
            error: "live_batch_rejected_or_unacknowledged"
          });
          this.deps.logger.warn(
            { opportunityId: request.opportunityId, decisionGroupId: request.decisionGroupId },
            "ARB live batch had no accepted acknowledgements"
          );
          return false;
        }
      } else {
        for (const [i, leg] of request.legs.entries()) {
          this.insertShadowOrderStmt.run({
            ts: request.ts,
            walletId: arbWalletId,
            tokenId: leg.tokenId,
            marketId: leg.marketId,
            side: leg.side,
            kind: toKind(leg.side),
            price: leg.price,
            size: leg.size,
            expectedCancelTs: request.ts + this.config.orderTtlMs,
            executionMode: "SHADOW",
            source: "arb_executor",
            clientOrderId: `${request.decisionGroupId}:${i}`,
            externalOrderId: null,
            status: "OPEN",
            filledSize: 0,
            filledPrice: null,
            lastUpdateTs: request.ts,
            strategyLane: "ARB",
            decisionGroupId: request.decisionGroupId,
            predSource: "arb",
            decision: "SUBMIT",
            decisionReason: request.shadowOnly ? "arb_trigger_shadow_only_profile" : "arb_trigger",
            netEdgeBps: request.expectedNetEdgeBps
          });
        }
      }

      this.updateExecutionStmt.run({
        id: executionId,
        status: "SUBMITTED",
        realizedPnl: null,
        error: null
      });
      return true;
    } catch (err) {
      this.updateExecutionStmt.run({
        id: executionId,
        status: "FAILED",
        realizedPnl: null,
        error: err instanceof Error ? err.message : String(err)
      });
      this.deps.logger.warn(
        { opportunityId: request.opportunityId, err: err instanceof Error ? err.message : String(err) },
        "Arb execution failed"
      );
      return false;
    }
  }
}
