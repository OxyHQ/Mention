# Production deployment

Mention deploys from the exact `main` commit that passed CI. Production
workflows use `workflow_run`, reject stale commits before every production
mutation, and serialize releases per service.

## Surfaces

| Surface | Runtime | Workflow |
| --- | --- | --- |
| `api.mention.earth` and the `mention.earth` apex | AWS ECS service `mention` | `.github/workflows/deploy-aws.yml` |
| `mcp.mention.earth` | AWS ECS service `mention-mcp` | `.github/workflows/deploy-mcp-aws.yml` |
| Static Expo web export | Cloudflare Pages project `mention-frontend` | `.github/workflows/deploy-frontends.yml` |

The backend serves API, ActivityPub, OG shells and the apex proxy. ActivityPub
paths (`/.well-known/*`, `/ap/*`, nodeinfo and inboxes) are routed directly to
the backend and must never be redirected. The remaining apex web plane is
proxied to the static Cloudflare Pages origin.

## Release transaction

1. CI installs the frozen Bun lockfile and runs workspace checks, tests,
   security review, workflow validation and the frontend bundle budget.
2. Backend and MCP images are built for ARM64, pushed to ECR and referenced by
   immutable digest.
3. The backend runs schema migrations as a one-shot task with the release
   image. Web processes only assert the schema version for readiness.
4. ECS deploys the new task definition with its circuit breaker enabled.
5. Post-deploy smoke tests cover readiness, the anonymous feed, federation
   endpoints, static assets and MCP authentication.
6. The backend runs engagement reconciliation. A failed rollout, smoke test or
   reconciliation restores the previous task definition. Target-group health
   checks and stickiness are infrastructure-owned and are not mutated by an
   application release.

Cloudflare Pages first receives an immutable preview deployment. The exact
preview URL is smoke-tested before the same assets are promoted to production;
a failed production smoke rolls back to the previously captured deployment.

## Health and secrets

- Liveness: `GET /health/live`.
- Readiness: `GET /health/ready`; Mongo and the expected schema are mandatory.
- Redis degradation does not fail HTTP readiness, but singleton workers never
  claim leadership without their distributed lock.
- GitHub authenticates to AWS with OIDC. Runtime secrets are stored in SSM and
  injected by ECS; no long-lived AWS key is required by the deployment
  workflows.
- `/internal/metrics` requires its service token and an allowed network source.

Run migrations only through the deployment one-shot in production. Do not run
them from web-process startup or from a developer workstation.
