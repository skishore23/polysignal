# Mathematical assurance and supported scope

PolySignal evaluates paper decisions; passing arithmetic checks does not establish profitable predictions or realistic venue fills. This document defines the current calculation boundary and the evidence required before historical reports or hosted customer evaluations can be called authoritative.

## Contract version

The current paper fee scenario is `polymarket-docs-2026-09-30`, based on the [Polymarket fee documentation](https://docs.polymarket.com/trading/fees) checked on September 30, 2026. The documentation says `fee = shares × feeRate × p × (1 − p)` and five-decimal USDC precision. It does not prove when those rules began. The checked-in defaults cover crypto (rate 0.07), sports (0.05), and an explicit fee-free case. The source-selected `FeeSchedule` can carry market/token identity and a half-open effective interval `[from, to)`. An as-of computation without a bounded matching schedule fails. No historical schedule is inferred from the current page.

Rounding uses exact decimal-string arithmetic and a pinned half-up tie rule for the paper model. The default settlement scenario deducts fee-equivalent shares from BUY proceeds and USDC from SELL proceeds; an injected schedule can instead charge USDC on both sides. These asset treatments and the tie rule still need authoritative venue conformance receipts before results can be described as historical fills. `feeRateBps = 0` is explicit zero; missing metadata is not. The cost and decision paths reject unknown market profiles and nonfinite or out-of-range inputs.

## Units and cash flows

Let `q` be shares, `p` the executable quote or observed fill price in currency per share, `v` the expected value per share at a named horizon, and `side = +1` for BUY or `−1` for SELL. With cash-denominated costs and rewards:

```text
gross_value = side × q × (v − p)
net_value   = gross_value − cash_costs + cash_rewards
reference_notional = q × mid_price > 0
net_edge_bps = 10,000 × net_value / reference_notional
```

The entry spread is embedded in `p`. A `spreadBps` diagnostic does not become a second deduction. A cash fee is converted to bps on `reference_notional`, not on execution notional. For a BUY share fee, the decision cost is `fee_shares × v`, not the quote-price USDC equivalent and not both. The same target `v` must be used for gross edge and share-fee valuation. Inventory penalties are policy adjustments, not cash P&L.

For maker decisions the implemented all-or-nothing approximation is:

```text
expected_policy_bps = fill_probability ×
  (quote_edge_bps − fill_cost_bps + fill_rebate_bps)
  + standing_reward_bps − submission_cost_bps − inventory_penalty_bps
```

The quote edge already measures `v − quote` (or `quote − v` for SELL). `fill_probability = 0` removes per-fill economics. Legacy and expected rebates may not both be counted. This approximation does not model correlated partial fills, markout/queue selection, or an empirically proven liquidity-reward payout.

The raw liquidity order score follows the [published dimensionless rule](https://docs.polymarket.com/programs/liquidity-rewards): `((maxSpreadCents − distanceCents) / maxSpreadCents)^2 × size × multiplier`. It requires an eligible, size-adjusted midpoint and qualifying market settings; the score is not a guaranteed payment.

## Inventory and basket rules

Reducing a shadow position without crossing zero preserves its average basis. A full close resets basis; a sign flip opens the residual at the new fill price. A finite mark in `[0, 1]` is valid, including zero. Missing or invalid marks return unavailable at the position helper instead of a fabricated zero return. Current dashboard aggregates still need complete mark-coverage reporting before a portfolio total is authoritative.

Basket costs are summed as currency amounts and only then divided by one declared capital base. A complete-set arb requires matched **net** shares across outcomes. The current scanner uses one common gross size and submits only fee-free BUY baskets. It suppresses fee-charged BUY baskets (the modeled BUY fee removes shares) and SELL baskets (no inventory/collateral proof). New taker SELL orders also require held shares of the same token. Partial fills and legging remain exposure, not realized arbitrage.

## Reproducible checks

`pnpm math:assurance` is an offline CI gate. Its hand-derived tests cover G01–G16 from the supplied plan where there is a supported primitive, including an independent event-cash ledger for G13–G15. It now also exercises paper fill → accounting event → SQLite → report and compares cash, inventory, fees, realized and net P&L against that independent ledger. It checks duplicate posting, corrections, settlement, missing fees and marks, and legacy-fill gaps. `scripts/math_oracle.py` uses only Python's standard-library `Decimal` and no production imports. Differential tests compare 1,000 fixed-seed cases each for fee, single-fill value, reward score and partial-close inventory. Property checks run 1,000 cases per family for quote/mid equivalence, current fee symmetry, score-unit invariance, basis preservation, no-fill behavior and cost monotonicity. Ratio comparisons use `1e-12 + 1e-10 × |reference|` absolute-plus-relative tolerance; posted five-decimal fees are checked at their documented unit. Zero cases, missing oracle output, or nonfinite results fail the tests.

## Runtime accounting v1

Migration `0048_accounting_events.sql` introduces immutable, idempotent postings for opening state, transfers, fills, settlements and corrections. `postAccountingEvent` validates known cash/share/fee identities before insertion. A confirmed or simulated correction names a prior event in the same account and excludes it from subsequent reports; failed corrections have no effect, and provisional corrections leave the target intact while marking the report incomplete; a replacement is a separate posting. Events carry source identity, account/order/trade/token references, event and receipt times, finality independent of order status, fee evidence, rule version, rounding policy and collateral asset. A paper fill and its order-state update commit in one SQLite transaction. A repeated event key with changed economics is rejected.

New shadow fills use `SIMULATED` finality. Taker fees are modeled from the current paper fee scenario when token metadata identifies a supported profile; an unknown profile produces `MISSING` fee evidence. Maker and inventory-rebalance fills assume zero fee under `paper-maker-zero-fee-v1`; no rebate or reward is credited. Neither modeled treatment is evidence of a venue debit. Actual observed cash/share movements can be posted with `OBSERVED` fee evidence by a future import adapter. Existing fills are not backfilled.

To establish an evaluation boundary, post an `OPENING` event for each account's cash and each held token (the latter includes `tokenId`, `netSharesDelta` and acquisition `price`). Post external funding as `TRANSFER`; a resolved token's `SETTLEMENT` has `netSharesDelta = -heldShares`, `price = 0 or 1`, and `cashDelta = heldShares × price`. Supply stable `eventKey`, `sourceRef` and `processingOrder` values from the source. The storage API is currently the ingestion boundary; there is no customer CSV/JSONL importer yet.

`GET /api/accounting-report?walletId=<integer>&valuationTs=<epoch-ms>` folds postings in `(event_ts, processing_order, event_key)` order and identifies unposted shadow fills, provisional events, missing fees, missing cash/share movements, unsupported shorts, missing opening state and missing or stale marks (older than 60 seconds). Optional `asOfReceiptTs=<epoch-ms>` freezes which received corrections/postings are included; omitted means all currently persisted events. `POST /api/accounting-report` with those fields freezes the full JSON report in `accounting_reports`; `GET /api/accounting-report?reportId=<hash>` retrieves the saved artifact even after marks or corrections change. The report exposes cash, external funding, realized trading P&L, cash and share fees, positions, valuation and an event trace. `netPnl` is `null` when the scoped evidence is incomplete. `reportId` hashes the input projection, accounting version and code version (`GIT_COMMIT_SHA` or `VERCEL_GIT_COMMIT_SHA`; otherwise `unavailable`) without SQLite row IDs. For a reproducible release, set one of those version variables and retain the source snapshot. `assurance` distinguishes posting/data completeness, source verification and simulation assumptions. The legacy `/api/performance` P&L remains separate and gross of fee postings.

The regression suite was first run against the reviewed code; all eight immediate golden groups failed before the fixes. Existing tests for the superseded curve were updated to explicit current-contract expectations. Production code never generates the golden answer key.

Unposted-fill detection uses the same event and receipt cutoffs as the event fold. A later posting cannot hide a retained fill gap or change a report frozen before that posting became eligible. This does not supply missing receipt timestamps for historical shadow rows or authenticate their historical availability.

A matching event key only discharges a retained fill gap when it identifies a `FILL` posting for the same account with `SIMULATED` or `CONFIRMED` finality. A failed posting, a different account's posting or a non-fill event cannot establish that the retained fill has been accounted for. This check does not authenticate venue execution or reconstruct missing opening inventory.

## Not yet certified

- Historical fee effective dates, venue rounding ties and fee payment assets are not verified by the current documentation alone. Prior reports must be treated as old-model scenarios until re-run with pinned historical rules; no old evidence is deleted.
- The new event stream covers future `ShadowExecutionLoop` paper fills. Historical fills, user WebSocket fills and external transfers/settlements are not automatically ingested; reports name retained unposted shadow fills, and opening state must be supplied before a report is complete. The dashboard's legacy `netPnl` remains gross of fees and incomplete when open marks are missing. It must not be used as fee-adjusted promotion evidence.
- The test-only cash/share ledger covers synthetic cash and share fees, settlement, transfers, duplicates and unsupported shorting. Runtime-to-report comparison uses it as an independent oracle; it is not a migration of historical runtime data.
- The microstructure prior remains a heuristic, not a calibrated settlement probability or validated future-price forecast. Execution fill/queue realism, causal data availability and holdout validation remain separate work.
- The production dashboard is protected when credentials are configured and unavailable without them, but Basic auth provides only single-instance isolation. Multi-customer hosted access, per-customer authorization, retention and deletion are not implemented.

Before a hosted pilot or live promotion, complete those gaps with pinned code/data/rule manifests, independent review, full event reconciliation and explicit unsupported-case reporting. The checked-in worker remains paper-only.
