<p align="center">
  <b>Mention is a social network for iOS, Android and the web, connected to the Fediverse.</b><br>
  Posts are signed records on a chain the author owns, not rows we can quietly rewrite.
</p>

<p align="center">
  <a href="https://mention.earth"><img alt="mention.earth" src="https://img.shields.io/badge/mention.earth-440151?style=flat-square"></a>
  <a href="./LICENSE"><img alt="License Breathe 1.0" src="https://img.shields.io/badge/license-Breathe%201.0-informational?style=flat-square"></a>
  <img alt="Expo SDK 57" src="https://img.shields.io/badge/Expo-SDK%2057-000020?style=flat-square&logo=expo&logoColor=white">
  <img alt="React Native 0.86" src="https://img.shields.io/badge/React%20Native-0.86-61DAFB?style=flat-square&logo=react&logoColor=black">
  <img alt="TypeScript 5.9" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Bun 1.3.14" src="https://img.shields.io/badge/Bun-1.3.14-000000?style=flat-square&logo=bun&logoColor=white">
</p>

---

<table>
<tr>
<td valign="top" width="50%">

### What is in this repository

One Bun workspace holding the whole product: an Expo client that ships to iOS, Android and the web from a single codebase, an Express API that also serves the web shell and the federation endpoints, the shared type contracts both sides compile against, and a remote MCP server so an AI assistant can read and post with your permission.

Mention owns posts, feeds, engagement, notifications, its own mutes and its federation state. It does not own you.

</td>
<td valign="top" width="50%">

### How it fits the Oxy platform

Identity, sessions and the social graph come from [**oxy**](https://github.com/OxyHQ/oxy), the platform every Oxy app stands on. The client mounts one `OxyProvider` from `@oxyhq/services`, the backend verifies requests with `@oxyhq/core/server`, and neither side hand rolls a token parser.

The interface is built with [**Bloom**](https://github.com/OxyHQ/Bloom). Live audio rooms come from `@syra.fm/sdk`, the engine behind [**Syra**](https://github.com/OxyHQ/Syra), and load only when a room is opened.

</td>
</tr>
</table>

## Workspaces

| Package | Path | What it holds |
|---|---|---|
| `@mention/frontend` | [`packages/frontend`](./packages/frontend) | Expo Router app for iOS, Android and web. Expo 57, React Native 0.86, React 19, NativeWind, TanStack Query, Zustand |
| `@mention/backend` | [`packages/backend`](./packages/backend) | Express 5 API over PostgreSQL (Drizzle ORM) and Valkey, Socket.IO, background workers, ActivityPub federation, the MTN signed record layer and the web shell |
| `@mention/shared-types` | [`packages/shared-types`](./packages/shared-types) | The request and response contracts, plus the MTN record schemas, that both sides compile against |
| `@mention/mcp` | [`packages/mcp`](./packages/mcp) | Model Context Protocol server, remote over HTTP and local over stdio |
| `@mention/e2e` | [`packages/e2e`](./packages/e2e) | Real browser release gate that exercises a candidate web build before it is promoted |

## Quick start

You need [Bun](https://bun.sh) 1.3.14, Node.js 22.17.0 for the Expo and Jest toolchains, and Docker with Compose for the local data plane. Xcode or Android Studio are needed only when you run the matching native target.

```bash
bun install --frozen-lockfile
bun run doctor
```

`doctor` checks the runtime, the workspace links and the pinned Expo, React, React Native, Bloom and shared types versions. It is worth running before you believe any other failure.

```bash
bun run dev              # every workspace
bun run dev:frontend     # Expo dev server
bun run dev:backend      # API in watch mode
bun run dev:mcp          # MCP over stdio
bun run dev:mcp:http     # MCP over streamable HTTP, as production runs it
```

Run a specific native target from the frontend workspace:

```bash
bun run --cwd packages/frontend ios
bun run --cwd packages/frontend android
bun run --cwd packages/frontend web
```

<details>
<summary><b>Local data plane</b></summary>

<br>

The Compose stack is PostGIS-flavoured PostgreSQL, Valkey, and a one shot migration container. The backend starts only once Postgres and Valkey are healthy and migrations have finished:

```bash
docker compose up --build backend
```

Postgres and Valkey bind to loopback ports `5434` and `6379`, and their data lives in the named `postgres_data` and `valkey_data` volumes. Port `5434` rather than `5433` on purpose: `docker-compose.postgres.yml` binds `5433` for the database that sits beside the test suite, and both stacks are routinely up at once.

For watch mode, start the dependencies only and run the backend on the host:

```bash
docker compose up -d postgres valkey
bun run dev:backend
```

Outside production the backend runs its own migrations before it reports ready.

</details>

<details>
<summary><b>Checks, builds and tests</b></summary>

<br>

```bash
bun run check            # workspace validators, then build, then type checks
bun run build            # shared-types, backend, MCP
bun run build:frontend   # static Expo web export
bun run test             # every workspace
bun run lint             # every workspace
```

Two things save time here. Rebuild `shared-types` before you trust a red type check, because every other package compiles against its built output and reports newly landed symbols as missing. And run backend tests from their own package root, `cd packages/backend && bun run test`, so stale compiled copies cannot be picked up.

</details>

## What the platform does

<table>
<tr>
<td valign="top" width="50%">

**Signed records (MTN)**

Local posts are dual written to a per user hash chain built on `@oxyhq/protocol`. PostgreSQL stays authoritative for reads while the chain gives an author a verifiable, portable history. Native writes are signed on the device, web writes are signed custodially by the service, and a user can run their own node to hold their own chain.

**Federation**

External networks are a pluggable connector module rather than a hardcoded assumption. ActivityPub reaches Mastodon and the wider Fediverse. AT Protocol is read and discovery only, for resolving handles and mirroring profiles and posts. The core never knows a network exists.

</td>
<td valign="top" width="50%">

**Feeds and social surfaces**

Following and For You feeds, custom feeds, lanes, channels, lists, starter packs, hashtags, topics, trending, polls, articles and collaborative posts. Ranking, classification and read surface safety gating live in the backend rather than in the client.

**Moderation and AI access**

Reports go to [**CrowdSource**](https://github.com/OxyHQ/CrowdSource), which draws an independent jury, publishes a versioned decision and returns it by webhook. Mention decides what to enforce and nothing else. The MCP server lets Claude and other assistants act as you, with OAuth and per account linking.

</td>
</tr>
</table>

## Documentation

| Document | Covers |
|---|---|
| [Overview](./docs/index.mdx) | Entry point, workspace responsibilities, data ownership |
| [Architecture](./docs/architecture.mdx) | How the pieces fit together |
| [API](./docs/api.mdx) | The HTTP surface |
| [Fediverse](./docs/fediverse.mdx) | ActivityPub integration and discovery |
| [Federation behaviors](./docs/federation-behaviors.md) | Reposted-post shapes, bridge identity, thread federation, blocklist/purge, HLS media proxy |
| [Channels and lanes](./docs/channels-and-lanes.md) | Channel-as-account design, disclosure, correction trail, lane curation |
| [Moderation (CrowdSource)](./docs/moderation-crowdsource.md) | Report intake, enforcement modes, the subject-provider seam, known gaps |
| [Feed ranking](./docs/feed-ranking.md) | Content classification, safety gating, ranking signals, interstitials |
| [Frontend compiler notes](./docs/frontend-compiler-notes.md) | React Compiler ref-write findings, web feed virtualization |
| [Product positioning](./docs/PRODUCT_POSITIONING.md) | What Mention is (and is not) as a product category |
| [Performance budgets](./docs/PERFORMANCE_BUDGETS.md) | What is measured today, what is instrumented but unheld, what is missing |
| [Compose intent URLs](./docs/compose-intent.mdx) | Linking into the composer from outside the app |
| [User mentions](./docs/mentions.md) | How handles resolve, local and federated |
| [Theming](./docs/THEMING.md) | Bloom and NativeWind in this app |
| [MCP server](./packages/mcp/README.md) | Connecting Claude through central Oxy OAuth, account binding, and the tool list |
| [Compatibility retirement](./docs/COMPATIBILITY_RETIREMENT.md) | What we removed and why |

Instructions for AI coding agents live in [`AGENTS.md`](./AGENTS.md). The parent files it references apply as well.

## Contributing

Issues and pull requests are welcome. Please run `bun run check` and `bun run test` before opening one. Org wide [contributing notes](https://github.com/OxyHQ/.github/blob/main/CONTRIBUTING.md), the [security policy](https://github.com/OxyHQ/.github/blob/main/SECURITY.md) and the [code of conduct](https://github.com/OxyHQ/.github/blob/main/CODE_OF_CONDUCT.md) live in the organisation profile.

## License

[The Breathe License 1.0](./LICENSE). Free to breathe, paid to bottle.

Free to run, read, modify, fork, and share, for any purpose that is not
commercial. Two conditions on everyone: publish the source of what you deploy,
and credit Oxy in one reachable place. Neither can be bought out of.

**Commercial use requires a paid license.** The trigger is revenue, including
internal use inside a business that earns it. See the
[Commercial Terms](https://github.com/OxyHQ/.github/blob/main/LICENSE-COMMERCIAL.md).
Paying buys the right to use it commercially; it does not let you keep your
changes private and it does not remove attribution.

Cooperatives, nonprofits, educational institutions, and public bodies pay
nothing. They publish source and attribute like everyone else. See the
[Exemption Policy](https://github.com/OxyHQ/.github/blob/main/licensing/EXEMPTIONS.md).

The Breathe License is **source available, not open source**. It is not OSI
approved, because charging for commercial use is discrimination against a
field of endeavour under clause 6 of the Open Source Definition. Oxy's SDKs
and client libraries (`@oxyhq/core`, `@oxyhq/services`, Bloom) are
Apache-2.0, so building against Oxy carries none of this.
