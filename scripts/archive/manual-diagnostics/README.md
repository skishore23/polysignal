# Manual Diagnostics Archive

These scripts were moved out of `/scripts` to reduce top-level operational noise.

Status:
- Legacy/manual diagnostics and what-if utilities.
- Not part of default `pnpm` command surface.
- Not required for worker runtime, maker/taker loops, or regime gating.
- Some scripts rely on historical/optional tables and may require legacy data shape.

If you need one, run it explicitly with `npx tsx scripts/archive/manual-diagnostics/<script>.ts`.

Current production fee/reward invariants (for archived scripts touching maker/taker economics):
- Scope default: `CRYPTO_15M_ONLY`; unknown fee-enabled markets are fail-closed.
- Dynamic fee curve (not flat bps) is canonical.
- Fee-equivalent rebate accounting uses market-type pools (crypto 20%, sports 25%).
- Liquidity rewards scoring uses cents-based max spread and single-sided factor `c=3` in midpoint `[0.10, 0.90]`.
- Batch order cap is 15.

For production/CI guardrails, use active commands in root `package.json` (for example `pnpm verify:baseline`, `pnpm analyze:imports`, `pnpm deadcode:worker:strict`, and `pnpm go-live:gate`).
