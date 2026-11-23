/** ADR-POLY-003 offline preparation only. No CLI, source collector, fill model or live gateway. */
import Database from "better-sqlite3";
import { openSync, closeSync, realpathSync } from "node:fs";
import path from "node:path";
import { MakerLoop } from "../../apps/worker/src/maker/MakerLoop";
import { BeliefEngine } from "../../apps/worker/src/belief/BeliefEngine";
import { MicrostructureBeliefProvider } from "../../apps/worker/src/belief/MicrostructureBeliefProvider";
import { RegimeGate } from "../../apps/worker/src/regime/RegimeGate";

type Clock = { utc: number; mono: number };
export type StartupContract = {
  purpose: "SYNTHETIC_OFFLINE_ENGINEERING";
  market: string; condition: string; wallet: number;
  tokens: readonly [string, string];
  book: { token: string; bid: string; ask: string; tick: string; lot: string; minimum: string;
    receipt: Clock; venueUtc: number; valid: boolean; sourceHash: string };
  fee: { perShareUSDC: string; provenance: string } | null;
};
const SCALE = 1_000_000_000n;
const USD = SCALE * SCALE;
const isolatedDatabases = new WeakSet<Database.Database>();
const guardedDatabases = new WeakSet<Database.Database>();
// Exact original decimals, up to nine places; unsupported precision fails instead of rounding.
function decimal(value: unknown): bigint {
  if (typeof value !== "string" && typeof value !== "number") throw Error("decimal_type");
  const s = String(value);
  if (!/^\d+(?:\.\d{1,9})?$/.test(s)) throw Error("decimal_precision_or_domain");
  const [whole, fraction = ""] = s.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(9, "0"));
}
const fail = (message: string): never => { throw Error(`startup:${message}`); };
function requireThat(ok: unknown, reason: string): asserts ok { if (!ok) fail(reason); }
const integerTime = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
type Order = Record<string, any>;

/** Exclusive new local file only; caller owns schema/fixture loading, never a production connection. */
export function newOfflineDatabase(file: string, canonicalSchema: string): Database.Database {
  const dir = realpathSync(path.dirname(file));
  const allowed = realpathSync(path.resolve("reports/evidence"));
  requireThat(dir.startsWith(allowed + path.sep), "isolated_report_directory_required");
  requireThat(path.basename(file).endsWith(".sqlite"), "sqlite_suffix_required");
  closeSync(openSync(file, "wx", 0o600));
  const db = new Database(file, { fileMustExist: true });
  try { db.exec(canonicalSchema); isolatedDatabases.add(db); return db; }
  catch (err) { db.close(); throw err; } // Keep failed file as evidence, never overwrite/retry it.
}

/** A DB precommit boundary. This is conservative paper liability, never paid cash or profit. */
export function installStartupSink(db: Database.Database, input: StartupContract, now: () => Clock) {
  requireThat(isolatedDatabases.has(db), "exclusive_offline_database_required");
  const contract: StartupContract = JSON.parse(JSON.stringify(input));
  requireThat(contract.purpose === "SYNTHETIC_OFFLINE_ENGINEERING", "offline_only");
  requireThat(contract.market && contract.condition && Number.isSafeInteger(contract.wallet), "identity");
  requireThat(contract.tokens.length === 2 && contract.tokens.every(t => typeof t === "string" && t.length > 0)
    && contract.tokens[0] !== contract.tokens[1] && contract.tokens.includes(contract.book.token), "tokens");
  requireThat(/^[a-f0-9]{64}$/.test(contract.book.sourceHash), "source_hash");
  for (const table of ["shadow_orders", "shadow_fills", "decision_log"])
    requireThat((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n === 0, "nonempty_sink");
  const rejections: { reason: string; proposed: Order; clock: Clock }[] = [];
  let last = now();
  const opening = JSON.stringify({ cashUSDC: "10", shares: Object.fromEntries(contract.tokens.map(t => [t, "0"])),
    funding: "synthetic_offline_only", paidFees: null, creditedRewards: null, settlement: null, profit: null });
  db.exec("CREATE TABLE startup_opening (record TEXT NOT NULL)");
  db.prepare("INSERT INTO startup_opening VALUES (?)").run(opening);
  db.exec(`CREATE TRIGGER startup_opening_update BEFORE UPDATE ON startup_opening BEGIN SELECT RAISE(ABORT,'immutable_opening'); END;
    CREATE TRIGGER startup_opening_delete BEFORE DELETE ON startup_opening BEGIN SELECT RAISE(ABORT,'immutable_opening'); END;
    CREATE TRIGGER startup_opening_insert BEFORE INSERT ON startup_opening BEGIN SELECT RAISE(ABORT,'immutable_opening'); END;`);

  function liability(o: Order): bigint { return decimal(o.size) * (decimal(o.price) + decimal(contract.fee!.perShareUSDC)); }
  function pending(): bigint {
    return (db.prepare("SELECT * FROM shadow_orders WHERE status IN ('PENDING','OPEN','PARTIAL')").all() as Order[])
      .reduce((sum, o) => sum + liability(o), 0n);
  }
  function validate(o: Order, existing: Order[]): void {
    const clock = now();
    requireThat(integerTime(clock.utc) && Number.isFinite(clock.mono) && clock.mono >= 0
      && integerTime(last.utc) && Number.isFinite(last.mono), "clock");
    requireThat(clock.utc >= last.utc && clock.mono >= last.mono, "backward_clock");
    last = clock;
    const b = contract.book;
    requireThat(b.valid === true && integerTime(b.receipt.utc) && Number.isFinite(b.receipt.mono)
      && b.receipt.mono >= 0 && integerTime(b.venueUtc), "book_receipt");
    const utcAge = clock.utc - b.receipt.utc, monoAge = clock.mono - b.receipt.mono;
    requireThat(utcAge >= 0 && utcAge <= 1000 && monoAge >= 0 && monoAge <= 1000
      && Math.abs(utcAge - monoAge) <= 100 && b.venueUtc <= b.receipt.utc
      && b.receipt.utc - b.venueUtc <= 1000, "stale_or_inconsistent_clock");
    requireThat(contract.fee && typeof contract.fee.provenance === "string" && contract.fee.provenance.trim(), "unknown_fee_bound");
    decimal(contract.fee.perShareUSDC);
    const p = decimal(o.price), q = decimal(o.size), tick = decimal(b.tick), lot = decimal(b.lot), minimum = decimal(b.minimum);
    const bid = decimal(b.bid), ask = decimal(b.ask);
    requireThat(tick > 0n && lot > 0n && minimum > 0n && bid > 0n && ask < SCALE && bid < ask, "metadata_or_book");
    requireThat(p > 0n && p < SCALE && q > 0n && p % tick === 0n && q % lot === 0n && q >= minimum, "tick_lot_minimum");
    requireThat(o.wallet_id === contract.wallet && o.market_id === contract.market && o.token_id === b.token, "original_identity");
    requireThat(o.side === "BUY" && o.kind === "MAKER_BID" && o.strategy_lane === "MAKER" && p < ask, "unowned_sell_or_crossing");
    requireThat(o.execution_mode === "SHADOW" && o.external_order_id === null && o.status === "OPEN"
      && o.filled_size === 0 && o.filled_price === null && o.source === "maker_loop" && o.decision === "SUBMIT", "mode_or_fill");
    requireThat(typeof o.client_order_id === "string" && o.client_order_id.length > 0
      && typeof o.decision_group_id === "string" && o.decision_group_id.length > 0, "stable_identity");
    requireThat(integerTime(o.ts) && o.ts >= b.receipt.utc && o.ts <= clock.utc
      && integerTime(o.expected_cancel_ts) && o.expected_cancel_ts > clock.utc && o.expected_cancel_ts <= o.ts + 5000, "order_clock");
    const own = liability(o), total = own + existing.reduce((sum, row) => sum + liability(row), 0n);
    requireThat(own <= 2n * USD, "order_cap");
    requireThat(total <= 2n * USD && total <= 4n * USD && total <= 10n * USD, "aggregate_pending_loss");
  }
  // JSON binds actual persisted row fields; rejection receipts survive engine transaction rollback.
  db.function("startup_check", (raw: string, existing: string) => {
    const proposed = JSON.parse(raw);
    try { validate(proposed, JSON.parse(existing)); return 1; }
    catch (error) { rejections.push({ reason: String(error), proposed, clock: now() }); throw error; }
  });
  const columns = (db.prepare("PRAGMA table_info(shadow_orders)").all() as any[]).map(c => c.name as string);
  const rowJson = `json_object(${columns.map(c => `'${c}', NEW.${c}`).join(",")})`;
  const immutable = columns.filter(c => !["status", "last_update_ts"].includes(c))
    .map(c => `NEW.${c} IS NOT OLD.${c}`).join(" OR ");
  db.exec(`
    CREATE UNIQUE INDEX startup_client_unique ON shadow_orders(client_order_id);
    CREATE UNIQUE INDEX startup_group_unique ON shadow_orders(decision_group_id);
    CREATE UNIQUE INDEX startup_submit_unique ON decision_log(decision_group_id) WHERE decision='SUBMIT';
    CREATE TRIGGER startup_order_insert BEFORE INSERT ON shadow_orders BEGIN SELECT startup_check(${rowJson},
      (SELECT json_group_array(json_object('price',price,'size',size)) FROM shadow_orders WHERE status IN ('PENDING','OPEN','PARTIAL'))); END;
    CREATE TRIGGER startup_order_update BEFORE UPDATE ON shadow_orders BEGIN
      SELECT CASE WHEN OLD.status != 'OPEN' OR NEW.status != 'CANCELLED' OR (${immutable})
        OR NEW.last_update_ts IS NULL OR NEW.last_update_ts < OLD.last_update_ts
        THEN RAISE(ABORT,'startup:immutable_order_or_terminal_transition') END; END;
    CREATE TRIGGER startup_order_delete BEFORE DELETE ON shadow_orders BEGIN SELECT RAISE(ABORT,'startup:no_order_delete'); END;
    CREATE TRIGGER startup_fill_insert BEFORE INSERT ON shadow_fills BEGIN SELECT RAISE(ABORT,'startup:no_fills'); END;
    CREATE TRIGGER startup_fill_update BEFORE UPDATE ON shadow_fills BEGIN SELECT RAISE(ABORT,'startup:no_fills'); END;
    CREATE TRIGGER startup_fill_delete BEFORE DELETE ON shadow_fills BEGIN SELECT RAISE(ABORT,'startup:no_fills'); END;
    CREATE TRIGGER startup_submit BEFORE INSERT ON decision_log WHEN NEW.decision='SUBMIT' BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM shadow_orders o WHERE o.decision_group_id=NEW.decision_group_id
        AND o.token_id=NEW.token_id AND o.wallet_id=NEW.wallet_id AND o.kind=NEW.kind AND o.ts=NEW.ts
        AND o.size=NEW.size AND o.strategy_lane=NEW.strategy_lane AND o.status='OPEN')
        THEN RAISE(ABORT,'startup:orphan_submit') END; END;
    CREATE TRIGGER startup_decision_update BEFORE UPDATE ON decision_log BEGIN SELECT RAISE(ABORT,'startup:immutable_decision'); END;
    CREATE TRIGGER startup_decision_delete BEFORE DELETE ON decision_log BEGIN SELECT RAISE(ABORT,'startup:immutable_decision'); END;
  `);
  guardedDatabases.add(db);
  return {
    rejections,
    snapshot() {
      return { contract: JSON.parse(JSON.stringify(contract)) as StartupContract, opening: JSON.parse(opening), orders: db.prepare("SELECT * FROM shadow_orders ORDER BY id").all(),
        decisions: db.prepare("SELECT * FROM decision_log ORDER BY id").all(),
        fills: db.prepare("SELECT * FROM shadow_fills").all(), pendingLiabilityNumerator: pending().toString(), denominator: USD.toString() };
    },
    cancelAll() {
      requireThat((db.prepare("SELECT COUNT(*) AS n FROM shadow_fills").get() as any).n === 0, "unexpected_fill");
      db.prepare("UPDATE shadow_orders SET status='CANCELLED',last_update_ts=? WHERE status='OPEN'").run(now().utc);
      requireThat(pending() === 0n, "terminal_liability");
      return { syntheticCashUSDC: "10", shares: Object.fromEntries(contract.tokens.map(t => [t, "0"])),
        pendingLiabilityUSDC: "0", fills: 0, paidFeesUSDC: null, rewardsUSDC: null, settlementUSDC: null, profitUSDC: null };
    }
  };
}

/** One existing private tick through its established test seam. Never start the recurring scheduler. */
export async function oneOfflineMakerTick(db: Database.Database, config: any, logger: any) {
  requireThat(guardedDatabases.has(db), "installed_sink_required");
  requireThat(config.executionMode === "PAPER" && config.regimeGating.enabled, "ordinary_paper_config");
  const gate = new RegimeGate(config.regimeGating, logger);
  requireThat(gate.getLoadDiagnostics().loaded && !gate.getLoadDiagnostics().usingLastGood, "regime_not_loaded");
  const belief = new BeliefEngine([new MicrostructureBeliefProvider()], config.belief, { sqlite: db, logger });
  const engine = new MakerLoop({ ...config.makerEv, ...config.fees,
    intervalMs: 10000, orderTtlMs: 5000, executionMode: "PAPER", marketScope: "PROFILE_KNOWN_ONLY",
    regimeModulation: config.regimeGating.modulation,
    // Registered scope overrides only; no change to ordinary EV/flow/belief/regime policy.
    maxNotionalPerOrderUsd: 2, enableBidQuotes: true, enableAskQuotes: false,
    rebateShareAssumption: 0, liquidityRewardBpsWhenScoring: 0 }, { sqlite: db, logger, belief, regimeGate: gate });
  await (engine as any).tick();
  return gate.getLoadDiagnostics();
}
