# @mention/backend

Mention's Express, PostgreSQL, Redis/Valkey, Socket.IO, federation, and MTN
backend. The production service listens on port 3000 and serves both
`api.mention.earth` and the `mention.earth` web/federation surface.

## Structure

- `src/app.ts` builds the HTTP application from injected dependencies and has
  no connections, listeners, timers, sockets, or schedulers.
- `src/appRoutes.ts` owns route composition and the federation/web-shell/proxy
  ordering contract.
- `src/runtimeApp.ts` creates concrete Oxy and rate-limit dependencies.
- `server.ts` owns process bootstrap, Socket.IO, background schedulers, listen,
  and shutdown.
- `src/services/PostHydrationService.ts` is the only authority for post DTOs.
- `src/connectors/` isolates ActivityPub and AT Protocol integrations.
- `src/mtn/` contains the feed engine; `src/services/mtn/` contains Mention's
  signed-record integration.
- `src/migrations/` contains versioned schema/data migrations.

MongoDB must be a replica set or mongos because engagement writes use
multi-document transactions. The deployment migration task verifies topology
before changing schema or rolling out a new web task. Redis may degrade API
features, but a process never assumes singleton leadership without a lock.

## Setup

Use the Bun and Node versions pinned in the repository:

```bash
cp packages/backend/.env.example packages/backend/.env
bun install --frozen-lockfile
bun run doctor
bun run dev:backend
```

The root `docker-compose.yml` starts a local single-node Mongo replica set,
Valkey, a one-shot migration task, and then the backend.

## Commands

From the repository root:

```bash
bun run build:backend
bun run lint:backend
bun run test:backend
```

Run backend tests from this package directory when invoking them directly;
running Vitest discovery from the monorepo root can include stale compiled
copies:

```bash
cd packages/backend
bun run test
bun run test:coverage
bun run lint
bun run build
```

Production migrations run only as the deployment one-shot. Do not run
`migrate:dev` against production.

## Operational endpoints

- `GET /health/live` checks that the process can answer.
- `GET /health/ready` requires completed startup, Postgres connectivity, applied
  migrations, Redis, and the
  expected migration version.
- `GET /internal/metrics` is disabled unless configured and additionally
  requires an allowed network source plus a service bearer token.
- `POST /telemetry/web` accepts bounded anonymous browser RUM events; it must
  remain before authenticated API middleware and never carries user IDs.

The legacy root readiness response remains temporarily because the current ALB
target group still probes `/`. Its removal depends on the health-check path
being updated in `oxy-infra`.

## References

- [Repository overview](../../README.md)
- [Architecture](../../docs/architecture.mdx)
- [API surface](../../docs/api.mdx)
- [Federation](../../docs/fediverse.mdx)
- [User mentions](../../docs/mentions.md)
- [Deployment runbook](../../docs/AWS_DEPLOYMENT.md)

Detailed production invariants and federation gotchas live in the repository
`AGENTS.md`; keep this README concise rather than duplicating them.
