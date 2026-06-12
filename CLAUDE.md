# Mention

## AWS Deployment

The backend runs on **AWS ECS Fargate** (region `eu-west-1`, cluster `oxy-cluster`), behind an ALB with ACM HTTPS.

- **Port**: `3000` | **Domain**: `api.mention.earth`
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` builds a `linux/arm64` Docker image → pushes to ECR (`237343248947.dkr.ecr.eu-west-1.amazonaws.com/oxy/mention`) → `aws ecs update-service --force-new-deployment`
- **Auth**: GitHub OIDC → role `oxy-github-deploy`. No AWS keys stored in GitHub.
- **Secrets**: GitHub Actions secrets are the source of truth. The deploy workflow syncs them to AWS SSM (`/oxy/mention/*`; shared secrets to `/oxy/_shared/*`); ECS injects them into the container. To change a secret: edit it in GitHub — the next deploy applies it.
- **Dockerfile**: must build for `linux/arm64` (Graviton).
- **WARNING**: Never put secret values in this file.

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

## Compose Intent URL

The composer accepts rich URL params for prefilling — mirrors X/Twitter `intent/tweet`:
- Canonical: `https://mention.earth/compose?text=...&url=...&hashtags=...`
- Full param reference: `packages/frontend/docs/INTENT_URL.md`
- Parser: `packages/frontend/utils/composeIntent.ts`
- Wired in: `packages/frontend/app/(app)/compose.tsx` (inside the auth group)
- OS share sheet: Web Share Target (PWA, via `app.config.js` manifest) + native via `expo-share-intent` (config plugin, needs `expo prebuild` after install)
- Share intent integration point: `packages/frontend/app/_layout.tsx`
- Platform split pattern: `shareIntent.web.ts` / `shareIntent.native.ts` (mirrors `livekit.web.ts` / `livekit.native.ts`)
- Quote flow: `hooks/useQuoteManager.ts` + `components/Compose/QuoteCard.tsx`
- Wire format: quote post field is snake_case `quoted_post_id` as top-level body field (NOT nested under `content`)

## Dependencies

- `@oxyhq/core`, `@oxyhq/services` — Oxy platform SDK
- `@oxyhq/bloom` — Shared UI component library

## Theming

- **Bloom owns theming.** `BloomThemeProvider` (since v0.6.14) is the single source of truth for mode + color preset, with built-in persistence. Do NOT add a local theme store — pass `persistKey` + `storage` to the provider.
- **Default preset for Mention frontend: `blue`** (not `oxy`).
- **Default preset for Agora: `yellow`** (matches the existing `#FFC107` brand).
- Settings UI uses Bloom's `SettingsList` (`SettingsListGroup` / `SettingsListItem` from `@oxyhq/bloom/settings-list`). Do not introduce local `SettingsItem` wrappers — they diverge from Bloom.
- `lib/app-color-presets.ts#getScopedColorCSSVariables` is still needed for Tailwind `@theme` scoped overrides; do not remove it when cleaning up the legacy theme store.
- Frontend `app/_layout.tsx` is the only place that wires the provider; consumers read theme via `useTheme()` / `useBloomTheme()` from `@oxyhq/bloom`.
