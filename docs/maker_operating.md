# Continuous ordinary paper maker

Owner28 authorizes this separate operating profile. It preserves every old
startup result. This is SHADOW quoting with no fill simulator, live client,
signing or Pi. A resting shadow quote is not a confirmed venue order or fill.

The single virtual bank starts at100USDC. Hard limits are20/order,40aggregate
pending liability/exposure and200shares. Desired liability is20×positive
regime multiplier; exact quantity rounding may lift that soft target to both
venue minima within all hard cash/inventory bounds. Regime/EV/flow/identity and
freshness gates still apply. This differs from the historical10-share target.
InventoryK50bps is normalized by the new200share capacity. It is a declared risk
preference, not discovery, calibrated expected PnL or an economic advantage.

A separately reviewed standing admission binds code/config/models/owner policy.
Start using the kernel-lock launcher from either repository with an ABSOLUTE
admission path:

    /Users/kishore/Emergent/.venv/bin/python scripts/research/maker_operating_service.py --admission /absolute/reviewed/admission.json

Run from Polysignal or use an absolute launcher path. Its exec retains a global
kernel flock so two run names cannot create concurrent operating owners. Existing
state is recovered only from this run's canonical owned epoch DB. Zero-fill
cash/reservations are reconciled before fresh source; quote tails lacking saved
evidence are unverified. Immutable model copies prevent hot reload from changing
reviewed decisions; original/copy/input/owner drift blocks source or quotes.

Each current BTC5min slot gets at most3 explicitly debited attempts, with2/10s
backoff. Each uses4fixed public reads and1WS; resync resets history and releases
quotes. New attempts start with at least60s remaining. Segmented raw journals
rotate8MiB/20k records instead of ending the market window. Queues, memory and
free disk are bounded. Wire costs and full invoices remain unknown. No fallback,
private access or hidden source carousel is provided.

The loop processes frames incrementally, samples actual clocks at>=1s intervals,
and persists sample attempts before derivation. Quotes bind both archive proof
and sample-history prefixes. TTL5s, invalid/stale/closed source, policy rejection,
market close, capacity fault and shutdown cancel reservations. At rollover the
same100USDC virtual bank is carried after zero-liability reconciliation. It does
not create additive per-market capital. A failed guard retains evidence and
checkpoint; it never fabricates fills, settlements, rewards or realized profit.

Read `reports/evidence/<admitted-run>/state.json` for actual status, total quote
events, current reservations and the first-quote evidence path. Raw source,
models, rows and journals stay local. `totalCancellations` counts controller
cancellation events/recovered open orders; engine replacement cancellations are
also retained in the epoch DB and may not be included in that summary counter.
Request stop by creating `<run>/STOP` or signalling the native owned worker.
Restart with the same unmodified admission; a stale STOP file continues to stop
it. A code/config change requires a new reviewed transition, not old-admission
reuse. Do not announce market making from offline tests or a policy skip.

Existing RL-Exp is a restaurant environment; the other Emergent Gym wrapper is
one-step MEV. Neither supplies maker execution rewards. Native maker/accounting
and replay interfaces are used here. A future RL experiment must define and
independently verify original actions, transitions and rewards, then satisfy the
scientific contract/headroom/freeze/strong-control gates. No learning or net
value claim follows from these engineering checks.

V2 retains V1’s29 actual shadow quotes and safe stopped outcome. A valid but
empty book now cancels/restarts the source within the same3attempt policy; an
invalid non-array side remains a correctness fault. Controlled new-admission
carry must bind the prior stopped/reconciled state hash; it copies the same
virtual cash, counters and per-slot attempt debt, never adds funding or clears
an outstanding reservation. All originals remain retained.
