import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

export type SqliteDb = Database.Database;

export const MAKER_KINDS = ["MAKER_BID", "MAKER_ASK", "INVENTORY_REBALANCE"] as const;
export const TAKER_KINDS = ["TAKER_BUY", "TAKER_SELL"] as const;

export type FlowKind = "maker" | "taker" | "all";

export type FillRow = {
  fillId: number;
  fillTs: number;
  orderId: number;
  orderTs: number;
  walletId: number | null;
  tokenId: string;
  marketId: string | null;
  side: "BUY" | "SELL";
  kind: string;
  executionMode: string;
  price: number | null;
  size: number | null;
  method: string | null;
  note: string | null;
  predEdgeBps: number | null;
  spreadBps: number | null;
  feesBps: number | null;
  expectedSlippageBps: number | null;
  expectedAdverseBps: number | null;
  expectedQueueBps: number | null;
  costBps: number | null;
  netEdgeBps: number | null;
  decision: string | null;
  decisionReason: string | null;
  midPx: number | null;
  spreadPx: number | null;
  bidPx: number | null;
  askPx: number | null;
  deltaHat: number | null;
  inventoryIBefore: number | null;
  inventoryIAfter: number | null;
  inventoryDeltaAbs: number | null;
  inventoryPenaltyBps: number | null;
  netEdgeAfterInventoryBps: number | null;
};

export type OrderRow = {
  orderId: number;
  orderTs: number;
  walletId: number | null;
  tokenId: string;
  marketId: string | null;
  side: "BUY" | "SELL";
  kind: string;
  price: number | null;
  size: number | null;
  expectedCancelTs: number | null;
  executionMode: string;
  source: string | null;
  status: string | null;
  filledSize: number | null;
  filledPrice: number | null;
  lastUpdateTs: number | null;
  predEdgeBps: number | null;
  spreadBps: number | null;
  feesBps: number | null;
  expectedSlippageBps: number | null;
  expectedAdverseBps: number | null;
  expectedQueueBps: number | null;
  costBps: number | null;
  netEdgeBps: number | null;
  decision: string | null;
  decisionReason: string | null;
  midPx: number | null;
  spreadPx: number | null;
  bidPx: number | null;
  askPx: number | null;
  deltaHat: number | null;
  inventoryIBefore: number | null;
  inventoryIAfter: number | null;
  inventoryDeltaAbs: number | null;
  inventoryPenaltyBps: number | null;
  netEdgeAfterInventoryBps: number | null;
};

export type MarkoutRow = {
  markoutId: number;
  fillId: number;
  markoutTs: number;
  horizonMs: number;
  midAtFill: number | null;
  midAtHorizon: number | null;
  markoutBps: number | null;
  fillTs: number;
  orderTs: number;
  walletId: number | null;
  tokenId: string;
  marketId: string | null;
  side: "BUY" | "SELL";
  kind: string;
  executionMode: string;
  fillPrice: number | null;
  fillSize: number | null;
  method: string | null;
  note: string | null;
  predEdgeBps: number | null;
  spreadBps: number | null;
  feesBps: number | null;
  expectedSlippageBps: number | null;
  expectedAdverseBps: number | null;
  expectedQueueBps: number | null;
  costBps: number | null;
  netEdgeBps: number | null;
  midPx: number | null;
  spreadPx: number | null;
  bidPx: number | null;
  askPx: number | null;
  deltaHat: number | null;
};

export type DecisionRow = {
  id: number;
  ts: number;
  tokenId: string;
  walletId: number | null;
  kind: string;
  decision: string;
  decisionReason: string | null;
  predEdgeBps: number | null;
  costBps: number | null;
  netEdgeBps: number | null;
  spreadBps: number | null;
  feesBps: number | null;
  expectedSlippageBps: number | null;
  midPx: number | null;
  spreadPx: number | null;
  deltaHat: number | null;
  size: number | null;
  bidPx: number | null;
  askPx: number | null;
  bidDepth: number | null;
  askDepth: number | null;
};

export type QueryWindow = {
  sinceTs?: number;
  untilTs?: number;
  flow?: FlowKind;
  executionMode?: string | null;
  includeSynthetic?: boolean;
  limit?: number;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

function absPath(input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(REPO_ROOT, input);
}

export function parseCliArgs(argv: string[] = process.argv.slice(2)): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === "--") continue;
    if (!raw?.startsWith("--")) continue;
    const eqIdx = raw.indexOf("=");
    if (eqIdx >= 0) {
      args.set(raw.slice(2, eqIdx), raw.slice(eqIdx + 1));
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith("--")) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, "true");
    }
  }
  return args;
}

export function boolArg(args: Map<string, string>, key: string, fallback = false): boolean {
  const raw = args.get(key);
  if (raw == null) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return fallback;
}

export function numberArg(args: Map<string, string>, key: string, fallback: number): number {
  const raw = args.get(key);
  if (raw == null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function stringArg(args: Map<string, string>, key: string, fallback: string): string {
  const raw = args.get(key);
  return raw != null && raw !== "" ? raw : fallback;
}

export function resolveRepoRoot(): string {
  return REPO_ROOT;
}

export function discoverDbPath(explicitPath?: string): string {
  if (explicitPath) return absPath(explicitPath);
  const envPath = process.env.DB_PATH;
  if (envPath && envPath !== "") return absPath(envPath);

  const workerConfigPath = path.join(REPO_ROOT, "configs", "worker.json");
  if (existsSync(workerConfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(workerConfigPath, "utf-8")) as { dbPath?: string };
      if (typeof parsed.dbPath === "string" && parsed.dbPath.trim() !== "") {
        return absPath(parsed.dbPath.trim());
      }
    } catch {
      // Fall through to default.
    }
  }

  return path.join(REPO_ROOT, "data", "dev.db");
}

export function discoverLedgerPath(explicitPath?: string): string {
  if (explicitPath) return absPath(explicitPath);
  const envPath = process.env.LEDGER_DB_PATH;
  if (envPath && envPath !== "") return absPath(envPath);
  return path.join(REPO_ROOT, "data", "ledger.db");
}

export function openReadOnlyDatabase(dbPath: string): SqliteDb {
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  sqlite.pragma("busy_timeout = 30000");
  return sqlite;
}

export function openWritableDatabase(dbPath: string): SqliteDb {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 30000");
  return sqlite;
}

export function safeClose(sqlite: SqliteDb): void {
  try {
    sqlite.close();
  } catch {
    // Ignore close errors for script ergonomics.
  }
}

export function tableExists(sqlite: SqliteDb, tableName: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
    .get(tableName) as { name: string } | undefined;
  return row?.name === tableName;
}

export function getTableColumns(sqlite: SqliteDb, tableName: string): string[] {
  if (!tableExists(sqlite, tableName)) return [];
  const rows = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function missingColumns(
  sqlite: SqliteDb,
  requirements: Record<string, string[]>
): Record<string, string[]> {
  const missing: Record<string, string[]> = {};
  for (const [tableName, requiredCols] of Object.entries(requirements)) {
    if (!tableExists(sqlite, tableName)) {
      missing[tableName] = [...requiredCols];
      continue;
    }
    const cols = new Set(getTableColumns(sqlite, tableName));
    const absent = requiredCols.filter((col) => !cols.has(col));
    if (absent.length > 0) {
      missing[tableName] = absent;
    }
  }
  return missing;
}

function flowKinds(flow: FlowKind): string[] {
  if (flow === "maker") return [...MAKER_KINDS];
  if (flow === "taker") return [...TAKER_KINDS];
  return [];
}

function buildTimeWhere(
  alias: string,
  options: QueryWindow,
  params: Array<string | number>
): string[] {
  const where: string[] = [];
  if (options.sinceTs != null) {
    where.push(`${alias}.ts >= ?`);
    params.push(options.sinceTs);
  }
  if (options.untilTs != null) {
    where.push(`${alias}.ts <= ?`);
    params.push(options.untilTs);
  }
  return where;
}

function buildFlowWhere(
  alias: string,
  flow: FlowKind | undefined,
  params: Array<string | number>
): string | null {
  if (!flow || flow === "all") return null;
  const kinds = flowKinds(flow);
  if (!kinds.length) return null;
  params.push(...kinds);
  const placeholders = kinds.map(() => "?").join(",");
  return `${alias}.kind IN (${placeholders})`;
}

function limitClause(limit: number | undefined): string {
  if (limit == null) return "";
  const safe = Math.max(1, Math.floor(limit));
  return ` LIMIT ${safe}`;
}

export function selectOrders(sqlite: SqliteDb, options: QueryWindow = {}): OrderRow[] {
  const params: Array<string | number> = [];
  const where = buildTimeWhere("o", options, params);

  const flowWhere = buildFlowWhere("o", options.flow, params);
  if (flowWhere) where.push(flowWhere);

  if (options.executionMode != null) {
    where.push("o.execution_mode = ?");
    params.push(options.executionMode);
  }

  const sql = `
    SELECT
      o.id as orderId,
      o.ts as orderTs,
      o.wallet_id as walletId,
      o.token_id as tokenId,
      o.market_id as marketId,
      o.side as side,
      o.kind as kind,
      o.price as price,
      o.size as size,
      o.expected_cancel_ts as expectedCancelTs,
      o.execution_mode as executionMode,
      o.source as source,
      o.status as status,
      o.filled_size as filledSize,
      o.filled_price as filledPrice,
      o.last_update_ts as lastUpdateTs,
      o.pred_edge_bps as predEdgeBps,
      o.spread_bps as spreadBps,
      o.fees_bps as feesBps,
      o.expected_slippage_bps as expectedSlippageBps,
      o.expected_adverse_bps as expectedAdverseBps,
      o.expected_queue_bps as expectedQueueBps,
      o.cost_bps as costBps,
      o.net_edge_bps as netEdgeBps,
      o.decision as decision,
      o.decision_reason as decisionReason,
      o.mid_px as midPx,
      o.spread_px as spreadPx,
      o.bid_px as bidPx,
      o.ask_px as askPx,
      o.delta_hat as deltaHat,
      o.inventory_i_before as inventoryIBefore,
      o.inventory_i_after as inventoryIAfter,
      o.inventory_delta_abs as inventoryDeltaAbs,
      o.inventory_penalty_bps as inventoryPenaltyBps,
      o.net_edge_after_inventory_bps as netEdgeAfterInventoryBps
    FROM shadow_orders o
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY o.ts ASC, o.id ASC
    ${limitClause(options.limit)}
  `;

  return sqlite.prepare(sql).all(...params) as OrderRow[];
}

export function selectFills(sqlite: SqliteDb, options: QueryWindow = {}): FillRow[] {
  const params: Array<string | number> = [];
  const where = buildTimeWhere("f", options, params);

  const flowWhere = buildFlowWhere("o", options.flow, params);
  if (flowWhere) where.push(flowWhere);

  if (options.executionMode != null) {
    where.push("o.execution_mode = ?");
    params.push(options.executionMode);
  }
  if (options.includeSynthetic === false) {
    where.push("(f.method IS NULL OR f.method != 'synthetic_fill')");
  }

  const sql = `
    SELECT
      f.id as fillId,
      f.ts as fillTs,
      o.id as orderId,
      o.ts as orderTs,
      o.wallet_id as walletId,
      o.token_id as tokenId,
      o.market_id as marketId,
      o.side as side,
      o.kind as kind,
      o.execution_mode as executionMode,
      f.price as price,
      f.size as size,
      f.method as method,
      f.note as note,
      o.pred_edge_bps as predEdgeBps,
      o.spread_bps as spreadBps,
      o.fees_bps as feesBps,
      o.expected_slippage_bps as expectedSlippageBps,
      o.expected_adverse_bps as expectedAdverseBps,
      o.expected_queue_bps as expectedQueueBps,
      o.cost_bps as costBps,
      o.net_edge_bps as netEdgeBps,
      o.decision as decision,
      o.decision_reason as decisionReason,
      o.mid_px as midPx,
      o.spread_px as spreadPx,
      o.bid_px as bidPx,
      o.ask_px as askPx,
      o.delta_hat as deltaHat,
      o.inventory_i_before as inventoryIBefore,
      o.inventory_i_after as inventoryIAfter,
      o.inventory_delta_abs as inventoryDeltaAbs,
      o.inventory_penalty_bps as inventoryPenaltyBps,
      o.net_edge_after_inventory_bps as netEdgeAfterInventoryBps
    FROM shadow_fills f
    JOIN shadow_orders o ON o.id = f.order_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY f.ts ASC, f.id ASC
    ${limitClause(options.limit)}
  `;

  return sqlite.prepare(sql).all(...params) as FillRow[];
}

export type MarkoutQueryOptions = QueryWindow & {
  horizonMs: number;
};

export function selectMarkouts(sqlite: SqliteDb, options: MarkoutQueryOptions): MarkoutRow[] {
  const params: Array<string | number> = [options.horizonMs];
  const where = ["m.horizon_ms = ?"];
  where.push(...buildTimeWhere("f", options, params));

  const flowWhere = buildFlowWhere("o", options.flow, params);
  if (flowWhere) where.push(flowWhere);

  if (options.executionMode != null) {
    where.push("o.execution_mode = ?");
    params.push(options.executionMode);
  }
  if (options.includeSynthetic === false) {
    where.push("(f.method IS NULL OR f.method != 'synthetic_fill')");
  }

  const sql = `
    SELECT
      m.id as markoutId,
      m.fill_id as fillId,
      m.ts as markoutTs,
      m.horizon_ms as horizonMs,
      m.mid_at_fill as midAtFill,
      m.mid_at_horizon as midAtHorizon,
      m.markout_bps as markoutBps,
      f.ts as fillTs,
      o.ts as orderTs,
      o.wallet_id as walletId,
      o.token_id as tokenId,
      o.market_id as marketId,
      o.side as side,
      o.kind as kind,
      o.execution_mode as executionMode,
      f.price as fillPrice,
      f.size as fillSize,
      f.method as method,
      f.note as note,
      o.pred_edge_bps as predEdgeBps,
      o.spread_bps as spreadBps,
      o.fees_bps as feesBps,
      o.expected_slippage_bps as expectedSlippageBps,
      o.expected_adverse_bps as expectedAdverseBps,
      o.expected_queue_bps as expectedQueueBps,
      o.cost_bps as costBps,
      o.net_edge_bps as netEdgeBps,
      o.mid_px as midPx,
      o.spread_px as spreadPx,
      o.bid_px as bidPx,
      o.ask_px as askPx,
      o.delta_hat as deltaHat
    FROM shadow_markouts m
    JOIN shadow_fills f ON f.id = m.fill_id
    JOIN shadow_orders o ON o.id = f.order_id
    WHERE ${where.join(" AND ")}
    ORDER BY f.ts ASC, f.id ASC
    ${limitClause(options.limit)}
  `;

  return sqlite.prepare(sql).all(...params) as MarkoutRow[];
}

export function selectDecisions(sqlite: SqliteDb, options: QueryWindow = {}): DecisionRow[] {
  const params: Array<string | number> = [];
  const where = buildTimeWhere("d", options, params);

  const flow = options.flow ?? "all";
  if (flow === "maker") {
    where.push("(d.kind LIKE 'MAKER_%' OR d.kind = 'MAKER')");
  } else if (flow === "taker") {
    where.push("d.kind LIKE 'TAKER_%'");
  }

  const sql = `
    SELECT
      d.id as id,
      d.ts as ts,
      d.token_id as tokenId,
      d.wallet_id as walletId,
      d.kind as kind,
      d.decision as decision,
      d.decision_reason as decisionReason,
      d.pred_edge_bps as predEdgeBps,
      d.cost_bps as costBps,
      d.net_edge_bps as netEdgeBps,
      d.spread_bps as spreadBps,
      d.fees_bps as feesBps,
      d.expected_slippage_bps as expectedSlippageBps,
      d.mid_px as midPx,
      d.spread_px as spreadPx,
      d.delta_hat as deltaHat,
      d.size as size,
      d.bid_px as bidPx,
      d.ask_px as askPx,
      d.bid_depth as bidDepth,
      d.ask_depth as askDepth
    FROM decision_log d
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY d.ts ASC, d.id ASC
    ${limitClause(options.limit)}
  `;

  return sqlite.prepare(sql).all(...params) as DecisionRow[];
}

export function getMaxTs(sqlite: SqliteDb, tableName: string, columnName = "ts"): number | null {
  if (!tableExists(sqlite, tableName)) return null;
  const row = sqlite
    .prepare(`SELECT MAX(${columnName}) as ts FROM ${tableName}`)
    .get() as { ts: number | null } | undefined;
  if (!row?.ts || !Number.isFinite(row.ts)) return null;
  return row.ts;
}

export function resolveWindowAnchorTs(
  sqlite: SqliteDb,
  candidates: Array<{ table: string; column?: string }>
): number {
  const tsValues: number[] = [];
  for (const candidate of candidates) {
    const ts = getMaxTs(sqlite, candidate.table, candidate.column ?? "ts");
    if (ts != null && Number.isFinite(ts)) {
      tsValues.push(ts);
    }
  }
  if (!tsValues.length) return Date.now();
  return Math.max(...tsValues);
}

export function nowMinusHours(anchorTs: number, hours: number): number {
  return anchorTs - Math.max(0, hours) * 60 * 60 * 1000;
}

export function configHash(repoRoot = REPO_ROOT): string | null {
  const configPath = path.join(repoRoot, "configs", "worker.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath);
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

export function shortGitHash(repoRoot = REPO_ROOT): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8"
    });
    if (result.status !== 0) return null;
    const hash = result.stdout?.trim();
    return hash ? hash : null;
  } catch {
    return null;
  }
}

export function toIsoRunId(ts: number, gitHash: string | null): string {
  const iso = new Date(ts).toISOString().replace(/[:-]/g, "").replace(/\.\d{3}Z$/, "Z");
  const suffix = (gitHash ?? "nogit").slice(0, 7);
  return `${iso}_${suffix}`;
}

export type FeatureMidLookup = {
  midAtOrBefore: (tokenId: string, ts: number) => number | null;
  midAtOrAfter: (tokenId: string, ts: number) => number | null;
};

export function createFeatureMidLookup(sqlite: SqliteDb): FeatureMidLookup {
  const beforeStmt = sqlite.prepare(
    `SELECT mid
     FROM features
     WHERE token_id = ? AND ts <= ? AND mid IS NOT NULL
     ORDER BY ts DESC
     LIMIT 1`
  );
  const afterStmt = sqlite.prepare(
    `SELECT mid
     FROM features
     WHERE token_id = ? AND ts >= ? AND mid IS NOT NULL
     ORDER BY ts ASC
     LIMIT 1`
  );
  const beforeCache = new Map<string, number | null>();
  const afterCache = new Map<string, number | null>();

  const readMid = (
    cache: Map<string, number | null>,
    stmt: Database.Statement,
    tokenId: string,
    ts: number
  ): number | null => {
    const key = `${tokenId}:${ts}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const row = stmt.get(tokenId, ts) as { mid: number | null } | undefined;
    const mid = row?.mid != null && Number.isFinite(row.mid) ? row.mid : null;
    cache.set(key, mid);
    if (cache.size > 100_000) {
      // Keep memory bounded in long sweeps.
      const keys = Array.from(cache.keys()).slice(0, 25_000);
      for (const old of keys) cache.delete(old);
    }
    return mid;
  };

  return {
    midAtOrBefore: (tokenId: string, ts: number) => readMid(beforeCache, beforeStmt, tokenId, ts),
    midAtOrAfter: (tokenId: string, ts: number) => readMid(afterCache, afterStmt, tokenId, ts)
  };
}

export type TimeContinuityStats = {
  stream: string;
  rows: number;
  inversions: number;
  majorInversions: number;
  worstBackstepMs: number;
};

export function streamTimeContinuity(
  sqlite: SqliteDb,
  tableName: string,
  tsColumn = "ts",
  orderByColumn = "id",
  majorBackstepMs = 60_000
): TimeContinuityStats {
  if (!tableExists(sqlite, tableName)) {
    return {
      stream: `${tableName}.${tsColumn}`,
      rows: 0,
      inversions: 0,
      majorInversions: 0,
      worstBackstepMs: 0
    };
  }

  const sql = `
    SELECT
      COUNT(*) AS rows,
      COALESCE(SUM(CASE WHEN prev_ts IS NOT NULL AND ${tsColumn} < prev_ts THEN 1 ELSE 0 END), 0) AS inversions,
      COALESCE(SUM(CASE WHEN prev_ts IS NOT NULL AND (prev_ts - ${tsColumn}) >= ? THEN 1 ELSE 0 END), 0) AS majorInversions,
      COALESCE(MAX(CASE WHEN prev_ts IS NOT NULL AND ${tsColumn} < prev_ts THEN (prev_ts - ${tsColumn}) ELSE 0 END), 0) AS worstBackstepMs
    FROM (
      SELECT
        ${tsColumn},
        LAG(${tsColumn}) OVER (ORDER BY ${orderByColumn} ASC) AS prev_ts
      FROM ${tableName}
    ) x
  `;
  const row = sqlite.prepare(sql).get(majorBackstepMs) as {
    rows: number | null;
    inversions: number | null;
    majorInversions: number | null;
    worstBackstepMs: number | null;
  };

  return {
    stream: `${tableName}.${tsColumn}`,
    rows: Number(row.rows ?? 0),
    inversions: Number(row.inversions ?? 0),
    majorInversions: Number(row.majorInversions ?? 0),
    worstBackstepMs: Number(row.worstBackstepMs ?? 0)
  };
}

export function selectFillsMissingMarkout(
  sqlite: SqliteDb,
  params: {
    sinceTs: number;
    untilTs?: number;
    horizonMs: number;
    flow: FlowKind;
    executionMode?: string | null;
    includeSynthetic?: boolean;
  }
): Array<{
  fillId: number;
  fillTs: number;
  orderId: number;
  walletId: number | null;
  tokenId: string;
  kind: string;
  side: "BUY" | "SELL";
  method: string | null;
}> {
  const values: Array<string | number> = [params.horizonMs, params.sinceTs];
  const where = [
    "m.id IS NULL",
    "f.ts >= ?"
  ];
  if (params.untilTs != null) {
    where.push("f.ts <= ?");
    values.push(params.untilTs);
  }
  const flowWhere = buildFlowWhere("o", params.flow, values);
  if (flowWhere) where.push(flowWhere);
  if (params.executionMode != null) {
    where.push("o.execution_mode = ?");
    values.push(params.executionMode);
  }
  if (params.includeSynthetic === false) {
    where.push("(f.method IS NULL OR f.method != 'synthetic_fill')");
  }

  const sql = `
    SELECT
      f.id as fillId,
      f.ts as fillTs,
      o.id as orderId,
      o.wallet_id as walletId,
      o.token_id as tokenId,
      o.kind as kind,
      o.side as side,
      f.method as method
    FROM shadow_fills f
    JOIN shadow_orders o ON o.id = f.order_id
    LEFT JOIN shadow_markouts m ON m.fill_id = f.id AND m.horizon_ms = ?
    WHERE ${where.join(" AND ")}
    ORDER BY f.ts ASC, f.id ASC
  `;
  return sqlite.prepare(sql).all(...values) as Array<{
    fillId: number;
    fillTs: number;
    orderId: number;
    walletId: number | null;
    tokenId: string;
    kind: string;
    side: "BUY" | "SELL";
    method: string | null;
  }>;
}
