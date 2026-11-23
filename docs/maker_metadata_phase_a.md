# ADR-POLY-003 phase-A reader — pending independent admission

This is preparation for the existing Emergent parent, not a new research study
or an admitted market-data run. `scripts/research/maker_metadata_phase_a.py` and
`configs/research/maker-metadata-phase-a.json` define one public unauthenticated
Gamma metadata read. No fresh request has been made by its offline tests. The
ordinary maker, isolated quote sink, source-pinned service and legacy Pi are
unchanged. No CLOB request, subscription, quote, fill or account mutation exists
in this reader.

The existing Gamma client's retries, pagination and volume ordering do not match
the startup's one-response selector. This small reader instead uses direct TLS,
one literal GET, no credentials/proxies/cookies/redirects/retries, a 10-second
absolute process alarm, and a 2 MiB response-body cap. It refuses an existing
process alarm. It is a main-thread Unix CLI, tested on local Python 3.9.6; it is
not a background scheduler or a portable general-purpose HTTP client.

Only independently reviewed exact source and protocol hashes, a one-use run
name, and an explicit unexpired admission window of at most 300 seconds allow
the CLI to reach its network call. The exclusive ignored report directory is
claimed before I/O. Failures, partial bodies, request debit and original fixed
deadline remain retained. Remaining reads/bytes are accounting fields, not
permission to continue or renew the window. Failure stops this startup attempt.
The request clock starts at the original admission check, including local
evidence writes. Wall/monotonic agreement and expiry are checked before
connection construction and again before the GET. Connection construction is
inside the alarm and failure-retention scope. `attempts_consumed` reserves the
one-use slot; `http_requests_started` records whether the GET call was entered,
not proof that a request reached the venue. Setup failure cannot free that slot.
Total TLS/wire bytes and any actual provider charges remain unknown; the source
review must explicitly reconcile body-byte accounting with the original shared
8 MiB limit before admission. The reader does not establish a wire-byte cap.

The proposed raw response schema is deliberately strict and remains unverified
against a current admitted response. Eligible rows must explicitly contain all
five active/closed/archived/acceptingOrders/negRisk booleans, original question
and description, `eventStartTime`/`endDate` in UTC, a five-minute slug/start/end
identity, two distinct decimal token IDs and original Yes/No or Up/Down labels.
They must already be in progress and have at least 60 seconds remaining at
receipt. Choose earliest end, then lexical market ID within that one page;
ambiguous eligible identities abort. No other page, source or market retry is
available. Selection preserves the original label/token ordering and rules text;
it does not prove their truth, supported economic profile, settlement semantics,
fee schedule or Gamma/CLOB correspondence. Missing fields cause rejection, not
fallback or invented facts. An empty page is a retained no-eligible result.

Before running, the current parent must obtain independent exact-hash review of
the endpoint/access route, schema, selector, byte/deadline accounting, executable
and finite protocol. The CLI admission JSON schema is
`ADR_POLY003_PHASE_A_INDEPENDENT_ADMISSION_V1`, with `execution_admitted: true`,
`scope: "ONE_METADATA_READ_ONLY"`, exact `source_sha256` and `protocol_sha256`,
integer `not_before_utc_ms`/`expires_utc_ms`, and a unique
`run_name: "maker-phase-a-…"`. An input file claiming review does not itself
establish independent review or authority. No usable admission is distributed
with this source. The proposed argv after review is the pinned Python executable,
this script, `--independent-admission`, and the exact frozen admission path.

Separate phase-B review must bind selected product/rules/tokens, CLOB identity,
applicable fees/risk, genuine features/flow/clocks, version-valid regime gates,
source bridge and independent quote verifier. It must consume the original
remaining reads/time/bytes; phase-A completion cannot start it automatically.
The reader never admits a quote phase or scientific comparison. ADR-POLY-002's
independent-contract/strongest-joint/generated controls, headroom, seals,
economic costs, queue/partial fills, terminal accounting, grouped transfer,
erasure and learning gates remain unchanged.

Offline verification:

```
python3 -m unittest discover -s tests/research -p test_maker_metadata_phase_a.py -v
```

These 18 synthetic tests replace the transport with local objects; the absolute
alarm check exercises a stalled local response. They prove the enumerated local
behaviors only, including expiry/clock jumps during evidence setup and retained
connection-constructor failures. They do not establish current source capability, venue execution,
maker start, discovery, transfer, advantage, learning or profit.
