# DigitalOcean App Platform Deployment

Guide for deploying the Mention monorepo to DigitalOcean App Platform.

## Architecture

The `mention-production` app deploys 3 components from the same monorepo:

| Component | Type | Domain | Description |
|---|---|---|---|
| `mention` | Service | `api.mention.earth` | Node.js backend API |
| `mention-frontend` | Static Site | `mention.earth` | Expo web frontend |
| `agora-frontend` | Static Site | `agora.mention.earth` | Agora web frontend |

## Ingress Routing

All components share a single app with domain-based and path-based routing:

```
mention.earth/.well-known/*  → mention (backend, ActivityPub)
mention.earth/ap/*           → mention (backend, ActivityPub)
api.mention.earth/*          → mention (backend)
agora.mention.earth/*        → agora-frontend
mention.earth/*              → mention-frontend (catch-all)
```

## Build Configuration

Each component runs its own buildpack-based build using the heroku/nodejs buildpack.

### Backend (`mention`)

```
npm ci --include=dev && npm run -w @mention/backend build && npm prune --omit=dev
```

- Installs all dependencies, builds the backend, then prunes dev dependencies for a smaller runtime image.
- Instance: `apps-s-1vcpu-1gb-fixed`
- Run command: `node packages/backend/dist/server.js`

### Frontend (`mention-frontend`)

```
npm ci --include=dev && rm -rf node_modules/.cache .expo packages/frontend/.expo && npm run build -w @mention/shared-types && npm run build -w @mention/frontend
```

- Builds shared-types first (frontend depends on them), then builds the frontend.
- Output directory: `packages/frontend/dist`

### Agora (`agora-frontend`)

```
npm ci --include=dev && rm -rf node_modules/.cache .expo packages/agora/.expo && npm run build -w @mention/agora
```

- Output directory: `packages/agora/dist`

## Build Environment Variables

### Static Sites (mention-frontend, agora-frontend)

| Variable | Value | Scope | Purpose |
|---|---|---|---|
| `NODE_OPTIONS` | `--max-old-space-size=1536` | `BUILD_TIME` | Prevents OOM during Expo bundling |
| `NODE_MODULES_CACHE` | `false` | `BUILD_TIME` | Disables buildpack node_modules caching to prevent resource exhaustion during cache upload |

The `NODE_MODULES_CACHE=false` setting is required because all 3 components build in the same build container. Without it, the buildpack tries to cache 3 copies of the full monorepo's `node_modules`, which exhausts the container's resources during the post-build cache upload phase. Static sites don't need cached `node_modules` since only the `dist/` output matters.

### App-Level Environment Variables

These are shared across all components:

| Variable | Value | Scope |
|---|---|---|
| `API_URL` | `https://api.mention.earth` | `RUN_AND_BUILD_TIME` |
| `API_URL_OXY` | `https://api.oxy.so` | `RUN_AND_BUILD_TIME` |
| `EXPO_PUBLIC_API_URL` | `https://api.mention.earth` | `RUN_AND_BUILD_TIME` |
| `NODE_ENV` | `production` | `RUN_AND_BUILD_TIME` |

### Backend-Specific Environment Variables

Configured on the `mention` service component. See [Backend README](../packages/backend/README.md) for the full list.

## Database

The app connects to a managed MongoDB cluster (`db-oxy`) on DigitalOcean. Per Oxy ecosystem conventions, the database name is `mention-production` (built from `APP_NAME + NODE_ENV`), passed via the `dbName` option in `mongoose.connect()`.

## Deployment

Deployments trigger automatically on push to `main` (deploy-on-push is enabled for all components).

### Manual Deployment

```bash
# Via DO API
curl -X POST "https://api.digitalocean.com/v2/apps/{app-id}/deployments" \
  -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"force_build": true}'
```

## Troubleshooting

### BuildJobTerminated (Resource Exhaustion)

If builds complete but the deployment fails with `BuildJobTerminated`, the build container ran out of resources during the post-build phase. Ensure `NODE_MODULES_CACHE=false` is set on both static site components.

### Build Errors

Check build logs via the DO API:

```bash
curl "https://api.digitalocean.com/v2/apps/{app-id}/deployments/{deploy-id}/components/{component-name}/logs?type=BUILD" \
  -H "Authorization: Bearer $DIGITALOCEAN_TOKEN"
```

### Multiple Lock Files

The buildpack rejects builds if multiple package manager lock files exist (e.g., both `bun.lock` and `package-lock.json`). The `.gitignore` excludes `bun.lock` to prevent this.
