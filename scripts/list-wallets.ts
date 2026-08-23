#!/usr/bin/env tsx
import { getDb } from "../apps/web/lib/db.js";

const { sqlite } = getDb();

type Row = { id: number; name: string; starting_balance: number; maker_enabled: number; auto_trade_enabled: number };
const rows = sqlite.prepare(`
  SELECT id, name, starting_balance, maker_enabled, auto_trade_enabled
  FROM wallets ORDER BY id
`).all() as Row[];

console.log("\n=== Wallets ===\n");
if (rows.length === 0) {
  console.log("(none)");
} else {
  console.log("ID   Balance   Role      Maker  Taker  Name");
  console.log("--   ------    --------  -----  -----  ----");
  for (const r of rows) {
    const maker = r.maker_enabled ? "yes" : "no";
    const taker = r.auto_trade_enabled ? "yes" : "no";
    const role =
      r.maker_enabled && r.auto_trade_enabled
        ? "HYBRID"
        : r.maker_enabled
          ? "MAKER"
          : r.auto_trade_enabled
            ? "TAKER"
            : "DISABLED";
    console.log(
      `${String(r.id).padStart(2)}   ${String(r.starting_balance).padStart(7)}   ${role.padEnd(8)}  ${maker.padEnd(5)}  ${taker.padEnd(5)}  ${r.name}`
    );
  }
}

const makerSetting = sqlite.prepare("SELECT value FROM settings WHERE key = 'maker_enabled'").get() as { value: string } | undefined;
console.log("\nGlobal: maker_enabled =", makerSetting?.value ?? "(not set)");
const hybridCount = rows.filter((r) => r.maker_enabled === 1 && r.auto_trade_enabled === 1).length;
if (hybridCount > 0) {
  console.log(`Warning: ${hybridCount} hybrid wallet(s) found (maker+taker both on).`);
}
console.log("");
