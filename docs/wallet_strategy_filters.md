# Wallet Strategy Filters

Wallet filters create deterministic market cohorts without changing maker, taker, or regime mathematics.

## Runtime Contract

- Runtime source of truth: `wallets.market_filter_json`.
- Shared type: `WalletMarketFilterV1` in `packages/types/src/walletFilters.ts`.
- Parser and normalizer: `packages/utils/src/walletFilters.ts`.
- Runtime gate: `apps/worker/src/trading/WalletMarketGate.ts`.
- Maker and taker compile the filter once per wallet per tick.
- Invalid JSON or invalid bounds fail closed for that wallet with `wallet_filter_invalid`.

The older `market_allowlist` column remains in storage and API compatibility surfaces, but it is not evaluated by the maker/taker runtime gate.

## Shape

```json
{
  "version": 1,
  "includeMarketIds": ["market_a"],
  "excludeMarketIds": ["market_b"],
  "minVolumeUsd": 10000,
  "maxVolumeUsd": 5000000,
  "minLiquidityUsd": 5000,
  "maxLiquidityUsd": 500000,
  "requireActive": true,
  "allowedKinds": ["TAKER_BUY", "MAKER_BID"]
}
```

Allowed kinds are `TAKER_BUY`, `TAKER_SELL`, `MAKER_BID`, and `MAKER_ASK`.

## Evaluation

For a valid filter, the gate evaluates:

1. Market ID exists.
2. Explicit exclusion.
3. Optional inclusion set.
4. Optional order-kind set.
5. Optional active-market requirement.
6. Optional minimum and maximum volume.
7. Optional minimum and maximum liquidity.

A missing market metric fails closed when the filter requires that metric.

Reason codes:

- `wallet_filter_invalid`
- `market_id_missing`
- `market_explicitly_excluded`
- `market_not_included`
- `market_kind_not_allowed`
- `market_inactive`
- `market_volume_missing`
- `market_volume_below_min`
- `market_volume_above_max`
- `market_liquidity_missing`
- `market_liquidity_below_min`
- `market_liquidity_above_max`

## BTC 5-Minute Wallets

During universe refresh, ingestion updates structured include IDs for maker/taker wallets named `BTC 5m · *` to the current live BTC five-minute markets. Arb wallets are excluded from this self-healing pin so their scope can remain broader.

## Verification

```bash
pnpm test -- tests/trading/wallet_market_gate.test.ts
pnpm test -- tests/web/wallets_route_market_filter.test.ts
pnpm typecheck
```

For runtime evidence, start the worker in paper mode and inspect persisted decision reason codes:

```bash
pnpm --filter @polysignal/worker run dev
```
