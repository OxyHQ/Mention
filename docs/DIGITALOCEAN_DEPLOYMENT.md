# Deployment Architecture

Guide for the Mention monorepo deployment across DigitalOcean and Cloudflare.

## Architecture

| Component | Platform | Domain | Description |
|---|---|---|---|
| `mention` | DigitalOcean App Platform | `api.mention.earth` | Node.js backend API + ActivityPub |
| `mention-frontend` | Cloudflare Pages | `mention.earth` | Expo web frontend |
| `agora-frontend` | Cloudflare Pages | `agora.mention.earth` | Agora web frontend |

## Routing

```
mention.earth/*              → mention-frontend (Cloudflare Pages)
mention.earth/.well-known/*  → 301 → api.mention.earth/.well-known/* (CF Redirect Rule)
mention.earth/ap/*           → 301 → api.mention.earth/ap/* (CF Redirect Rule)
agora.mention.earth/*        → agora-frontend (Cloudflare Pages)
api.mention.earth/*          → mention backend (DigitalOcean)
```

ActivityPub identity remains `@user@mention.earth`. WebFinger and AP routes are redirected to `api.mention.earth` via Cloudflare zone-level Redirect Rules (phase `http_request_dynamic_redirect`) with `preserve_query_string: true`.

## Frontend Deployment (Cloudflare Pages)

Frontends deploy automatically via GitHub Actions (`.github/workflows/deploy-frontends.yml`) on push to `main`.

### Change Detection

The workflow uses `dorny/paths-filter@v3` for per-job granularity:
- **mention-frontend** rebuilds when `packages/frontend/**`, `packages/shared-types/**`, `package.json`, or `package-lock.json` change
- **agora-frontend** rebuilds when `packages/agora/**`, `packages/agora-shared/**`, `packages/shared-types/**`, `package.json`, or `package-lock.json` change

Both jobs run in parallel when both apps have changes. Neither runs if only backend code changed.

### Build Process

Each frontend job:
1. Installs dependencies with `npm ci`
2. Builds `@mention/shared-types` first (dependency)
3. Builds the frontend with `NODE_OPTIONS=--max-old-space-size=4096`
4. Deploys `dist/` to Cloudflare Pages via `wrangler pages deploy`

### SPA Routing

Both frontends include a `public/_redirects` file (`/* /index.html 200`) that Cloudflare Pages uses for SPA catch-all routing.

### Required GitHub Secrets

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Pages write access |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

## Backend Deployment (DigitalOcean)

The `mention-production` DO app deploys the backend service only.

### Build Command

```
npm ci --include=dev && npm run -w @mention/backend build && npm prune --omit=dev
```

- Instance: `apps-s-1vcpu-1gb-fixed`
- Run command: `node packages/backend/dist/server.js`

### Environment Variables

App-level (shared):

| Variable | Value | Scope |
|---|---|---|
| `API_URL` | `https://api.mention.earth` | `RUN_AND_BUILD_TIME` |
| `API_URL_OXY` | `https://api.oxy.so` | `RUN_AND_BUILD_TIME` |
| `EXPO_PUBLIC_API_URL` | `https://api.mention.earth` | `RUN_AND_BUILD_TIME` |
| `NODE_ENV` | `production` | `RUN_AND_BUILD_TIME` |

Backend-specific variables are configured on the `mention` service component. See [Backend README](../packages/backend/README.md) for the full list.

### Deployment Trigger

Deployments trigger via two mechanisms:

1. **DO App Platform deploy-on-push** — automatically builds on push to `main` (configured on the DO side).
2. **GitHub Actions workflow** (`.github/workflows/deploy-backend.yml`) — triggers on push to `main` when backend files change, and can be triggered manually via `workflow_dispatch`. Requires `DIGITALOCEAN_TOKEN` secret and `DO_APP_ID` variable.

### Required GitHub Secrets/Variables

| Name | Type | Description |
|---|---|---|
| `DIGITALOCEAN_TOKEN` | Secret | DigitalOcean API token with read/write access |
| `DO_APP_ID` | Variable | App Platform app ID (from `doctl apps list`) |

### Manual Deployment

```bash
curl -X POST "https://api.digitalocean.com/v2/apps/{app-id}/deployments" \
  -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"force_build": true}'
```

## Database

The app connects to a managed MongoDB cluster (`db-oxy`) on DigitalOcean. Per Oxy ecosystem conventions, the database name is `mention-production` (built from `APP_NAME + NODE_ENV`), passed via the `dbName` option in `mongoose.connect()`.

## DNS

DNS is managed by Cloudflare (zone `mention.earth`):

| Record | Type | Target |
|---|---|---|
| `mention.earth` | CNAME | `mention-frontend.pages.dev` (via CF Pages custom domain) |
| `agora.mention.earth` | CNAME | `agora-frontend.pages.dev` (via CF Pages custom domain) |
| `api.mention.earth` | CNAME | `mention-production-mt7zg.ondigitalocean.app` (DNS-only) |

## Troubleshooting

### Build Errors

**Backend (DO):** Check build logs via the DO API:

```bash
curl "https://api.digitalocean.com/v2/apps/{app-id}/deployments/{deploy-id}/components/{component-name}/logs?type=BUILD" \
  -H "Authorization: Bearer $DIGITALOCEAN_TOKEN"
```

**Frontends (CF Pages):** Check the GitHub Actions workflow run logs.

### Multiple Lock Files

The DO buildpack rejects builds if multiple package manager lock files exist (e.g., both `bun.lock` and `package-lock.json`). The `.gitignore` excludes `bun.lock` to prevent this.
