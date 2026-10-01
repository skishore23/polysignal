# Standalone research plugin

Source: `plugins/polysignal-research/`. Build: `python3 scripts/package-research-plugin.py`.
Output: `dist/plugins/polysignal-research-0.1.2.zip` and its SHA-256 sidecar.

## Extraction choice

The monorepo's reusable value is deterministic arithmetic and evidence discipline.
This first package extracts those workflows without requiring a worker, market
feed, SQLite state or credentials. Three skills invoke four offline Python
commands. Runtime economics remains unchanged. A hosted market-discovery MCP or
an authenticated dashboard would require a separate product and hosting boundary;
this release does not claim either capability.

The economics module is copied unchanged from the existing working tree and its
hash recorded in `PROVENANCE.json`. The journal verifier adapts the source format
with bounded input, duplicate-key rejection and optional independent-root checking.
Existing research files and unrelated working-tree changes were preserved.

## Verification performed

- 14 Python tests passed from source and again from the extracted ZIP in a temporary
  directory outside the repository. Includes 500 fixed-seed cash/share scenarios,
  hand arithmetic, missing versus zero exit, liquidity shortfall, invalid inputs,
  conditional receipts, tampering and a rewritten chain with an independent root.
- All four CLI commands exercised successfully against synthetic inputs, including
  journal verification from the extracted ZIP. CLI failure behavior tested.
- Extracted file hashes match `CONTENTS.sha256.json`; ZIP CRC validation passed.
- Signal icon is a real 1254×1254 PNG, 852007 bytes, generated and inspected.
  The generation prompt is included in assets.
- `git diff --check` passed.
- Publisher supplied Kishore Shimikeri, free distribution and all supported countries.
  Both manifests now include that identity. Portal verification remains unconfirmed.

No host installation or live skill invocation was tested. No account upload or public-directory submission has occurred. No worker,
database, live market query, or financial recommendation was involved in testing.

## Next preparation step

Public GitHub documentation covers the plugin, support, privacy and terms. Confirm
publisher identity in the developer portal, inspect imported listing metadata,
complete attestations and submit for review. Directory publication follows approval.
See the plugin's `DISTRIBUTION.md`. A public source branch is not directory approval.

## Publication preparation update — 2026-10-01

The Codex plugin validator passed after confirmed publisher metadata was added.
All four listing pages are public, were opened without authentication, and are
pinned to GitHub commit 56e5cff4952324632ff6f4ce96b581d0ca781b00 in the portable manifest; the older Codex overlay lacks supportURL support.
Country targeting uses [] and review.commerce is false, consistent with the
current official plugin-submission documentation. Individual verification remains
unconfirmed. Start at https://platform.openai.com/settings/organization/general,
then use https://platform.openai.com/plugins for the submission draft.

## GitHub Pages site — 2026-10-01

https://skishore23.github.io/polysignal/ now hosts the project overview, animated
signal illustration, 168 exact synthetic scenarios, direct ZIP download and
support/privacy/terms/methods pages. Plugin 0.1.2 points its listing URLs to the
verified site. GitHub Pages serves only generated artifacts from gh-pages, while
source remains in PR #9. The site is live; directory submission remains pending.
