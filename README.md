# Mention

Mention is a social app for iOS, Android, and the web. It combines an Expo
client, an Express API, a signed-record layer (MTN), ActivityPub federation,
and a remote MCP server in one Bun workspace.

## Repository

| Workspace | Purpose |
| --- | --- |
| `packages/frontend` | Expo 56 / React Native 0.85 / React 19 app |
| `packages/backend` | Express 5 API, Socket.IO, workers, federation, and MTN |
| `packages/shared-types` | Shared TypeScript contracts |
| `packages/mcp` | Remote and local Model Context Protocol server |

Oxy owns account identity and the social graph. Mention owns posts, feeds,
engagement, notifications, Mention-specific settings, and federation state.
Live rooms use `@syra.fm/sdk` and load only when needed.

## Requirements

- Bun 1.3.14
- Node.js 22.17.0
- Docker with Compose for the local data plane
- Xcode or Android Studio only when running the corresponding native target

Install exactly from the lockfile, then validate the toolchain:

```sh
bun install --frozen-lockfile
bun run doctor
```

`doctor` checks the runtime, workspace links, and the pinned Expo, React,
React Native, Bloom, and shared-types versions.

## Local development

The local Compose stack uses a single-node MongoDB replica set, Valkey, and a
one-shot migration container. The backend starts only after the replica set is
writable, Valkey is healthy, and migrations have completed:

```sh
docker compose up --build backend
```

MongoDB and Valkey bind to loopback ports `27017` and `6379`. Their data lives
in the named `mongo_data` and `valkey_data` volumes.

For watch mode, start only the dependencies and run the workspace process on
the host:

```sh
docker compose up -d mongo valkey
docker compose run --rm mongo-init
bun run dev:backend
```

The non-production backend runs its migrations before it marks itself ready.

Other development entry points:

```sh
bun run dev              # all workspaces
bun run dev:frontend     # Expo; run from the frontend workspace
bun run dev:mcp          # local stdio transport
bun run dev:mcp:http     # local Streamable HTTP transport
```

Metro must run from `packages/frontend`, which the root frontend script does.

## Checks and builds

```sh
bun run doctor
bun run check
bun run build            # shared-types, backend, and MCP
bun run build:frontend   # static Expo web export
bun run test
bun run lint             # all workspaces
```

Run backend tests from their package root to avoid stale compiled test copies:

```sh
cd packages/backend
bun run test
```

## Runtime surfaces

| Host | Runtime |
| --- | --- |
| `api.mention.earth` | Mention API on AWS ECS |
| `mention.earth` | The same backend for federation, OG shells, and the web proxy |
| `mcp.mention.earth` | Separate MCP service on AWS ECS |
| `mention-frontend.pages.dev` | Static Expo web origin, reached through the apex proxy |

The backend serves protocol routes before the apex web proxy. ActivityPub
endpoint paths must never redirect. Hashed web assets are immutable; HTML is
served with revalidation.

Production deployments are CI-gated. Workflows publish immutable images or
static artifacts from the successful `main` SHA. Backend migrations run as a
one-shot task before the ECS rollout.

## Operational contracts

- `GET /health/live` reports process liveness.
- `GET /health/ready` requires startup, migrations, and MongoDB to be ready.
- Redis/Valkey failure degrades optional API capabilities but never grants
  singleton leadership without a lock.
- `GET /internal/metrics` is service-only and requires both network policy and
  a bearer token.
- `POST /telemetry/web` accepts bounded browser vitals and runtime events.

Post API responses are produced by `PostHydrationService`; Oxy's user shape is
the canonical identity shape. The MTN record chain is best-effort for native
writes, while MongoDB remains authoritative for application reads. External
networks are isolated behind the connector registry.

## Documentation

- [Documentation index](./docs/index.mdx)
- [Architecture](./docs/architecture.mdx)
- [API surface](./docs/api.mdx)
- [Compatibility retirement](./docs/COMPATIBILITY_RETIREMENT.md)
- [Fediverse integration](./docs/fediverse.mdx)
- [User mentions](./docs/mentions.md)
- [MCP server](./packages/mcp/README.md)
- [AWS deployment](./docs/AWS_DEPLOYMENT.md)
- [Theming](./docs/THEMING.md)

Repository-specific agent instructions live in `AGENTS.md`. Parent instructions
referenced there also apply.

## License

See [LICENSE](./LICENSE).
