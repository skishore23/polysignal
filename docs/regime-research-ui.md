# Regime Research UI: What It Does and What You See

**Page:** `http://localhost:3000/regimes` (or `/regimes` on your deployment)

This document explains what the regime system does, how the UI is built, and how to interpret what you see—including why you might see only TAKER or only MAKER in the strategy combo tables.

---

## What the regime system does

1. **Markov regimes**  
   Feature data (spread, depth, obi, vol, micro) is binned per token and time to form a discrete **state**. State timelines and transitions are computed so we can say “the book was in state X at time T” and “state X transitioned to state Y this often.”

2. **Strategy × regime report**  
   For each **(state, kind, wallet)** we compute:
   - **Count** = number of **fills that had an attributed markout** in the window (at the report’s horizon).
   - **WAvg** = weighted-average markout in bps for those fills (or **—** when there are no such markouts).
   - **Fill rate** = filled orders / total orders in that (state, kind, wallet).

   Rows are included if there is **at least one order** in that (state, kind, wallet) in the window. If there are no markouts, WAvg is null (shown as —) and count is 0; the row still appears so maker/taker visibility is balanced.

3. **Regime gating**  
   When the worker considers a maker or taker action, it looks up the current state and the strategy row for (state, kind, walletId). It **allows** only if:
   - A row exists,
   - Count ≥ minCount,
   - WAvg is not null and WAvg ≥ minWavgBps,
   - And (if minFillRate &gt; 0) fill rate ≥ minFillRate.

   If there is no row, or count is too low, or WAvg is null, the gate uses **failOpen** (allow or block according to config). So “no markouts” is treated as no evidence, not as a hard block.

4. **Data flow**  
   - **Inputs:** SQLite (`features`, `shadow_orders`, `shadow_fills`, `shadow_markouts`), plus config (window hours, horizon ms, bins, features).
   - **Outputs:** `data/markov_regime.json` and `data/strategy_regime_report.json` (paths from `configs/worker.json`: `regimeGating.markovPath`, `regimeReport.outputDir`).
   - The **web app** reads those JSON files from disk (resolved relative to repo root). It does **not** query the DB.

---

## What you see on the UI

### Configuration

- **Window / Horizon / Bins / Features**  
  Come from the report config stored in the JSON (e.g. last 24h, 300000 ms horizon, 3 bins, spread/depth/obi/vol/micro). This is the same config used to generate the report.

### Gating Policy

- **Enabled, Min Count, Min WAvg, Min Fill Rate, Fail Open, Reload**  
  From `configs/worker.json` → `regimeGating`. These are the thresholds and behavior the worker uses when gating maker/taker by regime.

- **Markov JSON / Strategy JSON**  
  Last modified time of the two JSON files. Confirms whether the UI is reading fresh files.

### How We Use This

Short checklist: generate reports → gate by regime → disable bad regimes → review top/bottom combos.

### Model readiness (banner)

At the top of the page, a banner shows:

- **Markouts** = total fills with attributed markouts in the window (sum over all states).
- **States w/ markouts** = number of states that had at least one fill with an attributed markout.
- **Top-10 occupancy covered** = among the 10 highest-occupancy states, how many have any markouts (e.g. 1/10).
- **Pass rate (rows)** = fraction of strategy rows that pass the gate (count ≥ minCount, wavgBps ≥ minWavgBps).
- **Pass rate (weighted)** = sum of `count` for allowed rows / sum of `count` for all rows; shows whether evidence is concentrated or scattered.
- Pass logic now mirrors runtime gate behavior: `minCount`, `minWavgBps`, optional `minFillRate`, and `failOpen` handling for low-count/no-markout rows.
- **Freshness** = Markov and Strategy JSON last-modified times plus Reload interval. Helps catch stale JSON.

If **both** pass rates are ~0%, the banner shows **“Model warming up — safe mode”**.

### Markov Decision Transparency

This panel explicitly separates:

- **Worked** = evidenced rows with positive WAvg.
- **Failed** = evidenced rows with negative WAvg.
- **Flat** = evidenced rows with zero WAvg.
- **No-evidence rows** = rows with orders but no attributed markouts yet.

It also shows an estimated gate impact:

- **Baseline WAvg** over all evidenced rows.
- **Gate-allowed WAvg** over evidenced rows that current thresholds would allow.
- **Gate-blocked WAvg** over evidenced rows that current thresholds would block.
- **Estimated Uplift** = `Gate-allowed WAvg - Baseline WAvg` (count-weighted bps).

This gives a direct answer to “is Markov helping?” in the current window.

### Most common states (Panel A)

- **State, Label, Occupancy** = regime id, human-readable binning, and number of (token, ts) **feature steps** in that state (“where the book spent time”). Sorted by occupancy descending.
- **Markout count** = number of fills with attributed markouts in this state. Shown as 0 when none.
- **Markout** = wavg bps for those fills; **—** when markout count is 0 (so we never show a number without evidence).
- **Coverage** = markout count / occupancy; **—** when occupancy is 0; **&lt;0.1%** when the ratio is tiny for readability.

High occupancy doesn’t mean high evidence; most fills happen in a small subset of states.

### Most evidenced states (Panel B)

- States that have **at least one** fill with an attributed markout, sorted by: (1) markout count desc, (2) notional desc, (3) abs(wavgBps) desc.
- **Columns:** State, Label, Markout count, WAvg (bps), Notional.

This is “where we actually have evidence.”

**Why is Markout — for so many top-occupancy states?**  
Occupancy and markout come from different sources. Occupancy is from **features** (every step in the state timeline). Markout is from **shadow_markouts** joined to orders/fills and attributed to a state. The “top” states by occupancy are where the book spent the most time; they often have **no fills** in them. Fills are sparse and may land in other states. So — is expected. Use Panel B to see which states actually have evidence. If you have many markouts in the DB but still see — everywhere, run `npx tsx scripts/archive/manual-diagnostics/debug-regime-markout-empty.ts` or `scripts/archive/manual-diagnostics/check-markout-coverage.ts` or `pnpm markov-canary` to check attribution.

### Top Transitions

- **From → To** = state transition.
- **Count / Prob** = how often that transition occurred and its empirical probability. Helps see which regimes tend to follow which.

### Best Strategy/Regime Combos

- **State, Kind, Wallet, Count, WAvg, Fill Rate**  
  Same (state, kind, wallet) as in the strategy report.

- The table now shows only **evidenced rows** (`count > 0`, numeric WAvg) and the **top 15 by WAvg**.
- This panel is now strictly “what worked,” not mixed with unknown rows.

### Worst Strategy/Regime Combos

- Same columns, but now only **evidenced rows** (`count > 0`, numeric WAvg).
- The table shows the **bottom 15 by WAvg**, i.e. true negative-performing combos.
- This panel is now strictly “what failed,” not mixed with unknown rows.

### No-Markout Combos (Unknown Outcome)

- Separate table for rows with **orders but no attributed markouts** (WAvg = —).
- These are visible for transparency but excluded from best/worst performance ranking.

---

## Why you might still see one-sided best/worst tables

- Best/Worst tables now include only evidenced rows.
- If only one strategy family (maker or taker) has markout evidence in the window, those tables can still look one-sided.
- Use **No-Markout Combos** to inspect the missing side; it means “unknown evidence,” not automatically good or bad.

---

## Summary

| Section              | Source        | Meaning |
|----------------------|---------------|--------|
| Model readiness      | markov + strategy + gating | Markouts, states w/ markouts, top-10 covered, pass rates (rows + weighted), freshness. |
| Markov transparency  | strategy + gating | Worked/failed/flat evidence, unknown rows, gate-allowed vs blocked WAvg, estimated uplift. |
| Configuration        | Report JSON   | Window, horizon, bins, features used to build the report. |
| Gating Policy        | worker.json   | Thresholds and fail-open behavior used by the worker. |
| Most common states   | markov JSON   | Top states by occupancy; markout count, markout bps (if count &gt; 0), coverage. |
| Most evidenced states| markov JSON   | States with markouts, sorted by markout count then notional then abs(wavgBps). |
| Top Transitions      | markov JSON   | State-to-state transition counts and probabilities. |
| Best Combos          | strategy JSON | Top 15 evidenced rows by WAvg (highest). |
| Worst Combos         | strategy JSON | Bottom 15 evidenced rows by WAvg (lowest). |
| No-Markout Combos    | strategy JSON | Rows with orders but no attributed markouts (unknown outcome). |

The regime UI is **diagnostic**: it shows what the last report run produced and what the gating policy is. It does not run the worker or regenerate the JSON; that happens via RegimeReportLoop or by running `scripts/markov-regime-analysis.ts` and `scripts/strategy-regime-report.ts`.
