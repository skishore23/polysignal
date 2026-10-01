# Methods and boundaries

This package composes validated inputs → deterministic arithmetic → labeled evidence.
Each stage preserves what is known and what remains an assumption. No stage upgrades
user assertions into authenticated venue facts.

The extracted economics module is byte-for-byte PolySignal source, pinned in
`PROVENANCE.json`. The CLI uses a local 60-digit Decimal context. Decimal outputs
are strings. Inputs are bounded to nine integer digits and twelve fractional digits;
probabilities and rates are additionally bounded to [0,1]. Entry prices are in
[0.000001,0.999999] before slippage. Slippage is 0..1000 bps. These are implementation
bounds, not statements about venue order limits. The model rejects tiny share-fee
scenarios where posted fee rounding would exceed the acquired position.

For a BUY, shares are sized down to six places. Cash fees count against budget;
share fees reduce the position and are not charged again as cash. A modeled SELL
uses six-place available shares and charges a cash fee. Its unsold fractional
remainder is reported separately. Exit null retains [0, net shares] possible value;
exit zero is a known zero-price disposal. Binary collateral is assumed to pay one
unit per matched complete set. All scenarios require explicit rates; this package
contains no current venue fee schedule and no market-data client.

Journal serialization follows Python JSON with sorted keys, compact separators,
default ASCII escaping, finite values, then UTF-8 encoding. Each hash excludes the
`hash` field and includes `sequence` and `previousHash`; initial previousHash is 64
zeroes. Preserve original numeric representation: this is the existing PolySignal
format, not a claim of cross-language canonical JSON compliance. Duplicate JSON
keys and nonfinite values are rejected. The manifest root/count are checked, and an
optional independent root adds an external comparison, not venue authentication.

The tools perform no network requests, DB access, subprocess dispatch or credential
lookup. User-selected JSON files are limited to 4 MB, journals to 100 MB and records
to 4 MB. The scripts print results; the host may store input/output files or send
conversation data according to its own operation. Those host practices are outside
this code's scope and need accurate coverage in a publisher's privacy policy.
