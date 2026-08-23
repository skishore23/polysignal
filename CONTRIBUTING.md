# Contributing to PolySignal

Thanks for helping improve PolySignal. The project values small, evidence-backed changes and mathematical correctness over feature volume.

## Development setup

Requirements:

- Node.js 20
- pnpm 9
- Git

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm migrate
pnpm dev
```

The dashboard runs at `http://localhost:3000`; the worker health endpoint defaults to `http://localhost:3001`.

## Before opening a pull request

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Changes to decision, cost, fill, markout, or migration semantics should also run the relevant invariant and replay checks documented in `agent.md`.

## Engineering rules

- Keep execution paper/shadow-only unless a separately reviewed safety change explicitly alters that boundary.
- Preserve the one-row-per-`decision_log.id` contract.
- Use the canonical cost and Polymarket fee functions; do not duplicate fee math.
- Keep features and replay paths deterministic.
- Make migrations append-only and idempotent. Never edit an applied migration.
- Add tests for behavior changes and persisted evidence for trading claims.
- Store generated logs, reports, databases, and regime artifacts under ignored `data/` or `reports/`.
- Never commit credentials, private keys, database snapshots, or production logs.

## Pull requests

Explain:

1. The problem and intended invariant.
2. The implementation and important tradeoffs.
3. The exact verification commands and results.
4. Any schema, configuration, safety, or operational impact.

For security issues, follow [SECURITY.md](SECURITY.md) rather than opening a public issue.
