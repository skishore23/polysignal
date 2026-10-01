# Public distribution preparation

Publisher: **Kishore Shimikeri**, individual. Name supplied by publisher;
developer-portal identity verification is not yet confirmed.

Plugin: **PolySignal Research**. Price: **free**, no purchases or subscriptions.
Targeting: **all supported countries**, represented by an explicit empty countries
list (no publisher-imposed country restrictions). The directory controls availability.

The source package includes three skills, four offline commands, synthetic fixtures,
Apache-2.0 license, extraction provenance, signal icon and synchronized portable/Codex
manifests. Python 3.10+ and local file/script access are required. This is not a hosted
MCP service. Skills-only submission needs no MCP demo, MCP cases or reviewer login.

## Public pages

README.md describes the plugin and publisher. SUPPORT.md points to GitHub Issues.
PRIVACY.md covers confirmed offline/no-telemetry processing, host processing and
public support posts. TERMS.md identifies the existing Apache-2.0 license, free
use and supported research scope. The manifest must use publicly verified GitHub
URLs for these files; local documents alone do not complete the URL requirements.

## Build and validate

Run `python3 scripts/package-research-plugin.py` from the source repository. The
result is a single-root versioned ZIP and checksum under `dist/plugins/` with an
internal file-hash manifest. The packaging script checks synchronized metadata and
explicitly allowlists files; it excludes datasets and credentials. Run the bundled
Python tests and the target plugin validator before submission.

## Directory steps still required

1. Verify the individual developer identity in the intended OpenAI developer portal.
2. Upload the prepared archive as a draft when authorized; inspect imported metadata,
   all-country targeting, the free-commerce declaration and local-script compatibility.
3. Resolve portal validation or scans, and have the publisher complete the required
   legal/policy attestations. These cannot be inferred from software or this document.
4. Submit for review. After approval, publish the approved release.

A GitHub publication is separate from a directory submission. No directory approval,
verified developer identity, host installation or host-level skill execution is claimed.
