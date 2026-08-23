#!/usr/bin/env npx tsx
/**
 * Verify Edge Visibility + Feed Clarity implementation.
 * Checks: schema, edge trace on shadow_orders, decision_log, decision chain, edge calibration.
 *
 * Usage: pnpm run verify:edge
 *   REPO_ROOT should be set by the npm script; otherwise defaults to script dir parent.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.REPO_ROOT) {
  process.env.REPO_ROOT = path.join(__dirname, "..");
}

const { getDb } = await import("../apps/web/lib/db");
const { getDecisionChain } = await import("../apps/web/lib/evidence");
const { getEdgeCalibration } = await import("../apps/web/lib/edge-calibration");

const runAll = <T>(sql: string, params: unknown[] = []): T[] =>
  getDb().sqlite.prepare(sql).all(...params) as T[];

type CheckResult = { name: string; passed: boolean; detail: string };

function checkSchema(): CheckResult[] {
  const results: CheckResult[] = [];
  const tables = runAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  );
  const tableSet = new Set(tables.map((t) => t.name));

  if (!tableSet.has("shadow_orders")) {
    results.push({ name: "shadow_orders exists", passed: false, detail: "table missing" });
    return results;
  }
  results.push({ name: "shadow_orders exists", passed: true, detail: "ok" });

  const cols = runAll<{ name: string }>("PRAGMA table_info(shadow_orders)");
  const colSet = new Set(cols.map((c) => c.name));
  const edgeCols = [
    "pred_edge_bps",
    "pred_source",
    "cost_bps",
    "net_edge_bps",
    "decision",
    "decision_reason"
  ];
  const missing = edgeCols.filter((c) => !colSet.has(c));
  if (missing.length > 0) {
    results.push({
      name: "edge columns on shadow_orders",
      passed: false,
      detail: `missing: ${missing.join(", ")}`
    });
  } else {
    results.push({ name: "edge columns on shadow_orders", passed: true, detail: "ok" });
  }

  if (!tableSet.has("decision_log")) {
    results.push({ name: "decision_log exists", passed: false, detail: "table missing" });
  } else {
    results.push({ name: "decision_log exists", passed: true, detail: "ok" });
  }

  return results;
}

function checkEdgeTrace(): CheckResult[] {
  const results: CheckResult[] = [];
  const since = Math.floor(Date.now() / 1000) - 86400;

  const orders = runAll<{
    id: number;
    kind: string;
    pred_edge_bps: number | null;
    net_edge_bps: number | null;
    decision: string | null;
    pred_source: string | null;
  }>(
    "SELECT id, kind, pred_edge_bps, net_edge_bps, decision, pred_source FROM shadow_orders WHERE ts >= ? ORDER BY ts DESC LIMIT 20",
    [since]
  );

  if (orders.length === 0) {
    results.push({
      name: "edge trace on recent orders",
      passed: true,
      detail: "no recent orders (ok for empty DB)"
    });
    return results;
  }

  const withEdge = orders.filter(
    (o) =>
      o.pred_edge_bps != null || o.net_edge_bps != null || o.decision != null || o.pred_source != null
  );
  const pct = Math.round((withEdge.length / orders.length) * 100);
  if (withEdge.length === 0) {
    results.push({
      name: "edge trace on recent orders",
      passed: false,
      detail: `${orders.length} orders, none have edge columns set`
    });
  } else {
    results.push({
      name: "edge trace on recent orders",
      passed: true,
      detail: `${withEdge.length}/${orders.length} orders have edge trace (${pct}%)`
    });
  }

  return results;
}

function checkDecisionLog(): CheckResult[] {
  const results: CheckResult[] = [];
  const tables = runAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='decision_log'"
  );
  if (tables.length === 0) {
    results.push({ name: "decision_log queryable", passed: false, detail: "table missing" });
    return results;
  }

  try {
    const rows = runAll<{ decision: string; decision_reason: string; cnt: number }>(
      `SELECT decision, decision_reason, COUNT(*) as cnt FROM decision_log
       WHERE ts >= ? GROUP BY decision, decision_reason`,
      [Math.floor(Date.now() / 1000) - 900]
    );
    const total = rows.reduce((acc, r) => acc + r.cnt, 0);
    if (total === 0) {
      results.push({
        name: "decision_log (last 15min)",
        passed: true,
        detail: "no SKIP events (ok if no net_edge_le_0 skips)"
      });
    } else {
      const summary = rows.map((r) => `${r.decision}:${r.decision_reason}=${r.cnt}`).join(", ");
      results.push({
        name: "decision_log (last 15min)",
        passed: true,
        detail: `${total} events: ${summary}`
      });
    }
  } catch (e) {
    results.push({
      name: "decision_log queryable",
      passed: false,
      detail: String(e)
    });
  }
  return results;
}

function checkDecisionChain(): CheckResult[] {
  try {
    const events = getDecisionChain(10, null);
    const types = new Set(events.map((e) => e.type));
    return [
      {
        name: "getDecisionChain",
        passed: true,
        detail: `${events.length} events, types: ${[...types].join(", ")}`
      }
    ];
  } catch (e) {
    return [{ name: "getDecisionChain", passed: false, detail: String(e) }];
  }
}

function checkEdgeCalibration(): CheckResult[] {
  try {
    const cal = getEdgeCalibration(300_000);
    return [
      {
        name: "getEdgeCalibration",
        passed: true,
        detail: `taker buckets=${cal.taker.buckets.length} maker buckets=${cal.maker.buckets.length} fills=${cal.combined.takerFills + cal.combined.makerFills}`
      }
    ];
  } catch (e) {
    return [{ name: "getEdgeCalibration", passed: false, detail: String(e) }];
  }
}

function main(): void {
  console.log("=== EDGE VISIBILITY + FEED CLARITY VERIFICATION ===\n");

  const all: CheckResult[] = [
    ...checkSchema(),
    ...checkEdgeTrace(),
    ...checkDecisionLog(),
    ...checkDecisionChain(),
    ...checkEdgeCalibration()
  ];

  let passed = 0;
  for (const r of all) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`${icon} ${r.name}: ${r.detail}`);
    if (r.passed) passed++;
  }

  console.log(`\n---`);
  console.log(`Passed: ${passed}/${all.length}`);
  if (passed < all.length) {
    console.log("❌ VERIFICATION FAILED");
    process.exit(1);
  }
  console.log("✅ ALL EDGE VISIBILITY CHECKS PASSED");
  process.exit(0);
}

main();
