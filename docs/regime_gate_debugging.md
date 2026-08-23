# Regime Gate Debugging Runbook

This runbook is for diagnosing maker/taker idle loops when feed is fresh.

## 1) Use deterministic DB audits (loop-trace config removed)

`configs/worker.json` no longer carries an `observability` block for loop traces.
For deterministic idle diagnosis, use the regime + stall audit scripts below against
the same DB window and compare reason-code distributions.

## 2) Audit regime pair load + fallback

```bash
npx tsx scripts/regime_audit.ts
```

Checks:
- manifest exists and is valid
- manifest stamp matches both `_meta.stamp` values
- mtimes for manifest/markov/strategy
- gate load status (`loaded`, `usingLastGood`, `lastLoadError`)
- simulated reload failure keeps last-good snapshot

## 3) Detect stalls and root causes from SQLite

```bash
npx tsx scripts/stall_audit.ts --minutes 30 --db data/dev.db
```

Outputs:
- feed freshness stats
- order/fill counts by kind
- maker/taker skip reasons
- regime expected-vs-observed reason mismatch rate
- Go/No-Go checklist with PASS/FAIL rows

This exits non-zero in paper/shadow when checklist fails.

## 4) Replay one frozen tick deterministically

Build worker once:

```bash
npm run build --workspace apps/worker
```

Replay:

```bash
node apps/worker/dist/tools/replayTick.js --input data/replay/tick_sample.json
```

Input contract (`data/replay/tick_*.json`):
- `env`
- `regimeLoad` metadata
- `regimeRows` keyed by `(walletId, kind, stateId)`
- `maker.candidates[]`
- `taker.opportunities[]`

Output:
- `makerTrace`
- `takerTrace`
- ranked taker opportunities by replayed score

## 5) Evidence SQL snippets

Recent orders/fills:

```sql
SELECT kind, COUNT(*)
FROM shadow_orders
WHERE ts >= strftime('%s','now','-30 minutes') * 1000
GROUP BY kind;
```

Recent skip reasons:

```sql
SELECT kind, decision_reason, COUNT(*)
FROM decision_log
WHERE ts >= strftime('%s','now','-30 minutes') * 1000
  AND decision = 'SKIP'
GROUP BY kind, decision_reason
ORDER BY COUNT(*) DESC;
```

Feed recency:

```sql
SELECT MAX(ts) AS latest_feature_ts,
       AVG(staleness_sec) AS avg_staleness_sec,
       SUM(CASE WHEN staleness_sec <= 20 THEN 1 ELSE 0 END) AS fresh_tokens,
       COUNT(*) AS total_tokens
FROM latest_features;
```

## 6) Expected stall diagnosis outcome

For every tick with `feed.isFresh=true` and `placedOrders=0`, trace must include:
- `whyIdle.code` (single enum)
- stage counts (`generated`, `afterWalletEligibility`, `afterSideFilters`, `afterRisk`, `afterRegime`)
- regime load stamps and fallback status
- top decisions with reason code/detail and filter attribution
