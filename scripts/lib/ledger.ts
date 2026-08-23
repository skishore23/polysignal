import type Database from "better-sqlite3";

export type LedgerVerdict =
  | "pass"
  | "fail"
  | "inconclusive"
  | "works"
  | "doesnt"
  | "unclear"
  | "killed";

export type LedgerEntry = {
  runId: string;
  runTs: number;
  gitHash: string | null;
  configHash: string | null;
  checkName: string;
  hypothesis: string | null;
  paramsJson: string | null;
  sampleJson: string | null;
  resultsJson: string | null;
  verdict: LedgerVerdict;
  nextAction: string | null;
  artifactsPath: string | null;
};

export type LedgerRow = LedgerEntry & {
  id: number;
  createdAt: number;
};

export function initLedgerSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS experiment_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      run_ts INTEGER NOT NULL,
      git_hash TEXT,
      config_hash TEXT,
      check_name TEXT NOT NULL,
      hypothesis TEXT,
      params_json TEXT,
      sample_json TEXT,
      results_json TEXT,
      verdict TEXT NOT NULL,
      next_action TEXT,
      artifacts_path TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
    );
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS experiment_runs_run_id_idx ON experiment_runs (run_id);
    CREATE INDEX IF NOT EXISTS experiment_runs_run_ts_idx ON experiment_runs (run_ts);
    CREATE INDEX IF NOT EXISTS experiment_runs_verdict_idx ON experiment_runs (verdict);
    CREATE INDEX IF NOT EXISTS experiment_runs_check_idx ON experiment_runs (check_name);
  `);

  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS experiment_runs_no_update
    BEFORE UPDATE ON experiment_runs
    BEGIN
      SELECT RAISE(ABORT, 'experiment_runs is immutable');
    END;
  `);

  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS experiment_runs_no_delete
    BEFORE DELETE ON experiment_runs
    BEGIN
      SELECT RAISE(ABORT, 'experiment_runs is immutable');
    END;
  `);
}

export function appendLedgerEntry(sqlite: Database.Database, entry: LedgerEntry): number {
  const stmt = sqlite.prepare(`
    INSERT INTO experiment_runs (
      run_id,
      run_ts,
      git_hash,
      config_hash,
      check_name,
      hypothesis,
      params_json,
      sample_json,
      results_json,
      verdict,
      next_action,
      artifacts_path
    ) VALUES (
      @runId,
      @runTs,
      @gitHash,
      @configHash,
      @checkName,
      @hypothesis,
      @paramsJson,
      @sampleJson,
      @resultsJson,
      @verdict,
      @nextAction,
      @artifactsPath
    )
  `);
  const result = stmt.run({
    runId: entry.runId,
    runTs: entry.runTs,
    gitHash: entry.gitHash,
    configHash: entry.configHash,
    checkName: entry.checkName,
    hypothesis: entry.hypothesis,
    paramsJson: entry.paramsJson,
    sampleJson: entry.sampleJson,
    resultsJson: entry.resultsJson,
    verdict: entry.verdict,
    nextAction: entry.nextAction,
    artifactsPath: entry.artifactsPath
  });
  return Number(result.lastInsertRowid);
}

export function listLedgerEntries(
  sqlite: Database.Database,
  options: { limit?: number; runId?: string; checkName?: string } = {}
): LedgerRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.runId) {
    where.push("run_id = ?");
    params.push(options.runId);
  }
  if (options.checkName) {
    where.push("check_name = ?");
    params.push(options.checkName);
  }

  const limit = Math.max(1, Math.floor(options.limit ?? 100));
  const sql = `
    SELECT
      id as id,
      run_id as runId,
      run_ts as runTs,
      git_hash as gitHash,
      config_hash as configHash,
      check_name as checkName,
      hypothesis as hypothesis,
      params_json as paramsJson,
      sample_json as sampleJson,
      results_json as resultsJson,
      verdict as verdict,
      next_action as nextAction,
      artifacts_path as artifactsPath,
      created_at as createdAt
    FROM experiment_runs
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY run_ts DESC, id DESC
    LIMIT ${limit}
  `;
  return sqlite.prepare(sql).all(...params) as LedgerRow[];
}

export type LedgerSummary = {
  works: number;
  doesnt: number;
  unclear: number;
  byCheck: Array<{
    checkName: string;
    works: number;
    doesnt: number;
    unclear: number;
    total: number;
  }>;
  total: number;
};

function normalizeVerdict(verdict: string): "works" | "doesnt" | "unclear" {
  if (verdict === "pass" || verdict === "works") return "works";
  if (verdict === "fail" || verdict === "doesnt" || verdict === "killed") return "doesnt";
  return "unclear";
}

export function summarizeLedger(rows: LedgerRow[]): LedgerSummary {
  let works = 0;
  let doesnt = 0;
  let unclear = 0;
  const byCheckMap = new Map<string, { works: number; doesnt: number; unclear: number; total: number }>();

  for (const row of rows) {
    const mapped = normalizeVerdict(row.verdict);
    if (mapped === "works") works += 1;
    if (mapped === "doesnt") doesnt += 1;
    if (mapped === "unclear") unclear += 1;

    const key = row.checkName;
    const stat = byCheckMap.get(key) ?? { works: 0, doesnt: 0, unclear: 0, total: 0 };
    stat.total += 1;
    stat[mapped] += 1;
    byCheckMap.set(key, stat);
  }

  const byCheck = Array.from(byCheckMap.entries())
    .map(([checkName, stat]) => ({
      checkName,
      works: stat.works,
      doesnt: stat.doesnt,
      unclear: stat.unclear,
      total: stat.total
    }))
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return a.checkName.localeCompare(b.checkName);
    });

  return {
    works,
    doesnt,
    unclear,
    byCheck,
    total: rows.length
  };
}

