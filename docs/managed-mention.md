# Managed Mention: dedicated application contract

Related: [Managed Mention #954](https://github.com/OxyHQ/Mention/issues/954).

## Implementation status

This is the **application-side foundation**, not a hosting control plane or a
claim that the entire issue is complete. It makes the existing backend, web/PWA
and MCP deployable with consistent instance configuration and adds participation
and token-binding guards. It does not provision resources, verify DNS ownership,
issue certificates, isolate Oxy media, bill customers, or perform backups.
**Do not activate a paid managed deployment until the infrastructure and Oxy
integration gates below have been demonstrated.** Issue #954 remains open.

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
`REDIS_URL`, `OXY_SERVICE_API_KEY`, `OXY_SERVICE_API_SECRET`, `MENTION_OXY_CLIENT_ID`
and `MENTION_SHELL_ACCESS_KEY`. Other existing runtime secret requirements still
apply. MCP requires its own centrally registered Oxy service credentials.
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

The following are **not implemented or proven by this application change**:

1. Durable control-plane records and tenant-scoped owner/admin authorization;
   idempotent, leased/resumable provisioning; infrastructure-as-code; capacity
   enforcement and a customer-facing lifecycle dashboard.
2. DNS ownership proof bound to tenant/domain, re-verification, TLS issuance and
   renewal, ingress configuration, custom-domain Oxy OAuth registration, and live
   WebFinger/actor/signature/inbound/outbound federation validation.
3. Two independently provisioned databases, caches, queues, service identities and
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
and tenant-scoped media require further application/Oxy integration before those
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
