import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("go-live realism gate", () => {
  it("fails frozen phase when freeze fingerprint baseline is missing", () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(__dirname, "..", "..");
    const workDir = mkdtempSync(path.join(tmpdir(), "go-live-freeze-"));
    const dbPath = path.join(workDir, "gate.db");
    const manifestPath = path.join(workDir, "freeze-manifest.json");
    const baselinePath = path.join(workDir, "missing-baseline.json");

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE shadow_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        wallet_id INTEGER,
        token_id TEXT,
        kind TEXT,
        execution_mode TEXT,
        side TEXT
      );
      CREATE TABLE shadow_fills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        order_id INTEGER,
        price REAL,
        size REAL,
        method TEXT
      );
      CREATE TABLE shadow_markouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        fill_id INTEGER,
        horizon_ms INTEGER,
        markout_bps REAL
      );
      CREATE TABLE latest_features (
        token_id TEXT PRIMARY KEY,
        ts INTEGER,
        mid REAL,
        staleness_sec REAL
      );
      CREATE TABLE clob_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recv_ts_ms INTEGER,
        token_id TEXT,
        msg_type TEXT
      );
      CREATE TABLE decision_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        token_id TEXT,
        decision TEXT,
        kind TEXT,
        strategy_lane TEXT
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    db.prepare("INSERT INTO latest_features (token_id, ts, mid, staleness_sec) VALUES ('t1', ?, 0.5, 0)").run(Date.now());
    db.prepare("INSERT INTO settings (key, value) VALUES ('maker_live_execution', '0')").run();
    db.close();

    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          paths: ["configs/worker.json"]
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = spawnSync(
      "npx",
      [
        "tsx",
        "scripts/go-live-gate.ts",
        "--db",
        dbPath,
        "--skip-invariants",
        "--skip-tests",
        "--phase",
        "frozen",
        "--freeze-manifest",
        manifestPath,
        "--freeze-baseline",
        baselinePath,
        "--min-trades-15m",
        "0",
        "--max-feature-stale-ratio",
        "1",
        "--min-fresh-rows-5m",
        "0",
        "--max-synthetic-fill-ratio",
        "1",
        "--max-taker-fills-per-order",
        "999",
        "--promotion-days",
        "0",
        "--global-min-decisions",
        "0",
        "--global-min-fills",
        "0",
        "--global-min-markouts",
        "0",
        "--profile-min-decisions",
        "0",
        "--profile-min-fills",
        "0",
        "--profile-min-markouts",
        "0",
        "--maker-real-fill-rate-min",
        "0",
        "--maker-real-fills-min",
        "0",
        "--taker-close-ratio-min",
        "0",
        "--taker-one-sided-max",
        "1"
      ],
      { cwd: repoRoot, encoding: "utf-8" }
    );

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("Freeze fingerprint");
  });
});
