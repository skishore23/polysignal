import { randomUUID } from "node:crypto";
import type { Logger } from "../logger";
import { TaskScheduler } from "../utils/TaskScheduler";
import { computeBasketCostBps } from "../trading/CostModel";
import { ArbExecutor, type ArbLeg } from "./ArbExecutor";
import { classifyMarketProfile, isShadowOnlyProfile, type MarketScope } from "../trading/MarketProfile";
import { decideMarketProfileScope } from "../trading/DecisionEngine";

type ArbScannerConfig = {
  enabled?: boolean;
  intervalMs: number;
  minNetEdgeBps: number;
  maxNotionalUsd: number;
  maxConcurrentGroups: number;
  enableNegRisk: boolean;
  slippageBpsPerLeg: number;
  adverseSelectionBpsPerLeg: number;
  queueLossBpsPerLeg: number;
  rebateBpsPerLeg: number;
  marketScope?: MarketScope;
};

type ArbScannerDeps = {
  sqlite: any;
  logger: Logger;
  executor: ArbExecutor;
};

type TokenQuoteRow = {
  tokenId: string;
  marketId: string;
  outcome: string | null;
  marketQuestion: string | null;
  marketSlug: string | null;
  eventTitle: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  feeRateBps: number | null;
  takerBaseFee: number | null;
};

type NegRiskRow = TokenQuoteRow & {
  eventId: string;
};

const normalizeOutcome = (value: string | null): string => (value ?? "").trim().toLowerCase();

const isYesNoPair = (outcomes: string[]): boolean => outcomes.includes("yes") && outcomes.includes("no");

const isSqliteUniqueConstraint = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const withCode = err as { code?: unknown; message?: unknown };
  if (withCode.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  if (typeof withCode.message === "string" && withCode.message.includes("UNIQUE constraint failed")) return true;
  return false;
};

export class ArbScannerLoop {
  private readonly config: ArbScannerConfig;
  private readonly deps: ArbScannerDeps;
  private readonly scheduler: TaskScheduler;
  private readonly selectTokenQuotesStmt: any;
  private readonly selectNegRiskRowsStmt: any;
  private readonly selectArbWalletFiltersStmt: any | null;
  private readonly selectActiveExecutionCountStmt: any;
  private readonly insertOpportunityStmt: any;
  private readonly selectRecentOpportunityStmt: any;

  constructor(config: ArbScannerConfig, deps: ArbScannerDeps) {
    this.config = {
      ...config,
      enabled: config.enabled ?? true,
      marketScope: config.marketScope ?? "PROFILE_KNOWN_ONLY"
    };
    this.deps = deps;

    this.selectTokenQuotesStmt = deps.sqlite.prepare(
      `SELECT
         t.id as tokenId,
         t.market_id as marketId,
         COALESCE(t.outcome, t.name) as outcome,
         m.question as marketQuestion,
         m.slug as marketSlug,
         e.title as eventTitle,
         lf.best_bid as bestBid,
         lf.best_ask as bestAsk,
         lf.mid as mid,
         lf.spread as spread,
         t.fee_rate_bps as feeRateBps,
         m.taker_base_fee as takerBaseFee
       FROM tokens t
       JOIN latest_features lf ON lf.token_id = t.id
       JOIN markets m ON m.id = t.market_id
       LEFT JOIN market_events e ON e.id = m.event_id
       WHERE m.active = 1
         AND lf.best_bid IS NOT NULL
         AND lf.best_ask IS NOT NULL
         AND lf.mid IS NOT NULL`
    );

    this.selectNegRiskRowsStmt = deps.sqlite.prepare(
      `SELECT
         em.event_id as eventId,
         t.id as tokenId,
         t.market_id as marketId,
         COALESCE(t.outcome, t.name) as outcome,
         m.question as marketQuestion,
         m.slug as marketSlug,
         e.title as eventTitle,
         lf.best_bid as bestBid,
         lf.best_ask as bestAsk,
         lf.mid as mid,
         lf.spread as spread,
         t.fee_rate_bps as feeRateBps,
         m.taker_base_fee as takerBaseFee
       FROM event_markets em
       JOIN market_events e ON e.id = em.event_id
       JOIN tokens t ON t.market_id = em.market_id
       JOIN markets m ON m.id = t.market_id
       JOIN latest_features lf ON lf.token_id = t.id
       WHERE e.neg_risk = 1
         AND lf.best_bid IS NOT NULL
         AND lf.best_ask IS NOT NULL
         AND lf.mid IS NOT NULL`
    );
    try {
      this.selectArbWalletFiltersStmt = deps.sqlite.prepare(
        `SELECT market_filter_json as marketFilterJson
         FROM wallets
         WHERE name LIKE 'BTC 5m · Arb %'`
      );
    } catch {
      this.selectArbWalletFiltersStmt = null;
    }

    this.selectActiveExecutionCountStmt = deps.sqlite.prepare(
      `SELECT COUNT(*) as c
       FROM arb_executions
       WHERE status IN ('QUEUED', 'SUBMITTED', 'PARTIAL')`
    );

    this.insertOpportunityStmt = deps.sqlite.prepare(
      `INSERT OR IGNORE INTO arb_opportunities
       (ts, event_id, type, direction, token_ids_json, expected_payout, gross_edge_bps, expected_cost_bps, net_edge_bps, decision_group_id, details_json, fingerprint)
       VALUES (@ts, @eventId, @type, @direction, @tokenIdsJson, @expectedPayout, @grossEdgeBps, @expectedCostBps, @netEdgeBps, @decisionGroupId, @detailsJson, @fingerprint)`
    );

    this.selectRecentOpportunityStmt = deps.sqlite.prepare(
      `SELECT id
       FROM arb_opportunities
       WHERE fingerprint = ?
         AND ts >= ?
       ORDER BY id DESC
       LIMIT 1`
    );

    this.scheduler = new TaskScheduler(() => this.tick(), {
      name: "ArbScannerLoop",
      intervalMs: this.config.intervalMs,
      logger: this.deps.logger
    });
  }

  public start(): void {
    if (!this.config.enabled) {
      this.deps.logger.info("ArbScannerLoop disabled via config");
      return;
    }
    this.deps.logger.info({ marketScope: this.config.marketScope }, "Starting ArbScannerLoop...");
    this.scheduler.start();
  }

  public stop(): void {
    this.scheduler.stop();
  }

  private async tick(): Promise<void> {
    if (!this.config.enabled) return;
    const active = this.selectActiveExecutionCountStmt.get() as { c: number } | undefined;
    const activeGroups = Number(active?.c ?? 0);
    if (activeGroups >= this.config.maxConcurrentGroups) return;

    const now = Date.now();
    const arbPinnedMarketIds = this.loadArbPinnedMarketIds();
    const binary = await this.scanBinaryParity(now, arbPinnedMarketIds);
    const negRisk = this.config.enableNegRisk ? await this.scanNegRiskBaskets(now, arbPinnedMarketIds) : 0;
    if (binary + negRisk > 0) {
      this.deps.logger.info({ binary, negRisk }, "Arb scanner opportunities executed");
    }
  }

  private loadArbPinnedMarketIds(): Set<string> | null {
    if (!this.selectArbWalletFiltersStmt) return null;
    const rows = this.selectArbWalletFiltersStmt.all() as Array<{
      marketFilterJson?: string | null;
    }>;
    if (!rows.length) return null;
    const ids = new Set<string>();
    for (const row of rows) {
      const raw = row.marketFilterJson;
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { includeMarketIds?: unknown };
        if (!Array.isArray(parsed.includeMarketIds)) continue;
        for (const v of parsed.includeMarketIds) {
          const id = typeof v === "string" ? v.trim() : "";
          if (id.length > 0) ids.add(id);
        }
      } catch {
        // ignore invalid wallet filter payloads for scanner scoping
      }
    }
    return ids.size > 0 ? ids : null;
  }

  private async scanBinaryParity(now: number, pinnedMarketIds: Set<string> | null): Promise<number> {
    const rows = this.selectTokenQuotesStmt.all() as TokenQuoteRow[];
    if (!rows.length) return 0;

    const byMarket = new Map<string, TokenQuoteRow[]>();
    for (const row of rows) {
      if (pinnedMarketIds && !pinnedMarketIds.has(row.marketId)) continue;
      const arr = byMarket.get(row.marketId) ?? [];
      arr.push(row);
      byMarket.set(row.marketId, arr);
    }

    let executed = 0;
    for (const marketRows of byMarket.values()) {
      if (marketRows.length !== 2) continue;
      const outcomes = marketRows.map((r) => normalizeOutcome(r.outcome));
      if (!isYesNoPair(outcomes)) continue;
      executed += await this.processBasket({
        ts: now,
        type: "BINARY_PARITY",
        eventId: null,
        rows: marketRows
      });
    }
    return executed;
  }

  private async scanNegRiskBaskets(now: number, pinnedMarketIds: Set<string> | null): Promise<number> {
    const rows = this.selectNegRiskRowsStmt.all() as NegRiskRow[];
    if (!rows.length) return 0;

    const byEvent = new Map<string, NegRiskRow[]>();
    for (const row of rows) {
      if (pinnedMarketIds && !pinnedMarketIds.has(row.marketId)) continue;
      const arr = byEvent.get(row.eventId) ?? [];
      arr.push(row);
      byEvent.set(row.eventId, arr);
    }

    let executed = 0;
    for (const [eventId, eventRows] of byEvent.entries()) {
      if (eventRows.length < 2) continue;
      executed += await this.processBasket({
        ts: now,
        type: "NEG_RISK_BASKET",
        eventId,
        rows: eventRows
      });
    }
    return executed;
  }

  private async processBasket(input: {
    ts: number;
    type: "BINARY_PARITY" | "NEG_RISK_BASKET";
    eventId: string | null;
    rows: TokenQuoteRow[];
  }): Promise<number> {
    if (input.rows.length < 2 || new Set(input.rows.map((row) => row.tokenId)).size !== input.rows.length) return 0;
    const legsBuy: ArbLeg[] = [];
    const rowMeta = new Map<
      string,
      {
        mid: number;
        spread: number;
        feeRateBps: number | null;
        marketProfile: ReturnType<typeof classifyMarketProfile>;
      }
    >();
    let askSum = 0;
    let basketShadowOnly = false;

    for (const row of input.rows) {
      if (!Number.isFinite(row.bestAsk) || !Number.isFinite(row.bestBid) || !Number.isFinite(row.mid)) {
        return 0;
      }
      const ask = row.bestAsk as number;
      const bid = row.bestBid as number;
      const mid = row.mid as number;
      if (ask <= 0 || ask >= 1 || bid <= 0 || bid >= 1 || bid > ask || mid <= 0 || mid >= 1) return 0;
      const marketProfile = classifyMarketProfile({
        question: row.marketQuestion,
        slug: row.marketSlug,
        eventTitle: row.eventTitle,
        feeRateBps: row.feeRateBps,
        takerBaseFee: row.takerBaseFee
      });
      const scope = this.config.marketScope ?? "PROFILE_KNOWN_ONLY";
      const scopeDecision = decideMarketProfileScope(marketProfile, scope);
      const unknownAllowedForArb = scope === "ALL" && marketProfile === "UNKNOWN";
      const explicitFeeFree = marketProfile === "FEE_FREE" && row.feeRateBps === 0;
      if (!scopeDecision.ok && !unknownAllowedForArb && !explicitFeeFree) return 0;
      if (marketProfile === "UNKNOWN" && !unknownAllowedForArb) return 0;
      if (isShadowOnlyProfile(marketProfile)) {
        basketShadowOnly = true;
      }
      if (marketProfile === "UNKNOWN") {
        basketShadowOnly = true;
      }
      askSum += ask;
      legsBuy.push({
        tokenId: row.tokenId,
        marketId: row.marketId,
        side: "BUY",
        price: ask,
        size: 0
      });
      rowMeta.set(row.tokenId, {
        mid,
        spread: row.spread ?? Math.max(0, ask - bid),
        feeRateBps: row.feeRateBps,
        marketProfile
      });
    }

    // A complete set has one common share quantity. Leg-specific sizing would
    // leave residual directional exposure while reporting a fixed payout.
    const basketSize = this.config.maxNotionalUsd / askSum;
    if (!Number.isFinite(basketSize) || basketSize <= 0) return 0;
    for (const leg of legsBuy) leg.size = basketSize;

    // Current BUY fee settlement removes shares; a fee-charged gross-matched
    // basket is not a net-matched complete set. Until leg sizes are adjusted
    // and verified against per-match fee receipts, report no arbitrage.
    if (legsBuy.some((leg) => rowMeta.get(leg.tokenId)?.marketProfile !== "FEE_FREE")) return 0;

    const buyCostBps = computeBasketCostBps({
      legs: legsBuy
        .map((leg) => {
          const meta = rowMeta.get(leg.tokenId);
          if (!meta) return null;
          return {
            side: "BUY" as const,
            midPx: meta.mid,
            quotePx: leg.price,
            spreadPx: meta.spread,
            sizeShares: basketSize,
            marketProfile: meta.marketProfile,
            feeRateBps: meta.feeRateBps
          };
        })
        .filter((v): v is NonNullable<typeof v> => v != null),
      slippageBpsPerLeg: this.config.slippageBpsPerLeg,
      adverseSelectionBpsPerLeg: this.config.adverseSelectionBpsPerLeg,
      queueLossBpsPerLeg: this.config.queueLossBpsPerLeg,
      rebateBpsPerLeg: 0,
      inventoryPenaltyBps: 0,
      referenceCapitalUsdc: basketSize
    });

    const buyGrossEdgeBps = (1 - askSum) * 10_000;
    const buyNetEdgeBps = buyGrossEdgeBps - buyCostBps;
    if (buyNetEdgeBps >= this.config.minNetEdgeBps) {
      return await this.persistAndExecute({
        ts: input.ts,
        eventId: input.eventId,
        type: input.type,
        direction: "BUY_BASKET",
        rows: input.rows,
        legs: legsBuy,
        grossEdgeBps: buyGrossEdgeBps,
        costBps: buyCostBps,
        netEdgeBps: buyNetEdgeBps,
        shadowOnly: basketShadowOnly
      });
    }

    // SELL_BASKET would require proven inventory or a collateralized convert
    // path. Neither is available in this scanner, so it is not executable.
    return 0;
  }

  private async persistAndExecute(input: {
    ts: number;
    eventId: string | null;
    type: "BINARY_PARITY" | "NEG_RISK_BASKET";
    direction: "BUY_BASKET" | "SELL_BASKET";
    rows: TokenQuoteRow[];
    legs: ArbLeg[];
    grossEdgeBps: number;
    costBps: number;
    netEdgeBps: number;
    shadowOnly: boolean;
  }): Promise<number> {
    const decisionGroupId = randomUUID();
    const tokenIds = input.rows.map((r) => r.tokenId).sort();
    const legSignature = input.legs
      .map((leg) => `${leg.tokenId}:${leg.side}:${leg.price.toFixed(4)}:${leg.size.toFixed(4)}`)
      .sort()
      .join(",");
    const fingerprintBucket = Math.floor(input.ts / Math.max(1, this.config.intervalMs));
    const fingerprint = `${input.type}|${input.direction}|${input.eventId ?? "none"}|bucket=${fingerprintBucket}|${tokenIds.join(",")}|legs=${legSignature}`;
    const exists = this.selectRecentOpportunityStmt.get(fingerprint, input.ts - this.config.intervalMs) as
      | { id: number }
      | undefined;
    if (exists?.id) return 0;
    let opportunityId = 0;
    try {
      const insertRes = this.insertOpportunityStmt.run({
        ts: input.ts,
        eventId: input.eventId,
        type: input.type,
        direction: input.direction,
        tokenIdsJson: JSON.stringify(tokenIds),
        expectedPayout: 1,
        grossEdgeBps: input.grossEdgeBps,
        expectedCostBps: input.costBps,
        netEdgeBps: input.netEdgeBps,
        decisionGroupId,
        detailsJson: JSON.stringify({
          legs: input.legs.map((leg) => ({
            tokenId: leg.tokenId,
            side: leg.side,
            price: leg.price,
            size: leg.size
          }))
        }),
        fingerprint
      });
      const insertedRows = Number(insertRes.changes ?? 0);
      if (insertedRows <= 0) {
        return 0;
      }
      opportunityId = Number(insertRes.lastInsertRowid);
    } catch (err) {
      if (isSqliteUniqueConstraint(err)) {
        this.deps.logger.debug?.(
          { fingerprint, err: err instanceof Error ? err.message : String(err) },
          "Arb opportunity duplicate suppressed"
        );
        return 0;
      }
      throw err;
    }

    const ok = await this.deps.executor.execute({
      ts: input.ts,
      opportunityId,
      decisionGroupId,
      expectedNetEdgeBps: input.netEdgeBps,
      legs: input.legs,
      shadowOnly: input.shadowOnly
    });
    return ok ? 1 : 0;
  }
}
