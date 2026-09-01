# @mention/frontend

Universal Mention client for Android, iOS, and the web. It uses Expo Router,
React Native, React Query, Zustand, Bloom, Socket.IO, and the shared
`@mention/shared-types` contracts.

## Runtime boundaries

- Oxy owns authentication and canonical user identity.
- React Query owns server-state fetching and request cancellation.
- `stores/` contains client state; private stores and persisted queries are
  scoped to the current viewer.
- `db/` provides the native SQLite cache and the bounded in-memory web
  implementation. Persisted post rows accept only canonical hydrated DTOs.
- `services/socketService.ts` owns the single Socket.IO connection for the
  active `{viewerId, token}` identity.
- LiveKit/Syra runtime code loads only when a live feature is entered.

## Setup

Use the versions pinned at the monorepo root (Bun 1.3.14 and Node 24.20.0):

```bash
cp packages/frontend/.env.example packages/frontend/.env
bun install --frozen-lockfile
bun run doctor
bun run dev:frontend
```

Only `EXPO_PUBLIC_*` values are exposed to the client. Never put secrets in the
frontend environment file. The available variables and production defaults are
documented in `.env.example`.

Metro development must start from this workspace. The root scripts already use
the correct working directory.

## Commands

From the repository root:

```bash
bun run dev:frontend
bun run build:frontend
bun run test:frontend
bun run lint:frontend
bun run --cwd packages/frontend typecheck
```

From this directory:

```bash
bun run start
bun run start:local
bun run android
bun run ios
bun run web
bun run build
bun run build:analyze
bun run analyze-bundle
bun run test
bun run test:coverage
bun run lint
bun run typecheck
```

`analyze-bundle` measures `dist/`, exporting it first when it is missing. It
takes four flags:

| Flag | Effect |
| --- | --- |
| `--ci` | Exit non-zero when a `bundle-budgets.json` ceiling is breached. The only hard gate. |
| `--json <path>` | Write the full JSON report. |
| `--baseline <path>` | Compare against a previously written JSON report. |
| `--markdown <path>` | Write a Markdown summary, which CI appends to the job step summary. |

Run it with `--source-maps external` output (`bun run build:analyze`), otherwise
the per-source attribution is empty. The `--baseline` comparison is advisory: a
missing, unreadable or differently-versioned baseline prints a note and the run
still succeeds, because a branch with no baseline on record is a normal state
and only the absolute ceilings decide pass or fail. CI restores that baseline
from an Actions cache the `main` branch populates; see `.github/workflows/ci.yml`.

The coverage gate freezes the current untested-code baseline and applies
stricter per-file thresholds to the account-switch and viewer-query-key
boundaries. Jest excludes files with their own thresholds from its reported
`global` gate, so those residual global values intentionally differ from the
all-files summary printed above them.

## Native release APK

For the standalone arm64 Android release command and the required
`NODE_ENV=production` setting, use the repository `AGENTS.md`. A release APK
must contain `assets/index.android.bundle`; otherwise it is a development
client that still depends on Metro.

## Related documentation

- [Repository overview](../../README.md)
- [User mentions](../../docs/mentions.md)
- [Theming](../../docs/THEMING.md)
- [Compose intent URL](docs/INTENT_URL.md)
- [MCP OAuth and linked accounts](../mcp/README.md)

The repository is available under [the Breathe License 1.0](../../LICENSE) — source available, not open source. See the [root README](../../README.md#license).
