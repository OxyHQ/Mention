# Mention

Cross-platform social app (iOS, Android, web) with ActivityPub federation, built as a Bun monorepo.

## Commands

Run from the repo root with Bun (the version pinned in `packageManager`).

```bash
bun install                 # postinstall builds shared-types and the publishing SDK
bun run dev                 # all workspaces; dev:frontend / dev:backend / dev:mcp for one
bun run build               # shared-types + backend + mcp
bun run test                # shared-types, backend, mcp, frontend suites
bun run lint                # Biome + per-package lint; lint:fix / format to apply
bun run check               # CI's workspace gates + build + typecheck
bun run test:e2e            # Playwright release gate (packages/e2e)
```

Setup and local services: [README](./README.md) and [docs/development.md](./docs/development.md).

## Map

- `packages/frontend`: Expo app. See `packages/frontend/AGENTS.md`.
- `packages/backend`: Express 5, PostgreSQL/Drizzle, Redis. See `packages/backend/AGENTS.md`.
- `packages/shared-types`, `packages/contracts`, `packages/sdk`: shared types and clients, consumed through their built `dist`.
- `packages/mcp`: remote MCP server for Claude and ChatGPT. `packages/e2e`: Playwright release gate.
- Architecture, API, federation, feed ranking, moderation, deployment: [docs/index.mdx](./docs/index.mdx).

## Conventions

- Run backend and MCP code on Bun; the frontend is Node-typed. Why: dependencies and typings differ per runtime ([development](./docs/development.md)).
- Bump shared SDK versions only in `workspaces.catalog` in the root `package.json`, then `bun install`. Why: `bun add` leaves the old version in place ([development](./docs/development.md)).
- Do not regenerate `bun.lock` from scratch; use `.github/scripts/verify-lockfile.sh origin/main`. Why: it prints the minimal correct delta.
- Compose UI from Bloom and put shared behaviour in Bloom or the Oxy packages, not in app-local copies ([Bloom app conventions](https://github.com/OxyHQ/Bloom/blob/main/docs/app-conventions.mdx)).
- Biome formats and lints; its rules and the ESLint that remains are in [lint-and-format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md). Run `bun run lint:fix` instead of hand-formatting.
- Build, Metro and runtime traps shared by every Oxy app: [build-and-runtime-traps](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/build-and-runtime-traps.md). Write new gates per [gate-writing](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/gate-writing.md).
- Mention-specific rules: [frontend-rules](./docs/frontend-rules.md), [frontend-compiler-notes](./docs/frontend-compiler-notes.md), [federation-behaviors](./docs/federation-behaviors.md).

## Boundaries

- Never `git stash` in this repo. Many worktrees share one stash stack and a pop applies another session's work.
- Never publish to npm from a laptop. Merging a version bump to `main` publishes it through `release-packages.yml` once CI passed ([npm releases](https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md)).
- Never add an inter-product call that uses app scopes, consent or an API-key fallback. Own product calls use shared workload/session transport plus the original requester's proof; external OAuth/API credentials stay bounded. Read [first-party-platform](./docs/first-party-platform.md) first; domain roles, account isolation and billing remain.
- Ask first before changing a gate (`validate:*`, `coverage-policy.json`, CI workflows), a Drizzle migration, or the `docker-compose` services.

## Testing

- Run the suite of the package you changed (`bun run test:backend`, `test:frontend`, `test:mcp`, `test:shared-types`); run backend tests from `packages/backend`, not the root.
- Done means `bun run lint` and `bun run check` pass and the tests for the changed behaviour exist. Coverage policy: `packages/frontend/docs/TESTING-POLICY.md`.
- CI runs only on PRs based on `main`; test a stack locally before retargeting.

## Pull requests

- Branch from `origin/main`; use a worktree rather than switching a shared checkout.
- Merge through the queue with a bare `gh pr merge <n> --squash`; never pass `--delete-branch` (it closes the PR unmerged).

## Secrets

Secrets come from the environment and the deploy workflows; never print or commit `.env` files or `*_DATABASE_URL` values.

## Links

Org standards: <https://github.com/OxyHQ/engineering/blob/main/AGENTS.md>. Agent team: [agent-team-workflow](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/agent-team-workflow.md).

Owner: Oxy platform team. Last reviewed 2026-11-11.
