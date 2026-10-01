# PolySignal Research

Published by **Kishore Shimikeri**. Free, with no purchases or subscriptions.

[Support](SUPPORT.md) · [Privacy](PRIVACY.md) · [Terms](TERMS.md)

Offline research tools for prediction-market data. Three agent skills wrap four
deterministic Python commands. This package works without the PolySignal monorepo,
Node, a database, credentials, a server, or external Python dependencies.

## Included workflows

| Workflow | Useful question | Command |
| --- | --- | --- |
| Fee scenarios | What remains after my assumed fees and slippage? | `scenario` |
| Depth analysis | How much of this quantity fits inside the supplied book? | `book` |
| Complete-set bound | What conditional floor follows from these net balances and costs? | `bound` |
| Evidence integrity | Does this journal match its manifest and independently retained root? | `journal` |

Requires Python 3.10+ and a desktop agent host that can run local scripts. This is
a skills plugin with bundled executable support files, not an MCP server or a
hosted web/mobile integration. It does not trade or fetch market data.

## Run without an agent

From this extracted package directory:

```sh
python3 scripts/research.py scenario --input examples/scenario.json
python3 scripts/research.py book --input examples/book.json
python3 scripts/research.py bound --input examples/bound.json
python3 scripts/research.py journal --events examples/events.jsonl --manifest examples/manifest.json
python3 -m unittest discover -s tests -v
```

All examples are synthetic. The round trip produces modeled P&L `0.944`; the BUY
book fills 5 of 6 shares for gross notional `2.57`; the conditional set bound is
`0.18`, always with venue authentication false. Missing exits produce intervals.
CLI failures return exit code 2 and JSON on stderr; success returns JSON on stdout.

## Use as a plugin

The archive contains a portable `plugin.json`, three discoverable skills, and a
`.codex-plugin/plugin.json` compatibility manifest. Use the host's plugin import/sharing flow for a local skills plugin.
Public-directory review is a separate step; see `DISTRIBUTION.md`.

For development, each `skills/*/SKILL.md` can also be loaded by a local agent from
this extracted directory. Example prompts:

- “Model a buy at 0.50 and sell at 0.60 using a 0.10 scenario rate, share fees,
  zero slippage, and a 10-unit budget.”
- “Analyze examples/book.json and explain the unfilled quantity.”
- “Check examples/events.jsonl against examples/manifest.json and explain what
  the hash check does and does not establish.”

Read `references/methods.md` for arithmetic and data-format assumptions. Financial
figures are hypothetical results under supplied assumptions, not verified venue
fees, authenticated fills, or evidence of future profitability.

## Provenance and redistribution

Apache-2.0, matching the source repository. See `LICENSE` and `PROVENANCE.json`.
The economics source is copied unchanged; the journal verifier was adapted with
bounded reads and stricter input validation. Preserve those files when sharing.
Research datasets, local paths, account data and credentials are excluded.
