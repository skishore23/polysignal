export type Market = {
  id: string;
  slug: string | null;
  question: string | null;
  active: number;
  volume: number | null;
  liquidity: number | null;
  updatedAt: number;
};

export type Token = {
  id: string;
  marketId: string;
  outcome: string | null;
  name: string | null;
};

export type DecisionGroupId = string & { readonly __brand: "DecisionGroupId" };

export type CostBreakdown = {
  spreadBps: number;
  feeBps: number;
  feeUsdc: number;
  feePerShare: number;
  notionalUsdc: number;
  marketProfile: string;
  slippageBps: number;
  adverseSelectionBps: number;
  queueLossBps: number;
  expectedRebateBps: number;
  expectedLiquidityRewardsBps: number;
  rebateBps: number;
  inventoryPenaltyBps: number;
  totalCostBps: number;
};

export type PriorEstimate = {
  tokenId: string;
  source: string;
  probability: number;
  confidence: number;
  observedTs: number;
  metadata?: Record<string, unknown>;
};

export type ArbOpportunityType = "BINARY_PARITY" | "NEG_RISK_BASKET";
export type ArbOpportunityDirection = "BUY_BASKET" | "SELL_BASKET";

export type ArbOpportunity = {
  id: string;
  ts: number;
  eventId: string | null;
  type: ArbOpportunityType;
  direction: ArbOpportunityDirection;
  tokenIds: string[];
  grossEdgeBps: number;
  netEdgeBps: number;
  expectedPayout: number;
  expectedCostBps: number;
  decisionGroupId: DecisionGroupId;
  details?: Record<string, unknown>;
};

export type ArbExecutionStatus = "QUEUED" | "SUBMITTED" | "PARTIAL" | "FILLED" | "FAILED";

export type ArbExecution = {
  id: string;
  opportunityId: string;
  decisionGroupId: DecisionGroupId;
  ts: number;
  status: ArbExecutionStatus;
  legCount: number;
  expectedNetEdgeBps: number;
  realizedPnl: number | null;
  error: string | null;
};

export type BookLevel = {
  price: number;
  size: number;
};

export type BookSnapshot = {
  tokenId: string;
  marketId: string | null;
  bids: BookLevel[];
  asks: BookLevel[];
  hash: string | null;
  lastUpdatedMs: number;
};

export type FeatureRow = {
  id?: number;
  ts: number;
  tokenId: string;
  marketId: string | null;
  mid: number | null;
  spread: number | null;
  obi: number | null;
  microprice: number | null;
  micropriceMinusMid: number | null;
  bidDepthTop: number | null;
  askDepthTop: number | null;
  r10s: number | null;
  r1m: number | null;
  r5m: number | null;
  accel1m: number | null;
  skew30m: number | null;
  entropy30m: number | null;
  vol30m: number | null;
  stalenessSec: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  recvTsMs: number | null;
  lastEventGlobalSeq: number | null;
};

export type Signal = "BUY" | "SELL" | "HOLD";

export type SignalRow = {
  id?: number;
  ts: number;
  tokenId: string;
  marketId: string | null;
  horizonSec: number;
  signal: Signal;
  deltaHat: number;
  confidence: number;
  buffer: number;
  reasons: string[];
  featureTsMsUsed: number | null;
  featureLastEventGlobalSeqUsed: number | null;
};

export type SignalEvidence = {
  id?: number;
  signalId: number | null;
  ts: number;
  tokenId: string;
  marketId: string | null;
  horizonSec: number;
  snapshot: {
    bestBid: number | null;
    bestAsk: number | null;
    mid: number | null;
    spread: number | null;
    topBids: BookLevel[];
    topAsks: BookLevel[];
    lastBookUpdatedMs?: number | null;
    lastEventMs?: number | null;
    recvTsMs?: number | null;
    lastEventGlobalSeq?: number | null;
  };
  features: FeatureRow;
  model: {
    version: string;
    thresholds: Record<string, number>;
  };
  deltaHat: number;
  confidence: number;
  buffer: number;
  counterfactual: string;
};

export type AlertType =
  | "EXIT_SUGGESTED"
  | "STOP_HIT"
  | "MAX_LOSS_HIT"
  | "TAKE_PROFIT_HIT"
  | "STALE_DATA"
  | "RECONNECT";

export type AlertRow = {
  id?: number;
  ts: number;
  type: AlertType;
  tokenId: string | null;
  marketId: string | null;
  payload: Record<string, unknown>;
  delivered: number;
};

export type EvaluationMetrics = {
  horizonSec: number;
  strategy: string;
  count: number;
  hitRate: number;
  avgReturn: number;
  medianReturn: number;
  p05: number;
  p95: number;
  turnover: number;
};

export type {
  MakerSide,
  MakerExecutionMode,
  MakerInput,
  MakerParams,
  MakerPnLLimits,
  MakerCircuitState,
  MakerQuoteSide,
  MakerQuote,
  MakerGateResult,
  MakerInventory,
  InventoryState,
  SkewPolicy,
  MakerOrder,
  MakerFill,
  RewardsEstimate,
  MakerLedgerEntry,
  MakerMetricsRow,
  MakerOrderResponse,
  MakerExecutionError
} from "./maker.js";

export type {
  WalletMarketKind,
  WalletMarketFilter,
  WalletMarketFilterV1
} from "./walletFilters";
export { WALLET_MARKET_KINDS } from "./walletFilters";
