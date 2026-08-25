# Mention

Mention is a cross-platform social app (iOS, Android, web) with ActivityPub
federation, built as a Bun monorepo: `packages/frontend` (Expo), `packages/backend`
(Express 5, PostgreSQL/Drizzle, Redis), `packages/shared-types`, `packages/mcp`
(remote MCP server for Claude/ChatGPT), and `packages/e2e` (Playwright release gate).

Org-wide engineering standards live at
<https://github.com/OxyHQ/engineering/blob/main/AGENTS.md>. Parent files
(`~/AGENTS.md`, `~/Oxy/AGENTS.md`) hold the agent team, shared-SDK rules, and
the Bloom/Expo/expo-router gotchas.

## Commands

```bash
bun run dev            # all workspaces
bun run build           # shared-types + backend + mcp
bun run test / lint / check
```

See the repository [README](./README.md) for setup and local development.

## Documentation

Everything else — architecture, API, federation, lanes and channels, feed
ranking, post lifecycle, frontend rules, moderation, development gotchas, and
deployment — lives in [`docs/`](./docs/index.mdx). Start there.
