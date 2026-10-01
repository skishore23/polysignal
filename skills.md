# Skills Map

Purpose: a map of domain areas, entry points, and gotchas for this repo.

## Goal Contract (Applies To All Skills)
- Primary objective: find and validate profitable alpha with evidence strong enough for live promotion.
- Current operating mode: shadow-first realism (maker+taker), deterministic accounting, strict gates.
- Skill usage must optimize for:
  - measurable edge after costs,
  - reproducible evidence (decision/fill/markout/invariants),
  - low-churn changes that improve confidence, not cosmetic complexity.
- Prefer workflows that emit timestamped artifacts (`reports/evidence/*`) rather than only console logs.
- If options conflict, choose the path that maximizes expected progress toward passing go-live evidence gates with positive net edge.

## Ingestion And Book State
- Entry points: `apps/worker/src/ingestion`, `packages/data`, `packages/book`.
- Pattern: REST snapshot + CLOB market WS deltas; re-prime on reconnect; top-N universe refresh.
- Gotchas: keep CLOB channel wiring aligned to official docs; book staleness and reconnect backoff remain critical.

## Feature Engine
- Entry points: `packages/features`, `apps/worker/src/state`.
- Pattern: per-second rolling windows; computes mid/spread, OBI, microprice, returns, acceleration, skew, entropy.
- Gotchas: must remain deterministic for replay; avoid hidden time dependencies.

## Decision Chain And Evidence
- Entry points: `apps/worker/src/trading`, `apps/worker/src/maker`, `apps/worker/src/taker`, `apps/worker/src/shadow`, `apps/web/lib/queries.ts`.
- Pattern: canonical row is one `decision_log.id`; downstream outcomes are aggregated from `shadow_orders`/`shadow_fills`/`shadow_markouts`.
- Gotchas: keep decision cardinality one-row-per-decision; avoid reintroducing signal-era joins/tables in runtime/UI code.

## Storage And Migrations
- Entry points: `packages/storage`, `scripts/migrate.ts`, `data/`.
- Pattern: SQLite + Drizzle schema; worker writes both history and `latest_*` snapshot tables.
- Gotchas: web and worker must share `DB_PATH`; migrations should be idempotent.

## Maker, Taker, And Execution
- Entry points: `apps/worker/src/maker`, `apps/worker/src/taker`, `configs/worker.json`.
- Pattern: execution is hard-wired to paper mode in `apps/worker/src/config.ts`; CLOB execution adapters are dormant.
- Canonical fee/rebate/reward math lives in `apps/worker/src/trading/PolymarketFeeMath.ts`; all lanes should consume it through `apps/worker/src/trading/CostModel.ts`.
- Math contract and unsupported historical claims: `docs/math_assurance.md`. Run `pnpm math:assurance` after changes to fees, decision EV, rewards, baskets or inventory. The Python Decimal oracle is in `scripts/math_oracle.py`; golden, differential and property tests are in `tests/trading/math_*.test.ts`.
- Taker quote spread is attribution, not an added cost; fee cash uses the midpoint reference denominator. Maker fill-dependent terms are conditional, and standing rewards are separate. Missing fee metadata is not explicit zero.
- A modeled BUY fee deducted in shares is valued at the prediction target, not charged again as cash. New taker SELLs require held shares of that token.
- Arb complete sets are presently fee-free BUY only; fee-charged net-share matching and SELL inventory/collateral are unsupported and fail closed.
- Belief model is provider-based (`apps/worker/src/belief`) with sportsbook + microstructure priors.
- Gotchas: any attempt to restore live routing is an architecture/safety change and must preserve wallet PnL limits, cooldowns, and promotion gates.
- Shadow metrics gotcha: maker metrics cache refresh is now capped by fill volume and runs at a slower default cadence to keep worker event-loop liveness stable on large DBs.
- Fee-profile gotcha: scope options are `PROFILE_KNOWN_ONLY` and `ALL`; default should stay `PROFILE_KNOWN_ONLY` so unknown profiles fail closed.
- Lane toggles in `configs/worker.json` are first-class controls: `arb.enabled`, `taker.enabled`.
- Exploration policy: auto-tuning scripts should keep maker/taker/arb discovery lanes ON by default; optimize thresholds and scope instead of turning lanes off.
- Maker quote side toggles are not part of `worker.json`; maker stays two-sided by default and EV/regime logic suppresses weak sides.
- Taker guardrails (toxicity + adaptive-side gate) are internal default-on controls in `TakerLoop`; they block only new opens and do not block risk-close.
- Maker gotcha: live maker path must be `postOnly`; batch cap is 15 and should use batch posting APIs.
- Order-state machine gotcha: execution status is canonical (`PENDING/OPEN/PARTIAL/FILLED/CANCELLED/REJECTED`) and transitions are monotonic; terminal states must not be rewritten by late/out-of-order events.
- Wallet role gating: taker loop reads only `auto_trade_enabled=1 AND maker_enabled=0`; maker loop reads `maker_enabled=1` and also needs `settings.maker_enabled=1`.
- ARB attribution: `ArbExecutor` prefers scoped wallets named `BTC 5m · Arb *` when present (hash-routed by decision group); otherwise it falls back to `Core · Arb` (auto-created on demand).
- Wallet identity: there is no special-cased wallet ID for maker/taker eligibility; use wallet flags to control behavior.
- Wallet bootstrap: use `scripts/seed-wallets.ts` (`pnpm wallets:seed`, `pnpm wallets:seed:reset`, `pnpm wallets:audit`) instead of ad hoc wallet-creation scripts.
  - BTC-only isolation mode: `pnpm wallets:seed -- --reset --drop-main --btc-only` keeps only two wallets (BTC 5m taker + maker).
  - BTC + ARB isolation mode: `pnpm wallets:seed -- --reset --drop-main --btc-only --arb-wallet-count 3` keeps BTC taker+maker and adds three BTC-pinned ARB attribution wallets.
- Wallet market filters: `wallets.market_filter_json` (V1) is enforced in maker and taker loops (no legacy allowlist intersection).
- BTC 5m pin self-healing: ingestion auto-refreshes maker/taker wallets named `BTC 5m · *` to current live BTC 5m market IDs each universe refresh (default-on); ARB wallets are excluded so ARB lane can run broader than BTC 5m.
- Fail-closed invariant: invalid `market_filter_json` blocks only that wallet for the tick with reason `wallet_filter_invalid` (loop trace evidence).
- Contract + reason-code reference + test runbook: `docs/wallet_strategy_filters.md`.

## Structural Arb Lane
- Entry points: `apps/worker/src/arb/ArbScannerLoop.ts`, `apps/worker/src/arb/ArbExecutor.ts`.
- Pattern: scanner detects binary parity and negRisk basket inequalities, executor submits grouped multi-leg orders with `decision_group_id`.
- Gotchas: keep leg batches `<= 15`; track partial failures in `arb_executions`; use `shadow_orders.strategy_lane='ARB'` for attribution.

## Experiment Ledger And Edge Map
- Entry points: `packages/storage` (migration `experiment_runs`), `apps/web/app/api/experiment-ledger`, `apps/web/app/api/shadow-kpi/edge-map`, `apps/web/lib/shadowKpi.ts` (`getShadowKpiEdgeMap`), `scripts/archive/manual-diagnostics/record-experiment.ts`.
- Pattern: Ledger = DB-backed run log (hypothesis, params, results, verdict, run_context); Edge Map = single-query raw fills + markouts, in-memory aggregation by (lane, bucket, horizon). CI basis: markouts vs cycles (cycle-cluster bootstrap when ≥2 cycles).
- Gotchas: Ledger run_context includes code_version, config_fingerprint, db_snapshot; N_cycles &lt; 50 shown with warning in UI; "What we know so far" has four verdicts (works, doesnt, inconclusive, killed).

## Doctor Harness And Scriptable Fixes
- Entry points: `scripts/doctor.ts`, `scripts/archive/manual-diagnostics/doctor-quick.ts`, `scripts/lib/doctor.ts`, `scripts/lib/db.ts`, `scripts/lib/metrics.ts`, `scripts/lib/ledger.ts`, `scripts/archive/manual-diagnostics/ledger-init.ts`, `scripts/archive/manual-diagnostics/ledger-append.ts`, `scripts/archive/manual-diagnostics/ledger-list.ts`, `scripts/archive/manual-diagnostics/ledger-summary.ts`.
- Pattern: DB-first invariant suite (A/B/C/D checks) writes reproducible CSV/JSON artifacts under `reports/doctor/<runId>/` and appends one immutable row per check into `data/ledger.db`.
- Gotchas: prefer canonical query helpers in `scripts/lib/db.ts`; keep artifact row ordering stable; each FAIL must include symptom/why/likely-causes/next-fix/repro-artifact/validation-command.
- Promotion gate: `scripts/go-live-gate.ts` (`pnpm go-live:gate`) enforces decision-only invariants + tests + DB freshness/safety/promotion checks; it measures readiness but does not enable live execution.
  - Paper-trust defaults: required profiles are `maker,taker`; gate includes global/profile realized-PnL thresholds and fails if any non-shadow orders/fills (`execution_mode` in `FULL|LIVE`) are present unless explicitly overridden.
  - Startup quick-mode behavior: only required startup invariants run before loops start; optional startup checks (for example append-only audit) are deferred to the background verification loop.
  - Evidence bundle: `scripts/evidence-pack.ts` (`pnpm evidence:pack`, `pnpm evidence:pack:frozen`) writes JSON+Markdown evidence snapshots with invariant status, activity metrics, and promotion readiness.
  - Money optimizer loop: `scripts/money-loop.ts` (`pnpm money:loop` auto-applies recommendations, keeps taker+arb enabled, tunes taker threshold + maker controls (`makerEv.minExpectedEvBps`, `makerEv.quoteHalfSpreadBps`, `makerEv.quoteSize`, `makerEv.maxNotionalPerOrderUsd`, `makerEv.maxInventoryAbs`, `makerEv.inventoryLambdaBps`, `makerEv.tradeFlowGate.staleCancelAgeSec`) + execution-aware arb threshold (`arb.minNetEdgeBps`, from robust/winsorized edge and execution conversion/success evidence), and enables regime gate/report by default; `pnpm money:loop:dry` for advisory-only) writes deterministic recommendation reports under `reports/money-loop/`.
  - Replay policy scorer: `scripts/replay-queue-policy-scorer.ts` (`pnpm replay:policy`) calibrates maker queue scale and ranks threshold candidates using predicted fill replay + realized markout evidence.
  - Maker realism invariant (`scripts/invariants/maker-real-fill-activity.ts`) enforces fill thresholds only when maker lane is enabled; when maker is disabled by config/settings it passes with `skipped=maker_disabled`.
  - Freshness/staleness checks are scoped to recently active tokens (from recent CLOB events), not dormant universe rows.

## Web UI And SSE
- Entry points: `apps/web/app`, `apps/web/components`, `apps/web/lib`.
- Pattern: Next.js app router, Tailwind UI, SSE streams for live updates.
- Gotchas: UI reads from `latest_*` tables for speed; keep queries cheap. `/performance` defaults to money-first with diagnostics toggle so PnL visibility stays primary.
- Performance diagnostics gotcha: runtime-health and skip-breakdown queries now use bounded recent `decision_log` slices to avoid full-table scans on large histories.

## UI Branding And Design
- Entry points: `apps/web/app`, `apps/web/components`, `apps/web/lib`, `apps/web/tailwind.config.ts`.
- Pattern: keep a consistent visual system (type, color, spacing) and define shared tokens before adding new components.
- Gotchas: avoid one-off styles; update shared tokens/components first, then use them everywhere.

## Realtime Transport (SSE / WebSocket)
- Entry points: `apps/web/app` (API + SSE), `apps/worker/src/ingestion`, `packages/data` (WS clients).
- Pattern: SSE for UI streams; CLOB market WebSocket for orderbook deltas; REST re-prime on reconnect.
- Gotchas: backoff, reconnect, and stale data handling must remain explicit and observable; use `scripts/debug-polymarket-connectivity.mjs` (or `npm run debug:polymarket`) locally to distinguish DNS/TCP/TLS/API failures quickly.

## Research And Diagnostics
- Entry points: `scripts/find-profitable-strategy.ts`, `scripts/markov-regime-analysis.ts`, `scripts/report:shadow` flows, `configs/`.
- Pattern: decision/fill/markout-first analysis with reproducible script outputs.
- Gotchas: keep analyses aligned to decision-only schema (no `signals`-table dependencies).

## Markov Regime And Proof
- Entry points: `packages/data/src/regimeAnalysis.ts`, `apps/worker/src/regime/`, `debug/`, `scripts/markov-canary.ts`.
- Pattern: state_id stamped on shadow_orders at decision time; markouts joined for strategy report; `apps/worker/src/trading/DecisionEngine.ts` is the orchestration entry point, and RegimeGate (`decide` / `decideForState`) is the canonical Markov policy evaluator by (state, kind, wallet).
- Observability/debugging: use `scripts/regime_audit.ts`, `scripts/stall_audit.ts`, and `docs/regime_gate_debugging.md` for deterministic idle diagnosis.
- Proof flow: run worker → `npx tsx debug/06-markov-proof.ts` (Steps 1–5) → `pnpm markov-canary` after live session.
- Pre-validation flow: run `pnpm counterfactual:gate` before changing live gates; require clear uplift at target horizon with minimum sample and coverage constraints.
- Gotchas: orders_with_state_id ≥90%, attributed_via_state_id ≥95%; if markouts > 0 and strategy_rows == 0, check joins; `REGIME_GATE_DEBUG_SAMPLE=100` logs every 100 decisions; checked-in `regimeGating.failOpen=true` is for paper exploration only and must become fail-closed before any future live boundary.

## Worker Refactor Guardrails
- Entry points: `scripts/verify_baseline.sh`, `scripts/find_archive_candidates.ts`, `scripts/analyze_import_graph.ts`, `scripts/find_unreachable.ts`, `apps/worker/src/observability/ReachabilityTrace.ts`, `reports/refactor-baseline/`.
- Pattern: archive scan first (`pnpm archive:scan`) to build candidate evidence, then baseline (`pnpm verify:baseline`), then static graph (`pnpm analyze:imports`), then dead-code gate (`pnpm deadcode:worker:strict`). Generated evidence stays under ignored `reports/refactor-baseline/`.
- Gotchas: only delete code with static + runtime + test evidence; keep maker/taker/regime semantics unchanged; runtime reachability must stay debug-gated (`DEBUG_REACHABILITY=1`, optional `DEBUG_REACHABILITY_OUT`).
- Hard cutover rule: new strategy logic must be single-path (no in-app compatibility branches); destructive DB resets are allowed, with optional one-shot rollback capsule export (`npx tsx scripts/cutover/export-escape-capsule.ts --confirm`) before reset. Reset script also clears append-only invariant snapshot so strict startup checks rebase correctly on empty DB.

## Keep This Updated
Update this file when any of the following change:
- New packages or apps are added, renamed, or removed.
- Key entry points move or new runtime loops are introduced.
- Core data flow or gating behavior changes.
- Scripts or configs become the new source of truth.

Last updated: 2026-09-30

## Standalone Research Plugin
- `plugins/polysignal-research/` bundles three offline skills and four Python commands without network, database or trading access. Publisher: Kishore Shimikeri; free; all supported countries.
- Test: `python3 -m unittest discover -s plugins/polysignal-research/tests -v`. Package: `python3 scripts/package-research-plugin.py`.
- `PROVENANCE.json` pins extracted economics; changing it requires mathematical verification and a deliberate source-hash update. Snapshot sweeps do not establish fills, and hash integrity does not authenticate venue evidence.
- Public listing preparation: plugin `DISTRIBUTION.md`; individual developer verification and portal attestations remain separate from local validation.
