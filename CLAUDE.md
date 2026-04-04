# Mention

Social media platform with fediverse/ActivityPub support.

## Commands

```bash
bun run dev                  # Dev all packages
bun run dev:frontend         # Dev frontend only
bun run dev:backend          # Dev backend only
bun run dev:agora            # Dev Agora app
bun run build                # Build shared-types + backend + mcp
bun run build:frontend       # Build frontend
bun run start:frontend       # Start frontend (Expo)
bun run start:backend        # Start backend
bun run test                 # Run all tests
bun install                  # Install all deps
```

## Architecture

Monorepo using Bun workspaces.

```
packages/
  frontend/       React Native + Expo app (Expo Router, NativeWind)
  backend/        Node.js/TypeScript server (MongoDB, Redis)
  shared-types/   Shared TypeScript types (build first!)
  agora/          Agora app (Expo)
  agora-shared/   Shared Agora utilities
  mcp/            MCP server
```

Build order: `shared-types` -> `backend` / `frontend`

## Frontend (`packages/frontend/`)

- **Framework**: React Native + Expo (managed)
- **Routing**: Expo Router (`app/` directory)
- **Styling**: NativeWind (Tailwind for RN)
- **Key screens**: `app/(app)/` - main app, `app/(auth)/` - auth flow
- **Components**: `components/` - Feed, Compose, Header, etc.
- **Services**: `services/` - feeds, search, notifications, fediverse, etc.
- **Hooks**: `hooks/`

## Backend (`packages/backend/`)

- **Entry**: `server.ts`
- **Structure**: `src/` with controllers, routes, models, services, middleware, sockets
- **Database**: MongoDB (local dev)
- **Cache**: Redis
- **Auth**: Oxy SDK integration (`~/OxyHQServices`)

## Package Manager

Always use `bun`. Never npm or yarn.

## Custom Agents

Use these agents for Mention work:

- **mention-frontend**: Frontend/UI tasks in `packages/frontend/`
- **mention-backend**: Backend/API tasks in `packages/backend/`
- **mention-fixer**: Cross-stack debugging (frontend + backend + Oxy)
- **git-ops**: Git commit, push, merge operations

When a task spans frontend + backend, launch both agents in parallel.
