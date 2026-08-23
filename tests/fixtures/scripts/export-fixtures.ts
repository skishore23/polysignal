// Fixture export tool: Export golden fixtures from database
// Usage: tsx tests/fixtures/scripts/export-fixtures.ts --asset BTC --duration 120 --scenario happy

import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDatabase, runMigrations } from "@polysignal/storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const migrationsPath = path.join(repoRoot, "packages", "storage", "migrations");

const program = new Command();
program
  .option("--asset <asset>", "Asset symbol (BTC, ETH, etc.)", "BTC")
  .option("--duration <seconds>", "Duration in seconds", "120")
  .option("--scenario <scenario>", "Scenario type: happy, reconnect, bad_deltas", "happy")
  .option("--db <path>", "Database path", path.join(repoRoot, "data", "dev.db"))
  .option("--output <path>", "Output directory", path.join(repoRoot, "tests", "fixtures"));

program.parse(process.argv);
const opts = program.opts<{
  asset: string;
  duration: string;
  scenario: string;
  db: string;
  output: string;
}>();

const durationSec = parseInt(opts.duration, 10);
const outputDir = path.resolve(opts.output);

async function exportClobEvents(
  sqlite: Database.Database,
  startTs: number,
  endTs: number,
  outputPath: string
): Promise<void> {
  const rows = sqlite
    .prepare(`
      SELECT global_seq, recv_ts_ms, conn_id, token_id, msg_type, payload_json
      FROM clob_events
      WHERE recv_ts_ms >= ? AND recv_ts_ms <= ?
      ORDER BY global_seq
    `)
    .all(startTs, endTs) as Array<{
      global_seq: number;
      recv_ts_ms: number;
      conn_id: string;
      token_id: string;
      msg_type: string;
      payload_json: string;
    }>;

  const events: Array<{
    t: number;
    type: string;
    marketId?: string;
    tokenId: string;
    [key: string]: unknown;
  }> = [];

  for (const row of rows) {
    const payload = JSON.parse(row.payload_json);
    const event: {
      t: number;
      type: string;
      marketId?: string;
      tokenId: string;
      [key: string]: unknown;
    } = {
      t: row.recv_ts_ms,
      type: row.msg_type === "book" ? "snapshot" : "delta",
      tokenId: row.token_id,
      ...payload
    };

    if (row.msg_type === "book") {
      event.marketId = payload.event_type === "book" ? payload.asset_id : undefined;
      event.bids = payload.bids ?? [];
      event.asks = payload.asks ?? [];
    } else if (row.msg_type === "price_change") {
      event.side = payload.side;
      event.price = payload.price;
      event.size = payload.size;
    }

    events.push(event);
  }

  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(outputPath, lines + "\n", "utf-8");
  console.log(`Exported ${events.length} CLOB events to ${outputPath}`);
}

async function main(): Promise<void> {
  const dbPath = path.resolve(opts.db);
  const { sqlite } = openDatabase(dbPath);
  runMigrations(sqlite, migrationsPath);

  // Determine time range based on scenario
  const now = Date.now();
  let startTs: number;
  let endTs: number;

  if (opts.scenario === "reconnect") {
    // For reconnect scenario, find a period with connection changes
    const rows = sqlite
      .prepare(`
        SELECT recv_ts_ms, conn_id
        FROM clob_events
        ORDER BY global_seq
        LIMIT 1000
      `)
      .all() as Array<{ recv_ts_ms: number; conn_id: string }>;

    if (rows.length === 0) {
      console.error("No events in database");
      process.exit(1);
    }

    // Find first connection change
    let connectionChangeTs = rows[0].recv_ts_ms;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].conn_id !== rows[i - 1].conn_id) {
        connectionChangeTs = rows[i].recv_ts_ms;
        break;
      }
    }

    startTs = connectionChangeTs - durationSec * 1000;
    endTs = connectionChangeTs + durationSec * 1000;
  } else if (opts.scenario === "bad_deltas") {
    // For bad deltas scenario, find period with potential violations
    const rows = sqlite
      .prepare(`
        SELECT recv_ts_ms
        FROM clob_events
        ORDER BY global_seq
        LIMIT 1
      `)
      .get() as { recv_ts_ms: number } | undefined;

    if (!rows) {
      console.error("No events in database");
      process.exit(1);
    }

    startTs = rows.recv_ts_ms;
    endTs = rows.recv_ts_ms + durationSec * 1000;
  } else {
    // Happy path: use recent data
    const rows = sqlite
      .prepare(`
        SELECT MIN(recv_ts_ms) as min_ts, MAX(recv_ts_ms) as max_ts
        FROM clob_events
      `)
      .get() as { min_ts: number; max_ts: number } | undefined;

    if (!rows) {
      console.error("No events in database");
      process.exit(1);
    }

    endTs = rows.max_ts;
    startTs = endTs - durationSec * 1000;
  }

  // Export CLOB events
  const fixtureName = `${opts.asset.toLowerCase()}_${opts.scenario}_${durationSec}s.clob_events.jsonl`;
  const fixturePath = path.join(outputDir, fixtureName);
  await exportClobEvents(sqlite, startTs, endTs, fixturePath);

  sqlite.close();
  console.log(`Fixture exported: ${fixturePath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
