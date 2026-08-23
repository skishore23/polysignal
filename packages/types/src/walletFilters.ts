export const WALLET_MARKET_KINDS = [
  "TAKER_BUY",
  "TAKER_SELL",
  "MAKER_BID",
  "MAKER_ASK"
] as const;

export type WalletMarketKind = (typeof WALLET_MARKET_KINDS)[number];

export type WalletMarketFilterV1 = {
  version: 1;
  includeMarketIds?: string[];
  excludeMarketIds?: string[];
  minVolumeUsd?: number;
  maxVolumeUsd?: number;
  minLiquidityUsd?: number;
  maxLiquidityUsd?: number;
  requireActive?: boolean;
  allowedKinds?: WalletMarketKind[];
};

export type WalletMarketFilter = WalletMarketFilterV1;
