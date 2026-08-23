// Layer 1A: Event logging invariants
// Validates clob_events table consistency with flexible global_seq checks

import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, runMigrations } from "@polysignal/storage";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const migrationsPath = path.join(repoRoot, "packages", "storage", "migrations");

const dbPath = process.env.DB_PATH
  ? path.isAbsolute(process.env.DB_PATH)
    ? process.env.DB_PATH
    : path.join(repoRoot, process.env.DB_PATH)
  : path.join(repoRoot, "data", "dev.db");

let sqlite: Database.Database;

beforeAll(() => {
  const { sqlite: db } = openDatabase(dbPath);
  sqlite = db;
  runMigrations(sqlite, migrationsPath);
});

type ClobEventRow = {
  global_seq: number;
  recv_ts_ms: number;
  conn_id: string;
  token_id: string;
  msg_type: string;
  payload_json: string;
};

describe("Layer 1A: Event Logging Invariants", () => {
  describe("1A.1: Global Sequence Consistency", () => {
    it("should have global_seq strictly increasing (if present)", () => {
      const rows = sqlite
        .prepare("SELECT global_seq, recv_ts_ms, conn_id, token_id FROM clob_events ORDER BY global_seq LIMIT 1000")
        .all() as ClobEventRow[];

      if (rows.length === 0) {
        // No events in DB, skip test
        return;
      }

      const violations: Array<{ global_seq: number; prev_seq: number; token_id: string; conn_id: string }> = [];

      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const curr = rows[i];

        if (curr.global_seq <= prev.global_seq) {
          violations.push({
            global_seq: curr.global_seq,
            prev_seq: prev.global_seq,
            token_id: curr.token_id,
            conn_id: curr.conn_id
          });
        }
      }

      expect(violations.length).toBe(0);
      if (violations.length > 0) {
        console.error("Global sequence violations (first 20):", violations.slice(0, 20));
      }
    });
  });

  describe("1A.2: Receive Timestamp Consistency", () => {
    it("should have recv_ts_ms roughly non-decreasing globally (allow small out-of-order)", () => {
      // In real-time concurrent systems, events from different connections/tokens
      // may arrive with slightly out-of-order timestamps while still getting
      // sequential global_seq values. Allow 1 second tolerance for this.
      const TOLERANCE_MS = 1000;

      const rows = sqlite
        .prepare("SELECT global_seq, recv_ts_ms, conn_id, token_id FROM clob_events ORDER BY global_seq LIMIT 1000")
        .all() as ClobEventRow[];

      if (rows.length === 0) {
        return;
      }

      const violations: Array<{ global_seq: number; recv_ts_ms: number; prev_recv_ts_ms: number; gap_ms: number }> = [];

      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const curr = rows[i];
        const gap = prev.recv_ts_ms - curr.recv_ts_ms;

        // Only flag if timestamp goes backwards by more than tolerance
        if (gap > TOLERANCE_MS) {
          violations.push({
            global_seq: curr.global_seq,
            recv_ts_ms: curr.recv_ts_ms,
            prev_recv_ts_ms: prev.recv_ts_ms,
            gap_ms: gap
          });
        }
      }

      expect(violations.length).toBe(0);
      if (violations.length > 0) {
        console.error("Receive timestamp violations (first 20):", violations.slice(0, 20));
      }
    });

    it("should have recv_ts_ms as integer milliseconds", () => {
      const rows = sqlite
        .prepare("SELECT global_seq, recv_ts_ms FROM clob_events LIMIT 100")
        .all() as Array<{ global_seq: number; recv_ts_ms: number }>;

      for (const row of rows) {
        expect(Number.isInteger(row.recv_ts_ms)).toBe(true);
        expect(row.recv_ts_ms).toBeGreaterThan(1000000000000); // After 2001-09-09
      }
    });
  });

  describe("1A.3: Per-Connection Token Sequence", () => {
    it("should have (conn_id, token_id) -> token_seq strictly increasing", () => {
      // Note: token_seq is not stored in clob_events table
      // This test validates that global_seq is strictly increasing per (conn_id, token_id)
      // which ensures no duplicates or out-of-order events

      const rows = sqlite
        .prepare(`
          SELECT global_seq, recv_ts_ms, conn_id, token_id
          FROM clob_events
          ORDER BY conn_id, token_id, global_seq
          LIMIT 1000
        `)
        .all() as ClobEventRow[];

      if (rows.length === 0) {
        return;
      }

      const violations: Array<{ global_seq: number; prev_seq: number; token_id: string; conn_id: string }> = [];
      const sequenceMap = new Map<string, number>(); // (conn_id, token_id) -> last_global_seq

      for (const row of rows) {
        const key = `${row.conn_id}:${row.token_id}`;
        const lastSeq = sequenceMap.get(key);

        if (lastSeq !== undefined && row.global_seq <= lastSeq) {
          violations.push({
            global_seq: row.global_seq,
            prev_seq: lastSeq,
            token_id: row.token_id,
            conn_id: row.conn_id
          });
        }

        sequenceMap.set(key, row.global_seq);
      }

      expect(violations.length).toBe(0);
      if (violations.length > 0) {
        console.error("Per-connection token sequence violations (first 20):", violations.slice(0, 20));
      }
    });
  });

  describe("1A.4: Payload JSON Validity", () => {
    it("should have valid JSON in payload_json", () => {
      const rows = sqlite
        .prepare("SELECT global_seq, payload_json FROM clob_events LIMIT 1000")
        .all() as Array<{ global_seq: number; payload_json: string }>;

      const violations: Array<{ global_seq: number; error: string }> = [];

      for (const row of rows) {
        try {
          JSON.parse(row.payload_json);
        } catch (error) {
          violations.push({
            global_seq: row.global_seq,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      expect(violations.length).toBe(0);
      if (violations.length > 0) {
        console.error("Payload JSON violations (first 20):", violations.slice(0, 20));
      }
    });
  });

  describe("1A.5: Message Type Validation", () => {
    it("should have msg_type in valid set", () => {
      // Valid message types for trading system:
      // - book: full order book snapshot
      // - price_change: price update event
      // - rest_book: REST API book snapshot
      // - trade: executed trade event
      const validMsgTypes = new Set(["book", "price_change", "rest_book", "trade"]);

      const rows = sqlite
        .prepare("SELECT global_seq, msg_type FROM clob_events")
        .all() as Array<{ global_seq: number; msg_type: string }>;

      const violations: Array<{ global_seq: number; msg_type: string }> = [];

      for (const row of rows) {
        if (!validMsgTypes.has(row.msg_type)) {
          violations.push({
            global_seq: row.global_seq,
            msg_type: row.msg_type
          });
        }
      }

      expect(violations.length).toBe(0);
      if (violations.length > 0) {
        console.error("Message type violations (first 20):", violations.slice(0, 20));
      }
    });
  });
});
