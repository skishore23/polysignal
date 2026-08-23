/**
 * Time-Series Aggregation Module
 *
 * Implements tiered data rollups for long-term storage:
 * - Hourly aggregates: OHLCV + feature stats per token
 * - Daily aggregates: Summary statistics for backtesting
 *
 * This runs BEFORE retention cleanup to preserve aggregate info.
 */

import type Database from "better-sqlite3";

// ============================================================================
// Types
// ============================================================================

export type HourlyCandle = {
  readonly tokenId: string;
  readonly marketId: string | null;
  readonly hourTs: number; // Hour bucket timestamp (ms)
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number; // Sum of trade sizes
  readonly spreadMean: number;
  readonly spreadMin: number;
  readonly spreadMax: number;
  readonly obiMean: number;
  readonly vol30mMean: number;
  readonly tickCount: number;
};

export type AggregationConfig = {
  /** How far back to look for unaggregated data (hours) */
  readonly lookbackHours: number;
  /** Minimum age of data to aggregate (hours) - don't aggregate very recent data */
  readonly minAgeHours: number;
};

export const DEFAULT_AGGREGATION_CONFIG: AggregationConfig = {
  lookbackHours: 72,
  minAgeHours: 2, // Only aggregate data older than 2 hours
};

type AggregationResult = {
  readonly table: string;
  readonly rowsAggregated: number;
  readonly bucketsCreated: number;
  readonly durationMs: number;
};

// ============================================================================
// Schema Creation
// ============================================================================

const HOURLY_CANDLES_SCHEMA = `
CREATE TABLE IF NOT EXISTS hourly_candles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL,
  market_id TEXT,
  hour_ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  spread_mean REAL,
  spread_min REAL,
  spread_max REAL,
  obi_mean REAL,
  vol30m_mean REAL,
  tick_count INTEGER NOT NULL,
  UNIQUE(token_id, hour_ts)
);
CREATE INDEX IF NOT EXISTS hourly_candles_token_idx ON hourly_candles(token_id);
CREATE INDEX IF NOT EXISTS hourly_candles_hour_ts_idx ON hourly_candles(hour_ts);
`;

const DAILY_CANDLES_SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_candles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL,
  market_id TEXT,
  day_ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  spread_mean REAL,
  obi_mean REAL,
  vol30m_mean REAL,
  tick_count INTEGER NOT NULL,
  UNIQUE(token_id, day_ts)
);
CREATE INDEX IF NOT EXISTS daily_candles_token_idx ON daily_candles(token_id);
CREATE INDEX IF NOT EXISTS daily_candles_day_ts_idx ON daily_candles(day_ts);
`;

export const ensureAggregationSchema = (db: Database.Database): void => {
  db.exec(HOURLY_CANDLES_SCHEMA);
  db.exec(DAILY_CANDLES_SCHEMA);
};

// ============================================================================
// Utility Functions
// ============================================================================

const floorToHour = (tsMs: number): number => {
  const MS_PER_HOUR = 60 * 60 * 1000;
  return Math.floor(tsMs / MS_PER_HOUR) * MS_PER_HOUR;
};

const floorToDay = (tsMs: number): number => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.floor(tsMs / MS_PER_DAY) * MS_PER_DAY;
};

const tableExists = (db: Database.Database, name: string): boolean => {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
  return row !== undefined;
};

// ============================================================================
// Aggregation Functions
// ============================================================================

/**
 * Aggregate features into hourly OHLCV candles.
 */
const aggregateFeaturesToHourlyCandles = (
  db: Database.Database,
  config: AggregationConfig
): AggregationResult => {
  const startTime = Date.now();

  if (!tableExists(db, "features")) {
    return { table: "hourly_candles", rowsAggregated: 0, bucketsCreated: 0, durationMs: 0 };
  }

  const now = Date.now();
  const cutoffMax = now - config.minAgeHours * 60 * 60 * 1000;
  const cutoffMin = now - config.lookbackHours * 60 * 60 * 1000;

  // Find hours that have features but no candle yet
  const unaggregatedHours = db.prepare(`
    SELECT DISTINCT 
      token_id,
      market_id,
      (ts / 3600000) * 3600000 as hour_ts
    FROM features
    WHERE ts >= ? AND ts < ?
      AND (token_id, (ts / 3600000) * 3600000) NOT IN (
        SELECT token_id, hour_ts FROM hourly_candles
      )
    ORDER BY hour_ts
  `).all(cutoffMin, cutoffMax) as Array<{ token_id: string; market_id: string | null; hour_ts: number }>;

  let rowsAggregated = 0;
  let bucketsCreated = 0;

  const insertCandle = db.prepare(`
    INSERT OR REPLACE INTO hourly_candles (
      token_id, market_id, hour_ts, open, high, low, close, volume,
      spread_mean, spread_min, spread_max, obi_mean, vol30m_mean, tick_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getHourData = db.prepare(`
    SELECT 
      mid, spread, obi, vol30m, ts
    FROM features
    WHERE token_id = ? AND ts >= ? AND ts < ?
    ORDER BY ts
  `);

  for (const { token_id, market_id, hour_ts } of unaggregatedHours) {
    const hourEnd = hour_ts + 3600000;
    const rows = getHourData.all(token_id, hour_ts, hourEnd) as Array<{
      mid: number | null;
      spread: number | null;
      obi: number | null;
      vol30m: number | null;
      ts: number;
    }>;

    if (rows.length === 0) continue;

    const mids = rows.filter(r => r.mid !== null).map(r => r.mid as number);
    if (mids.length === 0) continue;

    const spreads = rows.filter(r => r.spread !== null).map(r => r.spread as number);
    const obis = rows.filter(r => r.obi !== null).map(r => r.obi as number);
    const vols = rows.filter(r => r.vol30m !== null).map(r => r.vol30m as number);

    const open = mids[0];
    const close = mids[mids.length - 1];
    const high = Math.max(...mids);
    const low = Math.min(...mids);

    insertCandle.run(
      token_id,
      market_id,
      hour_ts,
      open,
      high,
      low,
      close,
      0, // volume - would need trade data
      spreads.length > 0 ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
      spreads.length > 0 ? Math.min(...spreads) : null,
      spreads.length > 0 ? Math.max(...spreads) : null,
      obis.length > 0 ? obis.reduce((a, b) => a + b, 0) / obis.length : null,
      vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : null,
      rows.length
    );

    rowsAggregated += rows.length;
    bucketsCreated += 1;
  }

  return {
    table: "hourly_candles",
    rowsAggregated,
    bucketsCreated,
    durationMs: Date.now() - startTime,
  };
};

/**
 * Roll up hourly candles into daily candles (for long-term storage).
 */
const rollupHourlyToDaily = (
  db: Database.Database,
  config: AggregationConfig
): AggregationResult => {
  const startTime = Date.now();

  if (!tableExists(db, "hourly_candles")) {
    return { table: "daily_candles", rowsAggregated: 0, bucketsCreated: 0, durationMs: 0 };
  }

  const now = Date.now();
  // Roll up candles older than 7 days
  const cutoffMax = now - 7 * 24 * 60 * 60 * 1000;
  const cutoffMin = now - config.lookbackHours * 24 * 60 * 60 * 1000; // Extended lookback for daily

  const result = db.prepare(`
    INSERT OR REPLACE INTO daily_candles (
      token_id, market_id, day_ts, open, high, low, close, volume,
      spread_mean, obi_mean, vol30m_mean, tick_count
    )
    SELECT 
      token_id,
      market_id,
      (hour_ts / 86400000) * 86400000 as day_ts,
      (SELECT open FROM hourly_candles h2 
       WHERE h2.token_id = h1.token_id 
         AND (h2.hour_ts / 86400000) = (h1.hour_ts / 86400000)
       ORDER BY h2.hour_ts ASC LIMIT 1) as open,
      MAX(high) as high,
      MIN(low) as low,
      (SELECT close FROM hourly_candles h3 
       WHERE h3.token_id = h1.token_id 
         AND (h3.hour_ts / 86400000) = (h1.hour_ts / 86400000)
       ORDER BY h3.hour_ts DESC LIMIT 1) as close,
      SUM(volume) as volume,
      AVG(spread_mean) as spread_mean,
      AVG(obi_mean) as obi_mean,
      AVG(vol30m_mean) as vol30m_mean,
      SUM(tick_count) as tick_count
    FROM hourly_candles h1
    WHERE hour_ts >= ? AND hour_ts < ?
    GROUP BY token_id, market_id, (hour_ts / 86400000) * 86400000
  `).run(cutoffMin, cutoffMax);

  return {
    table: "daily_candles",
    rowsAggregated: result.changes,
    bucketsCreated: result.changes,
    durationMs: Date.now() - startTime,
  };
};

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run all aggregations.
 * Call this BEFORE retention cleanup to preserve data.
 */
export const runAggregation = (
  db: Database.Database,
  config: AggregationConfig = DEFAULT_AGGREGATION_CONFIG
): readonly AggregationResult[] => {
  // Ensure tables exist
  ensureAggregationSchema(db);

  const results: AggregationResult[] = [];

  // Core trading data aggregations
  results.push(aggregateFeaturesToHourlyCandles(db, config));
  results.push(rollupHourlyToDaily(db, config));

  return results;
};

// ============================================================================
// Query Helpers for Backtesting
// ============================================================================

/**
 * Get OHLCV candles for a token within a time range.
 */
export const getHourlyCandles = (
  db: Database.Database,
  tokenId: string,
  startTs: number,
  endTs: number
): readonly HourlyCandle[] => {
  return db.prepare(`
    SELECT 
      token_id as tokenId,
      market_id as marketId,
      hour_ts as hourTs,
      open, high, low, close, volume,
      spread_mean as spreadMean,
      spread_min as spreadMin,
      spread_max as spreadMax,
      obi_mean as obiMean,
      vol30m_mean as vol30mMean,
      tick_count as tickCount
    FROM hourly_candles
    WHERE token_id = ? AND hour_ts >= ? AND hour_ts <= ?
    ORDER BY hour_ts
  `).all(tokenId, startTs, endTs) as HourlyCandle[];
};
