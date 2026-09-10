# Production deployment

Mention deploys from the exact `main` commit that passed CI. Production
workflows use `workflow_run`, reject stale commits before every production
mutation, and serialize releases per service.

## Surfaces

| Surface | Runtime | ECR | Workflow |
| --- | --- | --- | --- |
| `api.mention.earth` and the `mention.earth` apex | AWS ECS service `mention`, port `3000` | `oxy/mention` | `.github/workflows/deploy-aws.yml` |
| `mcp.mention.earth` | AWS ECS service `mention-mcp`, port `3100` | `oxy/mention-mcp` | `.github/workflows/deploy-mcp-aws.yml` |
| `shell.mention.earth` (static Expo web export) | Cloudflare Worker `mention-frontend` | — | `.github/workflows/deploy-frontends.yml` |

GitHub Actions assumes the OIDC role `oxy-github-deploy` to push images and
deploy; secrets sync to SSM `/oxy/mention/*` and `/oxy/mention-mcp/*`.

The backend serves API, ActivityPub, OG shells and the apex proxy. ActivityPub
paths (`/.well-known/*`, `/ap/*`, nodeinfo and inboxes) are routed directly to
the backend and must never be redirected. The remaining apex web plane is
proxied to `shell.mention.earth`, a Cloudflare Worker.

That origin is not public. It serves nothing without the `X-Mention-Shell-Key`
header and answers 403 otherwise, so the only ways to the app's bytes are the
apex proxy and the OG shell renderer — both of them this backend. It is a Worker
rather than a Cloudflare Pages project for exactly that reason: a Pages project
always serves `<project>.pages.dev` with no way to switch it off, and
`mention-frontend.pages.dev` was a second, unauthenticated copy of the app that
was in no CORS allowlist, so a browser that found it booted the shell and had
every API call blocked. Pages serves assets and runs no code; a Worker can refuse.

The key is one GitHub secret, `MENTION_SHELL_ACCESS_KEY`, with two consumers:
`deploy-aws.yml` syncs it to SSM `/oxy/mention/MENTION_SHELL_ACCESS_KEY` and
injects it into the task, and `deploy-frontends.yml` uploads it to the Worker in
the same operation as the code. Rotating it means running both workflows. The
backend refuses to boot without it in production rather than start into an apex
that answers every page with the empty fallback shell.

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

Cloudflare Pages first receives an immutable preview deployment, which is what
the browser release gate runs against — a Worker has no per-branch preview URL,
so the candidate origin the gate requires is still a Pages deployment. The exact
preview URL is smoke-tested and browsed before the same assets are deployed to
the shell Worker; the deploy is then smoke-tested with the key AND asserted to
answer 403 without one, and a failed production smoke runs `wrangler rollback`
to the Worker's previous version.

## Health and secrets

- Liveness: `GET /health/live`.
- Readiness: `GET /health/ready`; it checks `postgres`, `migrations` and `redis`.
  Mongo is NOT among them and has not been since the cutover — a task that fails
  readiness is failing one of those three, so debugging the store this line used
  to name would be debugging a store the service no longer opens.
- Redis degradation does not fail HTTP readiness, but singleton workers never
  claim leadership without their distributed lock.
- GitHub authenticates to AWS with OIDC. Runtime secrets are stored in SSM and
  injected by ECS; no long-lived AWS key is required by the deployment
  workflows.
- `/internal/metrics` requires its service token and an allowed network source.

Run migrations only through the deployment one-shot in production. Do not run
them from web-process startup or from a developer workstation.
