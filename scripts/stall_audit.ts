#!/usr/bin/env npx tsx

import path from "node:path";
import { getRepoRoot, loadConfig } from "../apps/worker/src/config.js";
import { RegimeGate } from "../apps/worker/src/regime/RegimeGate.js";
import { openDatabase } from "../packages/storage/src/index.js";

type FeatureRow = {
  tokenId: string;
  marketId: string | null;
  spread: number | null;
  bidDepthTop: number | null;
  askDepthTop: number | null;
  obi: number | null;
  vol30m: number | null;
  micropriceMinusMid: number | null;
};

const parseArgs = (): Map<string, string> => {
  const out = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      out.set(raw.slice(2, eq), raw.slice(eq + 1));
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.set(key, next);
      i += 1;
      continue;
    }
    out.set(key, "true");
  }
  return out;
};

const regimeReasons = new Set([
  "explicit_block",
  "ucb_negative",
  "score_below_min",
  "sparse_explore",
  "liveness_relax",
  "not_loaded_no_last_good",
  "invalid_numeric",
  "live_liveness_relax_forbidden",
  "no_state",
  "manifest_mismatch",
  "manifest_stamp_changed_without_manifest_update"
]);

const toAbsolute = (raw: string, repoRoot: string): string =>
  path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);

const topReasons = (rows: Array<{ reason: string | null; count: number }>): string => {
  if (!rows.length) return "none";
  return rows.map((row) => `${row.reason ?? "null"}:${row.count}`).join(", ");
};

const main = (): void => {
  const args = parseArgs();
  const repoRoot = getRepoRoot();
  const worker = loadConfig();
  const minutes = Math.max(1, Number(args.get("minutes") ?? 30));
  const now = Date.now();
  const fromTs = now - (minutes * 60_000);
  const dbPath = toAbsolute(args.get("db") ?? worker.dbPath, repoRoot);
  const freshnessThresholdSec = Math.max(
    1,
    worker.regimeGating.liveness?.feedFreshMaxAgeSec ?? worker.taker.maxStalenessSec
  );

  const { sqlite } = openDatabase(dbPath);

  const latestFeature = sqlite.prepare(
    `SELECT MAX(ts) as maxTs,
            COUNT(*) as n,
            SUM(CASE WHEN staleness_sec IS NOT NULL AND staleness_sec <= ? THEN 1 ELSE 0 END) as freshN,
            AVG(staleness_sec) as avgStale
     FROM latest_features`
  ).get(freshnessThresholdSec) as {
    maxTs: number | null;
    n: number;
    freshN: number | null;
    avgStale: number | null;
  };

  const latestFeatureAgeSec = latestFeature.maxTs != null ? (now - latestFeature.maxTs) / 1000 : null;
  const feedFresh = latestFeatureAgeSec != null && latestFeatureAgeSec <= freshnessThresholdSec;
  const freshRatio = latestFeature.n > 0 ? Number(latestFeature.freshN ?? 0) / latestFeature.n : 0;

  const clobStats = sqlite.prepare(
    `SELECT COUNT(*) as n, MAX(recv_ts_ms) as maxRecvTs
     FROM clob_events
     WHERE recv_ts_ms >= ?`
  ).get(fromTs) as { n: number; maxRecvTs: number | null };

  const orderKinds = sqlite.prepare(
    `SELECT kind, COUNT(*) as c
     FROM shadow_orders
     WHERE ts >= ?
     GROUP BY kind`
  ).all(fromTs) as Array<{ kind: string; c: number }>;

  const fillsByKind = sqlite.prepare(
    `SELECT o.kind as kind, COUNT(*) as c
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE f.ts >= ?
     GROUP BY o.kind`
  ).all(fromTs) as Array<{ kind: string; c: number }>;

  const makerOrders = orderKinds
    .filter((row) => row.kind === "MAKER_BID" || row.kind === "MAKER_ASK")
    .reduce((acc, row) => acc + row.c, 0);
  const takerOrders = orderKinds
    .filter((row) => row.kind === "TAKER_BUY" || row.kind === "TAKER_SELL")
    .reduce((acc, row) => acc + row.c, 0);

  const makerSkipReasons = sqlite.prepare(
    `SELECT decision_reason as reason, COUNT(*) as count
     FROM decision_log
     WHERE ts >= ?
       AND decision = 'SKIP'
       AND kind IN ('MAKER_BID','MAKER_ASK')
     GROUP BY decision_reason
     ORDER BY count DESC
     LIMIT 8`
  ).all(fromTs) as Array<{ reason: string | null; count: number }>;

  const takerSkipReasons = sqlite.prepare(
    `SELECT decision_reason as reason, COUNT(*) as count
     FROM decision_log
     WHERE ts >= ?
       AND decision = 'SKIP'
       AND kind IN ('TAKER_BUY','TAKER_SELL')
     GROUP BY decision_reason
     ORDER BY count DESC
     LIMIT 8`
  ).all(fromTs) as Array<{ reason: string | null; count: number }>;

  const invalidNumericCount = sqlite.prepare(
    `SELECT COUNT(*) as c
     FROM decision_log
     WHERE ts >= ?
       AND decision_reason IN ('invalid_numeric','non_finite_scoreBps','non_finite_edgeLcbBps','non_finite_edgeUcbBps','non_finite_pFillLcb','non_finite_sizeMultiplier')`
  ).get(fromTs) as { c: number };

  const gate = new RegimeGate(
    {
      ...worker.regimeGating,
      reloadMs: 0
    },
    {
      info: () => {},
      warn: () => {},
      error: () => {}
    } as any
  );
  const gateLoad = gate.getLoadDiagnostics();

  const features = sqlite.prepare(
    `SELECT token_id as tokenId,
            market_id as marketId,
            spread,
            bid_depth_top as bidDepthTop,
            ask_depth_top as askDepthTop,
            obi,
            vol30m,
            microprice_minus_mid as micropriceMinusMid
     FROM latest_features
     ORDER BY ts DESC
     LIMIT 25`
  ).all() as FeatureRow[];

  const makerWallets = sqlite.prepare(
    `SELECT id as walletId
     FROM wallets
     WHERE maker_enabled = 1
     ORDER BY id ASC
     LIMIT 5`
  ).all() as Array<{ walletId: number }>;

  const takerWallets = sqlite.prepare(
    `SELECT id as walletId
     FROM wallets
     WHERE auto_trade_enabled = 1
       AND COALESCE(maker_enabled, 0) = 0
       AND COALESCE(taker_side, 'BOTH') != 'NONE'
     ORDER BY id ASC
     LIMIT 5`
  ).all() as Array<{ walletId: number }>;

  const observedRows = sqlite.prepare(
    `SELECT ts, wallet_id as walletId, token_id as tokenId, kind, decision_reason as reason
     FROM decision_log
     WHERE ts >= ?
       AND decision = 'SKIP'
     ORDER BY ts DESC`
  ).all(fromTs) as Array<{ ts: number; walletId: number | null; tokenId: string; kind: string; reason: string | null }>;

  const observedLatest = new Map<string, string>();
  for (const row of observedRows) {
    if (row.walletId == null || row.reason == null) continue;
    if (!regimeReasons.has(row.reason)) continue;
    const key = `${row.walletId}|${row.tokenId}|${row.kind}`;
    if (!observedLatest.has(key)) {
      observedLatest.set(key, row.reason);
    }
  }

  let expectedCompared = 0;
  let expectedMismatches = 0;
  const mismatchSamples: string[] = [];

  for (const feature of features) {
    const f = {
      spread: feature.spread,
      bidDepthTop: feature.bidDepthTop,
      askDepthTop: feature.askDepthTop,
      obi: feature.obi,
      vol30m: feature.vol30m,
      micropriceMinusMid: feature.micropriceMinusMid
    };

    for (const wallet of takerWallets) {
      for (const kind of ["TAKER_BUY", "TAKER_SELL"] as const) {
        const decision = gate.decide(kind, wallet.walletId, f, {
          lane: "taker",
          livenessRelax: false,
          executionMode: worker.executionPolicy.mode
        });
        const key = `${wallet.walletId}|${feature.tokenId}|${kind}`;
        const observed = observedLatest.get(key);
        if (!observed) continue;
        expectedCompared += 1;
        if (observed !== decision.reasonCode) {
          expectedMismatches += 1;
          if (mismatchSamples.length < 10) {
            mismatchSamples.push(`${key}: observed=${observed} expected=${decision.reasonCode}`);
          }
        }
      }
    }

    for (const wallet of makerWallets) {
      for (const kind of ["MAKER_BID", "MAKER_ASK"] as const) {
        const decision = gate.decide(kind, wallet.walletId, f, {
          lane: "maker",
          livenessRelax: false,
          executionMode: worker.executionPolicy.mode
        });
        const key = `${wallet.walletId}|${feature.tokenId}|${kind}`;
        const observed = observedLatest.get(key);
        if (!observed) continue;
        expectedCompared += 1;
        if (observed !== decision.reasonCode) {
          expectedMismatches += 1;
          if (mismatchSamples.length < 10) {
            mismatchSamples.push(`${key}: observed=${observed} expected=${decision.reasonCode}`);
          }
        }
      }
    }
  }

  const mismatchRate = expectedCompared > 0 ? expectedMismatches / expectedCompared : 0;

  const makerStall = feedFresh && makerOrders === 0;
  const takerStall = feedFresh && takerOrders === 0;

  console.log("Stall Audit");
  console.log(`dbPath: ${dbPath}`);
  console.log(`windowMinutes: ${minutes}`);
  console.log(`fromTs: ${fromTs} (${new Date(fromTs).toISOString()})`);
  console.log(`feedFresh: ${feedFresh}`);
  console.log(`latestFeatureAgeSec: ${latestFeatureAgeSec?.toFixed(2) ?? "n/a"}`);
  console.log(`freshnessThresholdSec: ${freshnessThresholdSec}`);
  console.log(`freshFeatureRatio: ${freshRatio.toFixed(4)}`);
  console.log(`avgFeatureStalenessSec: ${latestFeature.avgStale ?? "n/a"}`);
  console.log(`clobEventsInWindow: ${clobStats.n}`);
  console.log(`clobLastRecvTs: ${clobStats.maxRecvTs ?? "n/a"}`);

  console.log("ordersByKind:");
  for (const row of orderKinds) {
    console.log(`  ${row.kind}: ${row.c}`);
  }

  console.log("fillsByKind:");
  for (const row of fillsByKind) {
    console.log(`  ${row.kind}: ${row.c}`);
  }

  console.log(`makerStall: ${makerStall}`);
  console.log(`takerStall: ${takerStall}`);
  console.log(`makerRootCauses: ${topReasons(makerSkipReasons)}`);
  console.log(`takerRootCauses: ${topReasons(takerSkipReasons)}`);

  console.log(`gateLoaded: ${gateLoad.loaded}`);
  console.log(`gateUsingLastGood: ${gateLoad.usingLastGood}`);
  console.log(`gateLoadError: ${gateLoad.lastLoadError ?? "none"}`);
  console.log(`gateManifestWanted: ${gateLoad.manifestStampWanted ?? "none"}`);
  console.log(`gateManifestLoaded: ${gateLoad.manifestStampLoaded ?? "none"}`);

  console.log(`expectedCompared: ${expectedCompared}`);
  console.log(`expectedMismatches: ${expectedMismatches}`);
  console.log(`expectedMismatchRate: ${mismatchRate.toFixed(4)}`);
  if (mismatchSamples.length) {
    console.log("mismatchSamples:");
    for (const sample of mismatchSamples) console.log(`  ${sample}`);
  }

  console.log("Go/No-Go Checklist");
  const checklist = [
    {
      label: "Feed is fresh",
      ok: feedFresh,
      evidence: `latestFeatureAgeSec=${latestFeatureAgeSec?.toFixed(2) ?? "n/a"} threshold=${freshnessThresholdSec}`
    },
    {
      label: "Regime gate loaded",
      ok: gateLoad.loaded,
      evidence: `loaded=${gateLoad.loaded} error=${gateLoad.lastLoadError ?? "none"}`
    },
    {
      label: "No maker stall under fresh feed",
      ok: !makerStall,
      evidence: `makerOrders=${makerOrders} makerReasons=${topReasons(makerSkipReasons)}`
    },
    {
      label: "No taker stall under fresh feed",
      ok: !takerStall,
      evidence: `takerOrders=${takerOrders} takerReasons=${topReasons(takerSkipReasons)}`
    },
    {
      label: "Regime decision parity with logs",
      ok: mismatchRate <= 0.1,
      evidence: `compared=${expectedCompared} mismatches=${expectedMismatches}`
    },
    {
      label: "No invalid numeric regime outputs in logs",
      ok: invalidNumericCount.c === 0,
      evidence: `invalidNumericCount=${invalidNumericCount.c}`
    }
  ];

  let checklistFailed = false;
  for (const item of checklist) {
    const status = item.ok ? "PASS" : "FAIL";
    if (!item.ok) checklistFailed = true;
    console.log(`  [${status}] ${item.label} :: ${item.evidence}`);
  }

  const strict = worker.executionPolicy.mode !== "FULL";
  if (checklistFailed && strict) {
    console.error("NO-GO");
    sqlite.close();
    process.exit(1);
  }
  console.log(checklistFailed ? "NO-GO (non-strict live mode)" : "GO");
  sqlite.close();
};

main();
