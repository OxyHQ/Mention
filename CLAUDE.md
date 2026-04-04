# Mention

## Custom Agents

Use these agents for all implementation work:
- `mention-frontend` — Expo/RN frontend (components, screens, hooks, feeds, profiles)
- `mention-designer` — UI/UX (animations, styling, responsive, pixel-perfect)
- `mention-backend` — Backend (API, MongoDB, Redis, ActivityPub, feeds, MCP)
- `mention-fixer` — Cross-stack debugging (frontend ↔ backend ↔ oxy)

## Commands

```bash
bun run dev                 # All packages dev mode
bun run dev:frontend        # Frontend dev (Expo tunnel)
bun run dev:backend         # Backend dev (watch mode)
bun run dev:agora           # Agora dev
bun run dev:mcp             # MCP server dev
bun run build               # Build shared-types + backend + mcp
bun run build:frontend      # Build frontend
bun run build:backend       # Build backend (shared-types first)
bun run test                # Test all
bun run lint                # Lint all
bun run clean               # Remove all node_modules
```

## Architecture

Monorepo (v2.0.0) using Bun with workspaces.

```
packages/
  frontend/       @mention/frontend    Expo 55 / React Native 0.84 / React 19
  backend/        @mention/backend     Express 5.2 / Mongoose 9.3 / Redis / Socket.io
  shared-types/   @mention/shared-types TypeScript type definitions
  agora/          @mention/agora       Expo app for live audio/video rooms (LiveKit)
  agora-shared/   @mention/agora-shared Shared Agora components & hooks
  mcp/            @mention/mcp         Model Context Protocol server for Claude
```

## Key Tech

- **Frontend**: Expo Router, NativeWind + TailwindCSS 4.2, TanStack React Query, Zustand, Socket.io-client, LiveKit
- **Backend**: Express 5, Mongoose 9, Redis 5, Socket.io, LiveKit Server SDK, Firebase Admin, AWS S3
- **Feed System**: MTN protocol in `backend/src/mtn/` (ForYou, Following, Author, Hashtag, Explore, Custom feeds + tuners)
- **Federation**: ActivityPub protocol — federated users in Oxy (type: 'federated'), posts in Mention, linked by oxyUserId. HTTP signatures on all outbound requests. Local dev: `cloudflared tunnel --url http://localhost:3000` + set `FEDERATION_DOMAIN` to tunnel domain.
- **Auth**: Oxy integration via @oxyhq/core + @oxyhq/services

## Dependencies

- `@oxyhq/core`, `@oxyhq/services` — Oxy platform SDK
- `@oxyhq/bloom` — Shared UI component library
