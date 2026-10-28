# Managed Mention: dedicated application contract

Related: [Managed Mention #954](https://github.com/OxyHQ/Mention/issues/954).

## Implementation status

The application foundation and dedicated infrastructure modules are implemented.
This is not a claim that a managed customer deployment is provisioned or that the
whole issue is complete. No managed tenant resources have been applied as part
of this work. **Do not activate a paid deployment until the end-to-end gates below
have been demonstrated.** Commercial terms and activation remain deferred; issue
#954 stays open.

Implemented source and review evidence:

- [Application configuration foundation](https://github.com/OxyHQ/Mention/commit/0287aeafff788313f8aafbfe9c2f64e326aad268): strict manifest, branding,
  admission, discovery, public frontend configuration and MCP audience binding.
- [Separate API/worker lifecycle](https://github.com/OxyHQ/Mention/pull/1647):
  independent job ownership, strict split-mode Redis readiness and idempotent
  shutdown. The public deployment retains its default `combined` role.
- [Dedicated data plane](https://github.com/OxyHQ/oxy-infra/pull/406) and
  [scoped backup policy](https://github.com/OxyHQ/oxy-infra/pull/407): private RDS,
  separate cache/queue, tenant CMK, workload roles, logs and backup declarations.
- [Runtime module](https://github.com/OxyHQ/oxy-infra/pull/408): backend, worker
  and MCP services with distinct identities, private networking, explicit health
  checks and canonical origin configuration. The module is not instantiated.
- [Recoverable database bootstrap](https://github.com/OxyHQ/oxy-infra/pull/409):
  transactional ownership, exact ACLs, verified TLS, bounded create-only parameter
  publication and independent terminal markers. PostgreSQL 17 failure-injection
  tests cover recovery, drift and revoked access. The activation order is empty
  database bootstrap, privileged PostGIS setup, then application migrations.
- [Canonical Oxy registration](https://github.com/OxyHQ/oxy/pull/2012): operator-only,
  transactional deployment/application/origin/workload registration with durable
  ownership, drift detection and revocation checks. No caller can register itself
  by supplying a tenant header or origin.

These source and regression checks do not establish live tenant isolation,
customer DNS ownership, backup restoration or a measured RPO/RTO.

The supported mode is public federation. Participation can be open, invitation
allowlisted, or approval allowlisted. Private mode and email-domain restrictions
are rejected: there is no UI-only privacy switch or trust in a caller-supplied
email address. Invitations/approvals currently mean an operator-maintained list
of already verified Oxy account IDs, not a self-service invitation/approval flow.

## One deployment per process and data plane

`MENTION_DEPLOYMENT_CONFIG` is a server-only JSON document validated by
`@mention/shared-types/deployment`. See the synthetic, non-production example at
`packages/shared-types/__tests__/fixtures/managed-deployment.json` for its complete
shape. Replace all example account IDs, domains, source location and revision.
Do not commit real customer configuration or credentials into this repository.

The strict schema rejects unknown fields, malformed/oversized JSON, unsafe origin
shapes, credentials inside URLs, duplicate web/API/MCP/shell origins, unsupported
policies and invalid IDs. Errors report field paths rather than input values.
There are no plan/ranking/moderation-privilege fields in this document.

The canonical tenant ID is a UUID. Display names never become infrastructure
identifiers. Each process reads one manifest at startup. A `Host`,
`X-Forwarded-Host`, `X-Tenant-Id`, request body, or OAuth account switch cannot
select a different tenant. Host handling still routes web/API surfaces within
that one deployment; the ingress must enforce its own host allowlist.

Required fields:

| Section | Meaning |
| --- | --- |
| `schemaVersion`, `tenantId`, `mode` | Contract version 1, immutable tenant UUID, `public_federated` |
| `publicBaseUrl`, `apiBaseUrl`, `mcpBaseUrl`, `shellBaseUrl` | Distinct canonical HTTPS origins; no paths, credentials or custom ports |
| `region` | Operator's placement declaration, not evidence of where data is stored |
| `adminOxyAccountIds` | Oxy accounts admitted as operators of this instance; this does **not** grant a global Oxy or moderation role |
| `signup` | `open`, or `invite`/`approval` with `allowedOxyAccountIds` |
| `branding` | Name, about text, optional logo/icon URLs, accent hex, terms and contact HTTPS URLs |
| `release` | Deployed version, full Git revision, corresponding source URL and release-channel declaration |

The source revision/channel are deployment metadata, not a scheduler or proof of
artifact provenance. The future release controller must bind them to the actual
signed image and publish accessible source for that revision.

The manifest resolves the existing environment inputs:

| Manifest field | Runtime inputs |
| --- | --- |
| public origin | `FRONTEND_URL`, `MENTION_FRONTEND_ORIGIN`, `MENTION_WEB_ORIGIN` |
| API origin | `MENTION_PUBLIC_API_URL`, `MENTION_API_ORIGIN`, MCP's `MENTION_API_URL` |
| MCP origin | `MENTION_MCP_PUBLIC_URL` |
| shell origin | `WEB_SHELL_ORIGIN` |
| public hostname | `FEDERATION_DOMAIN`, `ACTOR_DOMAIN` |
| public mode | `FEDERATION_ENABLED=true` |

Explicit environment values that disagree with the manifest fail startup. Remove
public-instance defaults from a copied `.env.example`; do not silently reuse them.
With the manifest unset, the normal public Mention defaults remain unchanged.

## Secret and storage requirements

The backend refuses managed configuration without explicit `DATABASE_URL`,
`REDIS_URL`, the registered infrastructure workload role, `MENTION_OXY_CLIENT_ID`
and `MENTION_SHELL_ACCESS_KEY`. Other existing runtime secret requirements still
apply. MCP uses its independently registered infrastructure workload identity.
Backend, worker and MCP roles bind to the same canonical managed application
through Oxy's operator registration. Own-product calls use workload transport and
original requester proof where an account is involved; no static service secret,
app scope, consent grant or caller-provided tenant header substitutes for it.
Keep secrets in the infrastructure secret store; they never belong in this JSON.

**Presence of those values does not prove isolation.** The infrastructure
controller must enforce a dedicated database and least-privilege database role,
a separate Redis/Valkey instance or a fully audited namespace/credential boundary,
separate worker/queue credentials, isolated backups, and tenant-scoped Oxy media
permissions. Mention currently delegates media storage/uploads to Oxy; a database
per customer is not sufficient. The same Oxy account may use several deployments,
but that is not permission for one deployment's service to read another's media.

No `tenantId` columns were added to social tables. No raw content is copied into a
new control-plane database. Reusing a data plane across tenants is unsupported.

## Identity and participation

Oxy remains the identity and authorization authority. No local passwords,
identity directory or SSO implementation is introduced. Restriction checks use
the **effective verified account**, after Oxy/MCP/capability authentication.
A connection owner, body field, forwarded tenant header or unapproved switched
account cannot substitute an allowed account.

Public HTTP reads and the public, payload-free realtime namespace remain public.
Writes through public routers, all authenticated-only routes, and authenticated
Socket.IO namespaces require admitted participation. Checks precede the HTTP
effect-idempotency response cache so an old write response cannot bypass a changed
policy. Existing per-resource ACLs and MCP capabilities remain required; being a
deployment administrator does not bypass them.

Account-list changes take effect when the manifest is redeployed. Drain old tasks
and socket connections as part of a policy rollout. This is not a live admin UI,
and it must not be advertised as immediate local membership revocation. Oxy's
existing live MCP/capability reauthorization remains intact on every request.

## MCP and capability identity

For tenant UUID `T`, the application identity is `mention-T`, the capability
audience is `mention-T-api`, and the protected resource is the configured MCP
origin. Register these exact values with central Oxy, using tenant-scoped service
credentials. Do not register tenant catalogs over the public `mention` catalog.

The tool registry, published catalog, HTTP token verifier and backend capability
verifier use this same identity. The catalog's version remains code-owned.
Backend and MCP must be released together from the same revision.
MCP tokens are checked against the exact central issuer, audience and resource;
foreign Mention MCP audiences are routed to verification and rejected rather than
retried as ordinary Oxy sessions. Managed deployments reject all transitional
Mention-issued HS256 MCP tokens, even before the public migration cutoff.

## Web/PWA builds and public discovery

The production frontend and Android widget configuration honor explicit API
origins. Unless separately configured, the WebSocket origin derives from that API
origin and the web OAuth redirect derives from the configured web origin.
Do not distribute a per-tenant native binary for this initial contract.

Generate safe public inputs:

```sh
bun scripts/managed-frontend.ts --print-env
```

This prints JSON, not shell commands. It includes no administrators, invitation
lists, service credentials, internal shell origin or server manifest. Do not
`eval` configuration. Build the tenant's web artifact with:

```sh
bun scripts/managed-frontend.ts --build
```

The build requires the registered tenant's `EXPO_PUBLIC_OXY_CLIENT_ID`, sets
production mode and passes only public Expo variables and basic build environment
keys to Expo. Server credentials and the manifest are not inherited by the child.
It changes no native bundle identifiers and creates no fork of Mention.

The welcome and About surfaces use configured branding. About keeps Mention/Oxy
attribution and links to source at the reported revision. The browser PWA title
and theme color use the public build variables. The backend serves the matching
managed `/manifest.json`, including its name, icon, theme color and share target.
Ensure the custom-domain ingress routes that path to the backend rather than the
static shell, alongside federation and discovery endpoints.

`GET /.well-known/mention-instance` publishes an explicit safe projection:
branding (including terms/contact links), canonical public/API/MCP/federation
identity, participation policy and source/version attribution. It excludes
operator IDs, approved-account lists, region and shell origin. `NodeInfo` reports
the configured release and open-registration policy. Managed profile-to-actor
redirects use the canonical federation origin. CSP permits the configured API and
WebSocket origins; CORS responses vary on `Origin`.

## Activation gates still owned by infrastructure and Oxy

The following are **not yet demonstrated end to end**. The source modules and
registration above cover parts of these gates, not their operational acceptance:

1. Compose canonical registration and infrastructure modules into a durable,
   leased/resumable provisioning workflow; bind the actual runtime resources to
   their registered identities; implement capacity enforcement and an operator/
   customer lifecycle dashboard. Registration metadata alone is not provisioned
   infrastructure.
2. DNS ownership proof bound to tenant/domain, re-verification, TLS issuance and
   renewal, ingress configuration, custom-domain Oxy OAuth registration, and live
   WebFinger/actor/signature/inbound/outbound federation validation.
3. Two independently provisioned databases, caches, queues, workload identities and
   media boundaries, with negative access tests using real tenant credentials.
4. Backups with encryption, retention, measured RPO/RTO, an actual restore into a
   fresh isolated environment, plus federation/outbound-job fencing to prevent
   replay while restoring or rolling back.
5. Stable/delayed/preview scheduling, backup-before-migration, health-gated rollout,
   rollback plans for reversible changes and explicit handling of irreversible
   migrations. Declaration of a channel is not execution of that channel.
6. Tenant-scoped monitoring, redacted operational telemetry, audited temporary
   support access, alerts, incident response and measured capacity controls.
7. Billing/entitlements with retry/grace/suspension/retention policy that preserves
   export and never immediately destroys data on a failed payment.
8. A tested self-hosting exit bundle containing database, tenant-owned media,
   nonsecret configuration and matching source; domain and federation continuity;
   deletion only after explicit authorization and retention completion.

The infrastructure repository should consume this application contract rather
than implement a second social backend. Its control plane should store resource
references, lifecycle jobs, entitlement pointers, release/provenance records and
audit events, not posts, private messages, passwords or raw user-content logs.
Self-service approval, verified-email-domain admission, dedicated moderation roles
and end-to-end tenant media isolation require further integration before those
product claims can be made. Keep #954 open until its complete acceptance criteria
are verified, including real backup restoration and two live isolated deployments.

## Verification

Tests cover strict parsing, conflicting aliases, safe projections, two distinct
origin sets, effective-account admission, foreign MCP resource/audience rejection,
legacy-token rejection, discovery/CSP/NodeInfo/PWA output, and production frontend
and widget target selection. They do not constitute infrastructure isolation,
live federation, visual-device, DNS, backup-restore or billing verification.

Run the repository's normal `bun run check` and `bun run test` gates. Backend tests
require PostgreSQL, as for the existing suite. The new focused tests are:

```sh
bun test packages/shared-types/__tests__/deployment.test.ts
bun run --cwd packages/backend test -- src/__tests__/deploymentAdmission.test.ts src/__tests__/appFactory.test.ts
bun run --cwd packages/mcp test
bun run --cwd packages/frontend test -- deploymentConfig.test.ts
```

### Separate API and worker processes

`MENTION_PROCESS_ROLE` defaults to `combined`, preserving existing deployments.
The same backend image, built from `packages/backend/server.ts`, can run as `backend`
(HTTP and sockets, no job consumers) or `worker` (consumers and lease-elected
schedulers, health endpoints only). Do not run a worker with a backend task role:
its ECS workload identity must be the independently registered worker role.

Both split roles require cache Redis for Socket.IO delivery and queue Redis
(`QUEUE_REDIS_URL`, falling back to cache Redis) for durable work. Startup refuses
a missing/unreachable transport, and readiness becomes unavailable if either
connection drops. The worker's Socket.IO emitter uses a non-listening HTTP server and publishes
through the shared adapter without exposing a socket endpoint. Existing scheduler leadership
and atomic outbox claims still coordinate replicas; separating processes does
not create another scheduler ownership protocol.

The worker exposes `/health/live` and `/health/ready` on `PORT`, with no product
routes. Bootstrap checks database migrations before starting jobs. Shutdown stops
job producers and consumers before closing Redis/PostgreSQL; repeated shutdown
signals drain once. A rollout must provision both roles against the same isolated
tenant database, cache and queue, and verify worker readiness before switching
API tasks from `combined` to `backend`. This setting does not provision ECS,
secrets, workload registration, DNS or backups by itself.
