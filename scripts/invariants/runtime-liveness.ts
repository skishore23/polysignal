#!/usr/bin/env tsx

import {
  boolArg,
  discoverDbPath,
  numberArg,
  openReadOnlyDatabase,
  parseCliArgs,
  safeClose,
  stringArg,
  tableExists
} from "../lib/db.js";

const args = parseCliArgs();
const dbPath = discoverDbPath(stringArg(args, "db", ""));
const feedMaxAgeSec = Math.max(1, numberArg(args, "feed-max-age-sec", 120));
const makerMinEvents5m = Math.max(1, numberArg(args, "maker-min-events-5m", 1));
const requireTakerWhenSignals = boolArg(args, "require-taker-when-signals", true);
const activityLookbackSec = Math.max(30, numberArg(args, "activity-lookback-sec", 300));
const nowTs = Date.now();
const since5m = nowTs - 5 * 60 * 1000;
const since15m = nowTs - 15 * 60 * 1000;
const sinceActivity = nowTs - activityLookbackSec * 1000;

const sqlite = openReadOnlyDatabase(dbPath);

try {
  const requiredTables = ["latest_features", "shadow_orders", "shadow_fills", "decision_log", "clob_events"];
  const missing = requiredTables.filter((tableName) => !tableExists(sqlite, tableName));
  if (missing.length > 0) {
    console.error(`[invariant:runtime-liveness] FAIL db=${dbPath}`);
    console.error(`  - missing tables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const activeFeatureStats = sqlite
    .prepare(
      `WITH active_tokens AS (
         SELECT DISTINCT token_id
         FROM clob_events
         WHERE recv_ts_ms >= ?
       )
       SELECT
         COUNT(*) as activeTokenCount,
         MAX(lf.ts) as latestFeatureTs,
         COALESCE(SUM(CASE WHEN ? - lf.ts <= (? * 1000) THEN 1 ELSE 0 END), 0) as freshTokenCount
       FROM latest_features lf
       JOIN active_tokens at ON at.token_id = lf.token_id`
    )
    .get(sinceActivity, nowTs, feedMaxAgeSec) as {
    activeTokenCount: number;
    latestFeatureTs: number | null;
    freshTokenCount: number;
  };
  const activeTokenCount = activeFeatureStats?.activeTokenCount ?? 0;
  const freshTokenCount = activeFeatureStats?.freshTokenCount ?? 0;
  const latestFeatureTs =
    activeFeatureStats?.latestFeatureTs ??
    ((sqlite.prepare("SELECT MAX(ts) as ts FROM latest_features").get() as { ts: number | null }).ts ?? null);
  const feedAgeSec =
    latestFeatureTs == null ? Number.POSITIVE_INFINITY : Math.max(0, (nowTs - latestFeatureTs) / 1000);

  const makerOrders5m = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM shadow_orders
         WHERE ts >= ?
           AND execution_mode = 'SHADOW'
           AND kind IN ('MAKER_BID','MAKER_ASK')`
      )
      .get(since5m) as { c: number }
  ).c;
  const makerFills5m = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= ?
           AND (f.method IS NULL OR f.method != 'synthetic_fill')
           AND o.execution_mode = 'SHADOW'
           AND o.kind IN ('MAKER_BID','MAKER_ASK')`
      )
      .get(since5m) as { c: number }
  ).c;
  const makerSkips5m = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM decision_log
         WHERE ts >= ?
           AND decision = 'SKIP'
           AND kind IN ('MAKER_BID','MAKER_ASK')`
      )
      .get(since5m) as { c: number }
  ).c;
  const makerEvents5m = makerOrders5m + makerFills5m + makerSkips5m;

  const takerSignals5m = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM decision_log
         WHERE ts >= ?
           AND decision = 'SUBMIT'
           AND kind IN ('TAKER_BUY','TAKER_SELL')`
      )
      .get(since5m) as { c: number }
  ).c;
  const takerOrders15m = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM shadow_orders
         WHERE ts >= ?
           AND execution_mode = 'SHADOW'
           AND kind IN ('TAKER_BUY','TAKER_SELL')`
      )
      .get(since15m) as { c: number }
  ).c;
  const takerFills15m = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= ?
           AND (f.method IS NULL OR f.method != 'synthetic_fill')
           AND o.execution_mode = 'SHADOW'
           AND o.kind IN ('TAKER_BUY','TAKER_SELL')`
      )
      .get(since15m) as { c: number }
  ).c;
  const takerSkips15m = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM decision_log
         WHERE ts >= ?
           AND decision = 'SKIP'
           AND kind IN ('TAKER_BUY','TAKER_SELL')`
      )
      .get(since15m) as { c: number }
  ).c;
  const takerEvents15m = takerOrders15m + takerFills15m + takerSkips15m;
  const hasRecentLaneActivity = makerEvents5m > 0 || takerSignals5m > 0 || takerEvents15m > 0;
  const startupWarmupNoActivity = activeTokenCount <= 0 && !hasRecentLaneActivity;

  const failures: string[] = [];
  if (!startupWarmupNoActivity && feedAgeSec > feedMaxAgeSec) {
    failures.push(`feed stale age_sec=${feedAgeSec.toFixed(1)} max<=${feedMaxAgeSec}`);
  }
  if (!startupWarmupNoActivity && activeTokenCount > 0 && freshTokenCount <= 0) {
    failures.push(
      `no fresh active features in ${activityLookbackSec}s window active_tokens=${activeTokenCount}`
    );
  }
  if (!startupWarmupNoActivity && makerEvents5m < makerMinEvents5m) {
    failures.push(`maker lane inactive events_5m=${makerEvents5m} required>=${makerMinEvents5m}`);
  }
  if (requireTakerWhenSignals && takerSignals5m > 0 && takerEvents15m <= 0) {
    failures.push("taker signaled but no taker lane activity in last 15m");
  }

  if (failures.length > 0) {
    console.error(`[invariant:runtime-liveness] FAIL db=${dbPath}`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    console.error(
      `  - maker_events_5m=${makerEvents5m} taker_signals_5m=${takerSignals5m} taker_events_15m=${takerEvents15m} active_tokens=${activeTokenCount} fresh_active=${freshTokenCount}`
    );
    process.exit(1);
  }

  if (startupWarmupNoActivity) {
    console.log(
      `[invariant:runtime-liveness] PASS db=${dbPath} mode=startup_warmup_no_activity maker_events_5m=${makerEvents5m} taker_events_15m=${takerEvents15m} active_tokens=${activeTokenCount} fresh_active=${freshTokenCount}`
    );
  } else {
    console.log(
      `[invariant:runtime-liveness] PASS db=${dbPath} feed_age_sec=${Number.isFinite(feedAgeSec) ? feedAgeSec.toFixed(1) : "inf"} maker_events_5m=${makerEvents5m} taker_events_15m=${takerEvents15m} active_tokens=${activeTokenCount} fresh_active=${freshTokenCount}`
    );
  }
} finally {
  safeClose(sqlite);
}
