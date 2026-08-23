import horizonsJson from "../../../configs/horizons.json";
import defaultsJson from "../../../configs/defaults.json";

export type WalletDefaults = {
  startingBalance: number;
  sizeMultiplier: number;
  maxOpenPositions: number;
  minConfidence: number;
  minEdge: number;
  autoOpenLimit: number;
};

export type PositionDefaults = {
  size: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxHoldSec: number;
  minPositionSize: number;
};

export type TradingPreset = {
  sizeMultiplier: number;
  maxOpenPositions: number;
  minConfidence: number;
  minEdge: number;
  autoOpenLimit: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxHoldSec: number;
  maxLossAbs: number;
};

export type PollingConfig = {
  positionsRefreshMs: number;
  opportunitiesRefreshMs: number;
  intelligenceRefreshMs: number;
  sseIntervalMs: number;
  makerQuotesRefreshMs: number;
  summariesRefreshMs: number;
  statusRefreshMs: number;
};

export type UrlsConfig = {
  polymarketBase: string;
};

export type AppConfig = {
  horizons: number[];
  wallet: WalletDefaults;
  position: PositionDefaults;
  presets: { fast: TradingPreset; quality: TradingPreset };
  polling: PollingConfig;
  urls: UrlsConfig;
};

export const appConfig: AppConfig = {
  horizons: horizonsJson.horizons_seconds,
  wallet: defaultsJson.wallet,
  position: defaultsJson.position,
  presets: defaultsJson.presets,
  polling: defaultsJson.polling,
  urls: defaultsJson.urls
};

export const getAppConfig = (): AppConfig => appConfig;
