import { sqliteTable, text, integer, real, index, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core";

export const markets = sqliteTable("markets", {
  id: text("id").primaryKey(),
  conditionId: text("condition_id"),
  eventId: text("event_id"),
  negRisk: integer("neg_risk").notNull().default(0),
  slug: text("slug"),
  question: text("question"),
  active: integer("active").notNull().default(1),
  volume: real("volume"),
  liquidity: real("liquidity"),
  rewardsMinSize: real("rewards_min_size"),
  rewardsMaxSpread: real("rewards_max_spread"),
  rewardsRatesJson: text("rewards_rates_json"),
  rewardsUpdatedAt: integer("rewards_updated_at"),
  makerBaseFee: real("maker_base_fee"),
  takerBaseFee: real("taker_base_fee"),
  minimumOrderSize: real("minimum_order_size"),
  minimumTickSize: real("minimum_tick_size"),
  updatedAt: integer("updated_at").notNull(),
  createdAt: integer("created_at").notNull()
});

export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    marketId: text("market_id").notNull(),
    outcome: text("outcome"),
    name: text("name"),
    feeRateBps: integer("fee_rate_bps"),
    feeRateUpdatedAt: integer("fee_rate_updated_at"),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => ({
    marketIdx: index("tokens_market_idx").on(t.marketId)
  }),
);

export const marketEvents = sqliteTable("market_events", {
  id: text("id").primaryKey(),
  slug: text("slug"),
  title: text("title"),
  negRisk: integer("neg_risk").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
  createdAt: integer("created_at").notNull()
});

export const eventMarkets = sqliteTable(
  "event_markets",
  {
    eventId: text("event_id").notNull(),
    marketId: text("market_id").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.marketId] }),
    marketIdx: index("event_markets_market_idx").on(t.marketId)
  })
);

export const externalPriors = sqliteTable(
  "external_priors",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    tokenId: text("token_id").notNull(),
    source: text("source").notNull(),
    probability: real("probability").notNull(),
    confidence: real("confidence").notNull(),
    metadataJson: text("metadata_json")
  },
  (t) => ({
    tokenTsIdx: index("external_priors_token_ts_idx").on(t.tokenId, t.ts),
    sourceTsIdx: index("external_priors_source_ts_idx").on(t.source, t.ts)
  })
);

export const arbOpportunities = sqliteTable(
  "arb_opportunities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    eventId: text("event_id"),
    type: text("type").notNull(),
    direction: text("direction").notNull(),
    tokenIdsJson: text("token_ids_json").notNull(),
    expectedPayout: real("expected_payout").notNull(),
    grossEdgeBps: real("gross_edge_bps").notNull(),
    expectedCostBps: real("expected_cost_bps").notNull(),
    netEdgeBps: real("net_edge_bps").notNull(),
    decisionGroupId: text("decision_group_id").notNull(),
    detailsJson: text("details_json"),
    fingerprint: text("fingerprint").notNull()
  },
  (t) => ({
    tsIdx: index("arb_opportunities_ts_idx").on(t.ts),
    fingerprintIdx: uniqueIndex("arb_opportunities_fingerprint_idx").on(t.fingerprint)
  })
);

export const arbExecutions = sqliteTable(
  "arb_executions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    opportunityId: integer("opportunity_id").notNull(),
    decisionGroupId: text("decision_group_id").notNull(),
    status: text("status").notNull(),
    expectedNetEdgeBps: real("expected_net_edge_bps").notNull(),
    legCount: integer("leg_count").notNull(),
    realizedPnl: real("realized_pnl"),
    error: text("error")
  },
  (t) => ({
    oppIdx: index("arb_executions_opp_idx").on(t.opportunityId),
    tsIdx: index("arb_executions_ts_idx").on(t.ts)
  })
);

export const clobEvents = sqliteTable(
  "clob_events",
  {
    globalSeq: integer("global_seq").primaryKey({ autoIncrement: true }),
    recvTsMs: integer("recv_ts_ms").notNull(),
    connId: text("conn_id").notNull(),
    tokenId: text("token_id").notNull(),
    msgType: text("msg_type").notNull(),
    payloadJson: text("payload_json").notNull()
  },
  (t) => ({
    tokenIdx: index("clob_events_token_idx").on(t.tokenId),
    recvTsIdx: index("clob_events_recv_ts_idx").on(t.recvTsMs),
    tokenRecvTsIdx: index("clob_events_token_recv_ts_idx").on(t.tokenId, t.recvTsMs)
  }),
);

export const features = sqliteTable(
  "features",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    tokenId: text("token_id").notNull(),
    marketId: text("market_id"),
    mid: real("mid"),
    spread: real("spread"),
    obi: real("obi"),
    microprice: real("microprice"),
    micropriceMinusMid: real("microprice_minus_mid"),
    bidDepthTop: real("bid_depth_top"),
    askDepthTop: real("ask_depth_top"),
    r10s: real("r10s"),
    r1m: real("r1m"),
    r5m: real("r5m"),
    accel1m: real("accel_1m"),
    skew30m: real("skew_30m"),
    entropy30m: real("entropy_30m"),
    vol30m: real("vol30m"),
    stalenessSec: real("staleness_sec"),
    bestBid: real("best_bid"),
    bestAsk: real("best_ask"),
    recvTsMs: integer("recv_ts_ms"),
    lastEventGlobalSeq: integer("last_event_global_seq")
  },
  (t) => ({
    tokenIdx: index("features_token_idx").on(t.tokenId),
    tsIdx: index("features_ts_idx").on(t.ts),
    lastEventGlobalSeqIdx: index("features_last_event_global_seq_idx").on(t.lastEventGlobalSeq),
    recvTsIdx: index("features_recv_ts_idx").on(t.recvTsMs)
  }),
);

export const latestFeatures = sqliteTable("latest_features", {
  tokenId: text("token_id").primaryKey(),
  marketId: text("market_id"),
  ts: integer("ts").notNull(),
  mid: real("mid"),
  spread: real("spread"),
  obi: real("obi"),
  microprice: real("microprice"),
  micropriceMinusMid: real("microprice_minus_mid"),
  bidDepthTop: real("bid_depth_top"),
  askDepthTop: real("ask_depth_top"),
  r10s: real("r10s"),
  r1m: real("r1m"),
  r5m: real("r5m"),
  accel1m: real("accel_1m"),
  skew30m: real("skew_30m"),
  entropy30m: real("entropy_30m"),
  vol30m: real("vol30m"),
  stalenessSec: real("staleness_sec"),
  bestBid: real("best_bid"),
  bestAsk: real("best_ask"),
  recvTsMs: integer("recv_ts_ms"),
  lastEventGlobalSeq: integer("last_event_global_seq")
});

export const shadowOrders = sqliteTable(
  "shadow_orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    walletId: integer("wallet_id"),
    tokenId: text("token_id").notNull(),
    marketId: text("market_id"),
    side: text("side").notNull(),
    kind: text("kind").notNull(),
    price: real("price"),
    size: real("size"),
    expectedCancelTs: integer("expected_cancel_ts"),
    executionMode: text("execution_mode").notNull(),
    bookSnapshotJson: text("book_snapshot_json"),
    source: text("source"),
    strategyLane: text("strategy_lane"),
    decisionGroupId: text("decision_group_id"),
    clientOrderId: text("client_order_id"),
    externalOrderId: text("external_order_id"),
    status: text("status"),
    filledSize: real("filled_size"),
    filledPrice: real("filled_price"),
    lastUpdateTs: integer("last_update_ts"),
    stateId: integer("state_id"),
    // Edge trace (nullable for legacy rows)
    predEdgeBps: real("pred_edge_bps"),
    predSource: text("pred_source"),
    spreadBps: real("spread_bps"),
    feesBps: real("fees_bps"),
    expectedSlippageBps: real("expected_slippage_bps"),
    expectedAdverseBps: real("expected_adverse_bps"),
    expectedQueueBps: real("expected_queue_bps"),
    costBps: real("cost_bps"),
    netEdgeBps: real("net_edge_bps"),
    decision: text("decision"),
    decisionReason: text("decision_reason"),
    midPx: real("mid_px"),
    spreadPx: real("spread_px"),
    deltaHat: real("delta_hat"),
    bidPx: real("bid_px"),
    askPx: real("ask_px"),
    bidDepth: real("bid_depth"),
    askDepth: real("ask_depth"),
    inventoryIBefore: real("inventory_i_before"),
    inventoryIAfter: real("inventory_i_after"),
    inventoryDeltaAbs: real("inventory_delta_abs"),
    inventoryPenaltyBps: real("inventory_penalty_bps"),
    netEdgeAfterInventoryBps: real("net_edge_after_inventory_bps"),
    priorPHat: real("prior_p_hat")
  },
  (t) => ({
    tokenTsIdx: index("shadow_orders_token_ts_idx").on(t.tokenId, t.ts),
    walletTsIdx: index("shadow_orders_wallet_ts_idx").on(t.walletId, t.ts),
    externalOrderIdx: index("shadow_orders_external_order_idx").on(t.externalOrderId),
    decisionGroupIdx: index("shadow_orders_decision_group_idx").on(t.decisionGroupId),
    strategyLaneIdx: index("shadow_orders_strategy_lane_idx").on(t.strategyLane),
    decisionGroupStrategyTsIdx: index("shadow_orders_decision_group_strategy_ts_idx").on(
      t.decisionGroupId,
      t.strategyLane,
      t.ts
    )
  })
);

export const shadowFills = sqliteTable(
  "shadow_fills",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    orderId: integer("order_id").notNull(),
    price: real("price"),
    size: real("size"),
    method: text("method"),
    note: text("note"),
    tradeId: text("trade_id")
  },
  (t) => ({
    orderIdx: index("shadow_fills_order_idx").on(t.orderId),
    tsIdx: index("shadow_fills_ts_idx").on(t.ts),
    orderTsIdx: index("shadow_fills_order_ts_idx").on(t.orderId, t.ts),
    orderTradeIdx: uniqueIndex("shadow_fills_order_trade_idx").on(t.orderId, t.tradeId)
  })
);

export const shadowState = sqliteTable("shadow_state", {
  id: integer("id").primaryKey(),
  lastTradeSeq: integer("last_trade_seq").notNull(),
  lastFillId: integer("last_fill_id").notNull()
});

export const shadowMarkouts = sqliteTable(
  "shadow_markouts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fillId: integer("fill_id").notNull(),
    ts: integer("ts").notNull(),
    horizonMs: integer("horizon_ms").notNull(),
    midAtFill: real("mid_at_fill"),
    midAtHorizon: real("mid_at_horizon"),
    markoutBps: real("markout_bps")
  },
  (t) => ({
    fillIdx: index("shadow_markouts_fill_idx").on(t.fillId),
    horizonIdx: index("shadow_markouts_horizon_idx").on(t.horizonMs),
    fillHorizonIdx: index("shadow_markouts_fill_horizon_idx").on(t.fillId, t.horizonMs)
  })
);

export const decisionLog = sqliteTable(
  "decision_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    tokenId: text("token_id").notNull(),
    walletId: integer("wallet_id"),
    kind: text("kind").notNull(),
    strategyLane: text("strategy_lane"),
    decisionGroupId: text("decision_group_id"),
    decision: text("decision").notNull(),
    decisionReason: text("decision_reason"),
    predEdgeBps: real("pred_edge_bps"),
    costBps: real("cost_bps"),
    netEdgeBps: real("net_edge_bps"),
    spreadBps: real("spread_bps"),
    feesBps: real("fees_bps"),
    expectedSlippageBps: real("expected_slippage_bps"),
    midPx: real("mid_px"),
    spreadPx: real("spread_px"),
    deltaHat: real("delta_hat"),
    size: real("size"),
    bidPx: real("bid_px"),
    askPx: real("ask_px"),
    bidDepth: real("bid_depth"),
    askDepth: real("ask_depth")
  },
  (t) => ({
    tsIdx: index("decision_log_ts_idx").on(t.ts),
    tsTokenKindIdx: index("decision_log_ts_token_kind_idx").on(t.ts, t.tokenId, t.kind),
    kindDecisionIdx: index("decision_log_kind_decision_idx").on(t.kind, t.decision),
    reasonIdx: index("decision_log_reason_idx").on(t.decisionReason)
  })
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    type: text("type").notNull(),
    tokenId: text("token_id"),
    marketId: text("market_id"),
    payload: text("payload").notNull(),
    delivered: integer("delivered").notNull().default(0)
  },
  (t) => ({
    tsIdx: index("alerts_ts_idx").on(t.ts)
  }),
);

export const wallets = sqliteTable("wallets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  startingBalance: real("starting_balance").notNull().default(100000),
  sizeMultiplier: real("size_multiplier").notNull().default(1),
  maxOpenPositions: integer("max_open_positions").notNull().default(5),
  minConfidence: real("min_confidence").notNull().default(0),
  minEdge: real("min_edge").notNull().default(0),
  autoOpenLimit: integer("auto_open_limit").notNull().default(5),
  autoTradeEnabled: integer("auto_trade_enabled").notNull().default(1),
  takerSide: text("taker_side").notNull().default("BOTH"),
  makerEnabled: integer("maker_enabled").notNull().default(0),
  makerQuoteSize: real("maker_quote_size").notNull().default(50),
  makerQuoteWidthBps: real("maker_quote_width_bps").notNull().default(20),
  makerMinSpreadBps: real("maker_min_spread_bps"),
  makerMinSpread: real("maker_min_spread").notNull().default(0.002),
  makerMaxSpread: real("maker_max_spread").notNull().default(0.02),
  makerMinDepth: real("maker_min_depth").notNull().default(20),
  makerMaxEntropy: real("maker_max_entropy"),
  makerMaxVol: real("maker_max_vol"),
    makerInventoryTarget: real("maker_inventory_target").notNull().default(0),
  makerInventoryMaxAbs: real("maker_inventory_max_abs").notNull().default(500),
  makerInventoryBand: real("maker_inventory_band").notNull().default(200),
  makerInventorySkewBps: real("maker_inventory_skew_bps").notNull().default(15),
  makerInventorySkewSize: real("maker_inventory_skew_size").notNull().default(0.5),
  makerInventorySkewBpsCap: real("maker_inventory_skew_bps_cap"),
  makerQuoteImproveFraction: real("maker_quote_improve_fraction"),
  makerExecutionMode: text("maker_execution_mode").notNull().default("SHADOW"),
  maxDailyLossUsd: real("max_daily_loss_usd"),
  maxDrawdownPct: real("max_drawdown_pct"),
  cooldownMinutes: integer("cooldown_minutes"),
  marketAllowlist: text("market_allowlist"),
  marketFilterJson: text("market_filter_json"),
  createdAt: integer("created_at").notNull(),
  // Position-level defaults (when null, uses appConfig.position.* defaults)
  defaultStopLossPct: real("default_stop_loss_pct"),
  defaultTakeProfitPct: real("default_take_profit_pct"),
  defaultMaxLossAbs: real("default_max_loss_abs"),
  defaultMaxHoldSec: integer("default_max_hold_sec"),
  maxHoldMinutes: integer("max_hold_minutes")
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});

export const experimentRuns = sqliteTable(
  "experiment_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    gitHash: text("git_hash"),
    hypothesis: text("hypothesis").notNull(),
    scope: text("scope"),
    confidence: text("confidence"),
    paramsJson: text("params_json"),
    resultsJson: text("results_json"),
    verdict: text("verdict").notNull(),
    nextAction: text("next_action"),
    notes: text("notes"),
    runContextJson: text("run_context_json")
  },
  (t) => ({
    tsIdx: index("experiment_runs_ts_idx").on(t.ts),
    verdictIdx: index("experiment_runs_verdict_idx").on(t.verdict),
    scopeIdx: index("experiment_runs_scope_idx").on(t.scope)
  })
);
