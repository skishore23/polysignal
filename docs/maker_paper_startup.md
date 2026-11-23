# Isolated paper maker startup

Codex owns this infrastructure work. Emergent's research loop stays checkpointed
until the startup path is ready. The separate Pi agent is not used. This is an
engineering check of the ordinary maker, not a new strategy or discovery claim.

`scripts/research/maker_paper_startup.ts --admission <frozen-file>` connects
validated public observations to the existing `MakerLoop`, canonical
`FeatureEngine`, belief provider and loaded regime gate in a new report-only
SQLite database. It never constructs the fill simulator, live execution gateway,
order client or an existing service/account database. The precommit sink enforces
original asset identity, current book, tick/size, both minimum units, cash and
aggregate pending loss before accepting a SHADOW quote. It never resizes an engine
action to obtain acceptance. The ordinary policy and regime gates remain intact.

The declared opening is simulated cash 10 USDC, zero shares and zero orders.
Unchanged limits are 2 USDC/order, 2 USDC total pending loss, and 4 USDC exposure.
If the venue's USDC minimum exceeds 2, the correct result is a proved skip. A
larger paper allowance is not inferred from the request to start. Every accepted
quote is locally cancelled and reservations released; no fills, paid fees,
settlement, real profit or economic advantage follows from this trace.

## Prospective resource and source recipe

The V2 engineering attempt fetched one broad metadata page and found no eligible
current candidate. Its consumed admission and source evidence remain unchanged.
This prospective V3 recipe fixes that demonstrated lookup problem using the
documented exact-slug route. The fourth read is required by the ordinary maker's
token-specific fee/profile gate. No earlier frozen evaluation or source attempt
is rewritten. The old total-ingress assurance failure remains valid.

1. One public Gamma `/markets/slug/btc-updown-5m-{slotStartSeconds}` object.
   The original five-minute slot, exact URL and request window are frozen before
   acquisition. The returned slug, original start/end and current receipt must
   agree; at least 60 seconds remain at metadata receipt. No broad discovery
   page, pagination, alternative market/source or retry is attempted.
2. An exact version-selected CLOB market read: `/markets/{condition}` for v1 or
   `/clob-markets/{condition}` for v2. No fallback between protocols.
3. `/book?token_id={original-asset-id}`.
4. `/fee-rate?token_id={same-original-asset-id}`.
5. At most one unauthenticated market WebSocket for that original asset, with
   no reconnect. PONG is transport control, not a market observation.

Before any request, an independent review must bind the exact implementation,
protocol, configuration/model files and source/risk predicates. Freeze a unique
admission with those hashes and one UTC window of at most 300 seconds. The run
name is an exclusive single-use evidence directory. A failed attempt is retained
and consumes its attempt; do not rename/reissue it to retry silently.
The review binds that exact run name and evidence mode as well as code/protocol
hashes. Source receipt frontiers are checked again at quote precommit: received
but unprocessed market data, a closed socket, the market's close time or the
original execution deadline invalidate acceptance even during an awaited belief
calculation. Already running callbacks are joined before terminal cancellation
and database closure.

Each HTTPS read is bounded by 10 seconds and rejects at 2 MiB of application
body; the shared application-body budget is 8 MiB, with at most 1000 WebSocket
messages. A delivered WebSocket frame that crosses the remaining budget is
retained and rejected before bridge admission. This does not claim a
pre-delivery network-ingress cap. HTTP framing, TLS/wire bytes, invoices and full
monetary costs remain unknown. No compression, auth, environment proxy, redirect,
provider purchase or source carousel is used.

Gamma's explicit version selects `clobTokenIds` for v1 and `positionIds` for v2;
having both fields does not select a protocol. Preserve the original outcome
label. Gamma's USDC minimum and the book's share minimum are different units and
are checked separately. Unknown fee, clock, book, rule, version or order-age
semantics block acceptance; no missing metadata becomes zero. New observations
are exposed development inputs, excluded from future scientific certification.

## Evidence and verification

All raw data, admissions, transport failures, engine logs and SQLite rows remain
under ignored `reports/evidence/maker-startup-*`. Export aggregates and hashes.
The result records actual quotes or an exact skip/failure, source accounting,
pre/post-cancellation state and remaining liabilities. An offline fixture never
counts as a current-market start, and a risk-valid skip never triggers the owner
notification. A current-input quote remains pending independent verification
until its original source, exact risk arithmetic and terminal state are checked.

Offline regressions cover the real engine path, source-version/identity errors,
both minimum units, wrong ticks/size, stale data, unavailable metadata, over-budget
and concurrent pending liabilities, atomic rejection, source/clock/deadline
failures, callback cleanup and immutable terminal evidence. Tests require no
market calls and do not establish current API availability or profit.

References: [market identity and trading constraints](https://docs.polymarket.com/market-data/market-details),
[order precision and minimums](https://docs.polymarket.com/trading/place-orders),
[compact market parameters](https://docs.polymarket.com/api-reference/markets/get-clob-market-info),
[token fee rate](https://docs.polymarket.com/api-reference/market-data/get-fee-rate).
