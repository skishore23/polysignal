# Agent Guide

Purpose: fast onboarding for contributors and coding agents working in this repo.

## Primary Goal
- Build and validate a decision-only trading system that discovers durable alpha and makes money after costs.
- Near-term target is shadow-mode evidence quality, not live routing:
  - keep execution in paper/shadow,
  - collect realistic maker+taker evidence,
  - pass burn-in and frozen-window gates before any live promotion.
- Every run should produce timestamped evidence artifacts (`reports/evidence/*`) so progress can be audited without re-running analysis.
- Success metric is not "more features"; success metric is positive, reproducible, risk-adjusted edge that survives go-live gates.

## Decision Rule (Goal-First)
- When multiple actions are possible, choose the one with highest expected progress toward profitable, verifiable alpha.
- Prefer fewer, higher-leverage changes over frequent preference-driven churn.
- Do not ask for stylistic preference when objective impact is clear; execute the best technical path and report tradeoffs.
- Keep all work evidence-first: no claims without DB/log/test artifacts.

## Repo Snapshot
- Monorepo with `apps/*` and `packages/*` (pnpm workspace).
- Apps:
  - `apps/worker`: ingestion, feature snapshots, canonical cost engine, belief providers, maker/taker/arb loops.
  - `apps/web`: Next.js UI, API routes, SSE streams.
- Packages: data clients, book cache, feature engine, storage (SQLite/Drizzle), types, utils.
- Root `src/` contains CLI and shared logic used by scripts and historical flows.
- `configs/` stores runtime configs and auto-tuning outputs; worker can rewrite these.

## Quick Commands
- Install: `pnpm install` (or `npm install`).
- Dev: `npm run dev` (runs migrations, then worker + web).
- Run one app: `npm run dev --workspace apps/worker` or `npm run dev --workspace apps/web`.
- Dev process behavior: root `dev` uses `concurrently --kill-others-on-fail` (other process is terminated only when one exits non-zero/failure).
- Tests: `npm test`, `npm run test:unit`, `npm run test:integration`, `npm run test:validation`, `npm run e2e`.
- Typecheck/lint/format: `npm run typecheck`, `npm run lint`, `npm run format`.
- Doctor (full): `npx tsx scripts/doctor.ts --db ./data/dev.db --hours 24 --horizonMs 600000 --strict`.
- Doctor (quick): `npx tsx scripts/archive/manual-diagnostics/doctor-quick.ts --db ./data/dev.db --hours 24 --horizonMs 600000`.
- Go-live gate (hard fail): `pnpm go-live:gate` (runs decision-only invariant scripts, tests, and DB/runtime safety/promotion checks).
  - Paper-trust defaults now require `maker,taker` profile promotion passes, positive/threshold realized PnL checks, and zero non-shadow orders (`execution_mode` in `FULL|LIVE`) unless `--allow-live-flags` is explicitly set.
- Evidence pack (timestamped JSON+MD): `pnpm evidence:pack` (default burn-in advisory promotion check), `pnpm evidence:pack:frozen` (frozen-window advisory promotion check).
- Money loop optimizer: `pnpm money:loop` (analyze recent shadow profitability, auto-tune taker threshold + maker controls (`makerEv.minExpectedEvBps`, `makerEv.quoteHalfSpreadBps`, `makerEv.quoteSize`, `makerEv.maxNotionalPerOrderUsd`, `makerEv.maxInventoryAbs`, `makerEv.inventoryLambdaBps`, `makerEv.tradeFlowGate.staleCancelAgeSec`) + execution-aware arb threshold (`arb.minNetEdgeBps`, using robust/winsorized edge plus execution conversion/success evidence), keep taker/arb lanes enabled, enable regime gate/report, and emit fresh evidence by default), `pnpm money:loop:dry` (advisory-only dry run with no config writes).
- Decision-only invariants:
  - `npx tsx scripts/invariants/no-signal-schema.ts --db data/dev.db`
  - `npx tsx scripts/invariants/decision-chain-integrity.ts --db data/dev.db`
  - `npx tsx scripts/invariants/decisionedge-contract.ts --db data/dev.db --window-min 60`
  - `npx tsx scripts/invariants/decision-log-append-only.ts --db data/dev.db --update=false`
- Counterfactual gate validation: `pnpm counterfactual:gate` (pre-live threshold sweep on historical taker outcomes).
- Execution-realistic replay scorer: `pnpm replay:policy` (queue-scale calibration + maker threshold scoring from recorded orders/trades/fills/markouts).
- Ledger utilities: `npx tsx scripts/archive/manual-diagnostics/ledger-init.ts`, `npx tsx scripts/archive/manual-diagnostics/ledger-list.ts --limit 100`, `npx tsx scripts/archive/manual-diagnostics/ledger-summary.ts --limit 1000`.
- Worker refactor baseline gate: `pnpm verify:baseline` (tests/lint/typecheck/build + paper smoke + generated artifacts in `reports/refactor-baseline/`).
- Hard cutover reset (archive + destructive DB recreate): `npm run db:hard-cutover-reset` (also clears `data/invariants/decision-log-append-only.snapshot.json` so append-only verification re-initializes on fresh DB).
- Archive candidate scan: `pnpm archive:scan` (writes `archive_candidates.json` + `archive_cleanup_plan.md` to `reports/refactor-baseline/`).
- Worker static graph: `pnpm analyze:imports` (writes import graph + reachable/unreachable + barrel/cycle reports to `reports/refactor-baseline/`).
- Worker dead-code guardrails:
  - report mode: `pnpm deadcode:worker`
  - strict mode: `pnpm deadcode:worker:strict`
  - initialize/update allowlist: `pnpm deadcode:worker:allowlist`
- Wallet seeding (single source of truth): `pnpm wallets:seed`, reset + reseed with `pnpm wallets:seed:reset`, audit roles/activity with `pnpm wallets:audit`.
  - BTC-only isolation mode: `pnpm wallets:seed -- --reset --drop-main --btc-only` seeds exactly two wallets (`BTC 5m · Taker Shadow`, `BTC 5m · Maker Shadow`) and requires resolving live BTC 5m markets.
  - BTC + ARB isolation mode: `pnpm wallets:seed -- --reset --drop-main --btc-only --arb-wallet-count 3` seeds BTC taker+maker plus three BTC-pinned ARB attribution wallets.
  - Seed now provisions 12 mixed strategy cohorts (6 taker + 6 maker) by default, with optional wallet-level `market_filter_json`.
- Connectivity debug: `npm run debug:polymarket` (DNS/TCP/TLS/HTTPS/WS probe).
- Web exit debug: `npm run debug:web-dev -- --timeoutSec 20`.

## Safety And Gating
- Runtime architecture is hard-cutover single-path:
  - exactly one lane implementation each for maker/taker/arb.
  - no in-app legacy fallback branches; rollback is commit-level redeploy only.
- Startup verification sequencing:
  - worker warms ingestion/WSS and writes initial feature rows before startup invariant execution.
  - startup `quick=true` now runs only required startup invariants (optional scripts are deferred to background verification) so trading loops start promptly on large DBs.
  - runtime liveness should be interpreted as active-feed freshness, not dormant-token freshness.
  - maker fill-activity invariant is strict only when maker lane is enabled; if `settings.maker_enabled=0` it passes with an explicit `skipped=maker_disabled` note.
  - Regime report generation runs out-of-process (`scripts/regime-report-refresh.ts`) so heavy Markov recompute does not block worker event-loop liveness.
  - retention loop first run is deferred to 10 minutes after startup by default, and feature row volume detection uses fast estimates (`sqlite_sequence`/`MAX(id)`) instead of full `COUNT(*)`.
  - shadow maker metrics cache refresh is bounded and less frequent by default (fills capped per refresh, slower refresh interval) to prevent event-loop stalls on large histories.
  - `/api/performance` runtime/skip diagnostics now use bounded recent `decision_log` slices (by descending `id`) to avoid full-table scans.
- Polymarket fee/reward alignment guardrails:
  - economic taker costs must use canonical dynamic curve math (`apps/worker/src/trading/PolymarketFeeMath.ts`), not flat bps.
  - maker orders are post-only and include signed `feeRateBps` from token metadata.
  - market scope supports `PROFILE_KNOWN_ONLY` and `ALL`; runtime default is `PROFILE_KNOWN_ONLY`, and unknown profiles are fail-closed shadow-only.
  - liquidity scoring uses cents-based spread units with single-sided `c=3` in midpoint band `[0.10, 0.90]`.
  - lane toggles are explicit in `configs/worker.json`: `arb.enabled`, `taker.enabled`.
  - exploration policy: strategy-tuning scripts must not auto-disable maker/anchor exploration lanes; tune thresholds/scope instead.
  - maker side quote toggles are no longer configurable in `worker.json`; maker loop defaults to two-sided quoting and side suppression is handled by EV/regime gates.
  - taker toxicity/adaptive-side gates are default-on internal controls in `TakerLoop`; risk-close still runs under existing hard precedence.
- Execution is currently hard-wired to `PAPER` in `apps/worker/src/config.ts`; environment credentials and `EXECUTION_MODE` do not enable live routing.
- Live CLOB adapters remain dormant for research parity. Re-enabling them requires an explicit, separately reviewed architecture and safety change.
- Order lifecycle is explicit and monotonic for execution rows:
  - Canonical status set: `PENDING | OPEN | PARTIAL | FILLED | CANCELLED | REJECTED`.
  - Transition regressions from terminal states are blocked (`FILLED/CANCELLED/REJECTED` are terminal).
  - Fill accounting is cumulative (`filled_size`, VWAP `filled_price`) and drives `OPEN -> PARTIAL -> FILLED`.
- `apps/worker` and `apps/web` must point to the same `DB_PATH`.
- Wallet roles are explicit and non-overlapping by default:
  - Taker loop only reads wallets with `auto_trade_enabled=1 AND maker_enabled=0`.
  - Maker loop reads wallets with `maker_enabled=1` and requires `settings.maker_enabled=1`.
  - ARB executor writes orders under dedicated attribution wallet `Core · Arb` (auto-created if missing) so lane PnL is wallet-separable.
  - No wallet ID is reserved by maker/taker loops; role flags drive routing.
  - New wallets default to `maker_enabled=0` unless explicitly configured.
- Wallet market filters are enforced in both loops:
  - Structured `market_filter_json` is the only runtime market filter source.
  - Invalid structured filters fail closed per-wallet (`wallet_filter_invalid`), preserving deterministic safety.
  - Worker ingestion auto-refreshes maker/taker wallets named `BTC 5m · *` to current live BTC 5m market IDs during universe refresh (default-on, no flag); ARB wallets are excluded so ARB scope can be broader than BTC 5m.
  - Reason-code contract and examples: `docs/wallet_strategy_filters.md`.

## Evidence-First And Mathematical Correctness
- This system is evidence-first: decisions and claims must be backed by persisted decision/fill/markout evidence and reproducible computations.
- Preserve determinism and mathematical correctness; avoid heuristic shortcuts that change semantics without proof or tests.
- Category-theory inspired framing is acceptable when it helps clarify composition, invariants, and correctness properties.

## Code Conventions
- TypeScript, ES modules, workspace imports like `@polysignal/*`.
- Prefer explicit types and pure functions for deterministic behavior.
- Use `tsx` for scripts in `scripts/`.
- Logging uses `pino` via shared logger utilities.

## Where To Start
- Ingestion + book cache: `apps/worker/src/ingestion`, `packages/data`, `packages/book`.
- Canonical architecture: `docs/architecture.md`.
- Feature engine: `packages/features`.
- Decision chain + execution evidence: `apps/worker/src/trading`, `apps/worker/src/maker`, `apps/worker/src/taker`, `apps/web/lib/queries.ts`.
- Storage + migrations: `packages/storage`, `scripts/migrate.ts`.
- Web UI: `apps/web/app`, `apps/web/components`, `apps/web/lib`.
- Canonical edge/cost layer: `apps/worker/src/trading/CostModel.ts`.
- Belief providers + blend: `apps/worker/src/belief/`.
- Structural arbitrage lane: `apps/worker/src/arb/`.
- Maker/taker loops: `apps/worker/src/maker`, `apps/worker/src/taker`.
- `apps/worker/src/trading/DecisionEngine.ts` now holds canonical taker/maker/arb EV decisions only.
- Markov gating currently fails open (`regimeGating.failOpen=true` in both defaults and `configs/worker.json`) for paper-only exploration. Any future live-execution boundary must require fail-closed gating.
- Regime idle diagnostics commands:
  - `pnpm regime:audit` validates manifest atomicity and last-good fallback simulation.
  - `pnpm stall:audit -- --minutes 30 --db data/dev.db` detects fresh-feed stalls and prints a Go/No-Go checklist.
  - `pnpm replay:tick -- --input data/replay/tick_sample.json` runs deterministic one-tick replay from frozen inputs.
- Refactor evidence is generated locally under `reports/refactor-baseline/`; generated logs and graphs are not committed.
- Runtime reachability tracing is debug-gated in `apps/worker/src/observability/ReachabilityTrace.ts` (`DEBUG_REACHABILITY=1`, optional `DEBUG_REACHABILITY_OUT`).
- Realtime transport: SSE in web app; CLOB market WebSocket (`ws-subscriptions-clob`) in ingestion; REST re-prime on reconnect.
- Experiment ledger: `experiment_runs` table (migration 0041/0042), `GET /api/experiment-ledger`, `scripts/archive/manual-diagnostics/record-experiment.ts`; Performance page "What we know so far" panel (Works / Doesn't / Unclear / Killed ideas).
- Performance UX: `/performance` opens in money-first mode (realized/unrealized/net + activity), with diagnostics hidden behind a header toggle.
- DB-first doctor harness: `scripts/doctor.ts`, `scripts/archive/manual-diagnostics/doctor-quick.ts`, `scripts/lib/doctor.ts`, `scripts/lib/db.ts`, `scripts/lib/metrics.ts`, and artifacts in `reports/doctor/<runId>/`.
- Scriptable diagnostics ledger: `data/ledger.db` via `scripts/lib/ledger.ts` and `scripts/archive/manual-diagnostics/ledger-*.ts` (append-only experiment/check evidence).
- Edge Map: `apps/web/lib/shadowKpi.ts` (`getShadowKpiEdgeMap`), `GET /api/shadow-kpi/edge-map`; Performance page Edge Map card (lane × bucket × horizon, N_cycles/N_fills/N_markouts, CI basis).

## Keep This Updated
Update this file when any of the following change:
- App or package layout, or new top-level directories are introduced.
- Core scripts/commands, test entry points, or dev workflow changes.
- Baseline/import-graph/deadcode scripts or artifact paths change.
- Archive scan workflow, candidate manifests, or archive folder conventions change.
- Runtime gating, safety flags, or config paths change.
- New operational loops or data flows are added.
- UI branding system or shared design tokens change.

Last updated: 2026-08-23
