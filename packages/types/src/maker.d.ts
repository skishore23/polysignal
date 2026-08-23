export type MakerSide = "BUY" | "SELL";
export type MakerExecutionMode = "LIVE" | "SHADOW";
export type MakerInput = {
    tokenId: string;
    marketId: string | null;
    ts: number;
    bestBid: number;
    bestAsk: number;
    mid: number;
    spread: number;
    bidDepthTop: number;
    askDepthTop: number;
    entropy30m: number | null;
    vol30m: number | null;
    rewardMinSize: number | null;
    rewardMaxSpread: number | null;
    rewardMultiplier: number | null;
    feeRateBps: number | null;
};
export type MakerParams = {
    /** One-way spread floor in bps (Policy v0 lane). When set, gate requires (spread/mid)*10_000 >= minSpreadBps. */
    minSpreadBps: number | null;
    minSpread: number;
    maxSpread: number;
    minDepth: number;
    maxEntropy: number | null;
    maxVol: number | null;
    baseQuoteSize: number;
    quoteWidthBps: number;
    inventoryTarget: number;
    inventoryMaxAbs: number;
    inventoryBand: number;
    inventorySkewBps: number;
    inventorySkewSize: number;
    inventorySkewBpsCap: number | null;
    /** λ for Δ|I|-based penalty: penaltyBps = inventoryLambdaBps * max(0, |I_after| - |I_before|). */
    inventoryLambdaBps: number;
    baseVol: number;
    maxVolMultiplier: number;
    /** Quote aggressiveness q ∈ [0, 0.5]: pull quotes toward touch for faster fill; spread earned ≈ (0.5 - q) * spread. */
    quoteImproveFraction: number;
};
/** Per (market, wallet): normalized inventory state for skew policy. */
export type InventoryState = {
    q: number;
    target: number;
    qMax: number;
    band: number;
    i: number;
};
/** Output of skew policy: mode + price/size multipliers. */
export type SkewPolicy = {
    mode: "both" | "bid_only" | "ask_only" | "none";
    priceShiftBps: number;
    sizeBidMult: number;
    sizeAskMult: number;
};
export type MakerPnLLimits = {
    maxDailyLossUsd: number;
    maxDrawdownPct: number;
    cooldownMinutes: number;
};
export type MakerCircuitState = {
    walletId: number;
    pausedUntil: number | null;
    reason: string | null;
    dailyPnL: number;
    peakBalance: number;
};
export type MakerQuoteSide = {
    side: MakerSide;
    price: number;
    size: number;
};
export type MakerQuote = {
    tokenId: string;
    marketId: string | null;
    ts: number;
    bid: MakerQuoteSide | null;
    ask: MakerQuoteSide | null;
    reason: string;
};
export type MakerGateResult = {
    ok: boolean;
    reason: string;
};
export type MakerInventory = {
    tokenId: string;
    position: number;
    lastUpdatedTs: number;
};
export type MakerOrder = {
    id: string;
    tokenId: string;
    marketId: string | null;
    ts: number;
    side: MakerSide;
    price: number;
    size: number;
    status: "OPEN" | "FILLED" | "CANCELLED";
};
export type MakerFill = {
    orderId: string;
    tokenId: string;
    ts: number;
    side: MakerSide;
    price: number;
    size: number;
};
export type RewardsEstimate = {
    tokenId: string;
    ts: number;
    qOne: number;
    qTwo: number;
    qMin: number;
    eligible: boolean;
};
export type MakerLedgerEntry = {
    tokenId: string;
    ts: number;
    mid: number;
    spread: number;
    bidPrice: number;
    askPrice: number;
    bidSize: number;
    askSize: number;
    position: number;
    qMin: number;
    note: string;
};
export type MakerMetricsRow = {
    tokenId: string;
    ts: number;
    spreadCapture: number;
    inventorySkew: number;
    qMin: number;
    fillRate: number;
};
export type MakerOrderResponse = {
    orderId: string;
    clientOrderId: string;
    status: "PENDING" | "OPEN" | "FILLED" | "PARTIAL" | "REJECTED" | "CANCELLED";
    filledSize: number;
    filledPrice: number;
    reason: string | null;
};
export type MakerExecutionError = {
    type: "NETWORK" | "REJECTED" | "TIMEOUT" | "INVALID_RESPONSE";
    message: string;
    retryable: boolean;
};
//# sourceMappingURL=maker.d.ts.map