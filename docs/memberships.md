# Membership communities

Memberships are a separate Mention domain owned by an Oxy account. They do not
change follows, channel replies, public post visibility, ranking or discovery.
The free community flow is available; paid tiers remain drafts. No price,
commission, grace duration, merchant binding or payment activation is inferred.

## Authority and lifecycle

`membership_communities` owns tiers, explicit benefits, memberships, discussions,
articles, polls, reports and private media references. Composite foreign keys
prevent a content policy, membership or poll vote from referring across community
boundaries. Account erasure and channel deletion explicitly remove account-owned
rows; dependent records cascade and media reference removals enter Oxy's outbox.

Owners and authorized organization/project/channel operators manage communities
through the existing publish-as authority predicate. An active Oxy account seat
alone is not a paid/community membership. Foreground session endpoints preserve
the original requester; arbitrary owner IDs, MCP publishing grants, task proofs
and own-service credentials cannot be exchanged for member access.

Public/unlisted is the community's independent metadata setting, not the owner's
profile privacy. Every response still applies canonical account availability,
suspension, erasure and symmetric block checks. The application resource grant
is made only after local community authority; failures withhold content.

Member reads check state, expiry and the requested benefit on every HTTP request.
There is no entitlement cache. Immediate leave clears access and public badge
consent; revocation cannot be undone by a self-join. A retired tier stops new
joins without removing existing membership benefits. Closing a community denies
content but does not delete memberships or ordinary public social content.

## Privacy boundary

| Surface | Protected content behavior | Evidence |
| --- | --- | --- |
| HTTP page, direct ID and thread | Membership plus tier policy before body hydration; expired/revoked/blocked denied | PostgreSQL-backed membership route tests |
| Public metadata/teaser | Explicit authored teaser projection; no body, attachment metadata, poll options or results | Route tests, separate shared DTO |
| Public feeds/search | Dedicated tables are not written to `posts` or public search indexes | Domain write paths; test verifies no public post created |
| ActivityPub/embeds | No publication/federation/outbox writer; protected IDs are not ordinary posts | Dedicated domain storage and routes |
| MCP/AI | Foreground-only endpoints reject MCP, capability and service proofs | Three independent route denial tests |
| Push/notifications | No private body, membership activity or named viewer fan-out is emitted | No notification writer in the domain |
| MTN | No protected membership record is published to public repo records | Domain write paths have no MTN append |
| Media | Mention-owned private copy, original requester, no personal/guardian file access; authoritative live visibility required; callback changes withhold; original requester retained | Route tests, reference registry/outbox tests |
| Frontend/account switch | Viewer-scoped ephemeral query keys; no stale body after denied refetch or account change; pending leave hides content and cancels/removes pages | React Query screen regressions |
| Directory/insights | Directory includes explicit badge opt-ins only; metrics aggregate membership states, never page viewers | Route tests |
| Reports | Creator queue omits reporter identity; independent safety review requires a fresh Oxy app permission and a committed report-bound audit | Real SDK/HTTP authority fixture and PostgreSQL route tests |

The absence of public integrations is intentional, not a claim of authenticated
production validation of every surface. New integrations must extend this matrix
and their behavioral tests before publishing protected data. Signed media links
remain bearer URLs for Oxy's bounded TTL; see [Oxy Files](./oxy-files.md).

## Application flows

The account menu opens `/memberships`. An operator can create a draft, edit its
public metadata, activate it, pause joining or close it. Each community starts
with a free tier. Operators can edit its explicit benefits, retire it, and plan
paid tiers as drafts; paid activation is rejected both by the API and a database
constraint. Members can join, leave, opt into the directory, discuss, vote, attach
private files and report content. Operators can remove content, revoke members
and resolve reports without receiving reporter identity.

There is no automatic opt-in to follows or directory visibility. Reports are not
copied into public CrowdSource evidence. The current CrowdSource file contract
withholds private files from jurors; it is not a protected-membership evidence
transport. Mention therefore owns the narrow safety review below.

## Independent safety review

The backend declares `memberships.moderate` in
[its application permission declaration](../packages/backend/src/runtime/applicationPermissions.ts).
Before an operator can review anything, an application owner must declare the
vocabulary through Oxy Console's application Roles tab (or the canonical
`PUT /applications/:applicationId/roles/permissions`) and grant the key to a
human operator. That API replaces the **whole** vocabulary; preserve other
existing declared keys when applying this declaration. Registration uses
`config.identity.serviceApplicationId`, including a managed deployment's own
registration. Shipping this code does not declare keys or grant anyone access.
Until configured/granted, review fails closed. Oxy's
[application role contract](https://github.com/OxyHQ/oxy/blob/main/docs/auth/application-roles.md)
owns declaration, grant and revocation, including the prohibition on unauthorized
self-grants. There is no local operator-ID allowlist.

Every review request requires a verified foreground human session and a fresh
`appPermissionsFor` read. Account management, creator ownership and membership
alone confer no safety-review power. MCP, delegated service and task proofs are
refused. Oxy resolves the original human even when the session acts as an
organization; that human is the audit actor. Unavailable role authority denies
access. This explicit safety power is independent of the creator's membership
or blocking relationship; otherwise a creator could conceal reported abuse by
blocking a reviewer. It grants no public-feed or general content browsing path.

Reporting returns a `reportId` receipt for escalation. An authorized operator
uses only the exact community/report pair under
`/membership-communities/:communityId/reports/:reportId`:

- `POST /inspect` with `{ purpose }` returns the bound report's reason and content,
  poll options and attachment identifiers, excluding reporter identity and URLs.
- `POST /media/:mediaId` with `{ purpose }` returns only that report's bound file
  after live private visibility checks with the original operator session.
- `POST /decision` with `{ action, purpose }` accepts `remove_content`,
  `suspend_community` or `dismiss_report`; the action and its audit commit together.

Purpose is a required 10–1000-character justification, not a place to paste
private evidence. It is retained as supplied and can itself contain sensitive
text; no public audit exporter is provided. Inspection/media audit writes commit
**before** delivery. Audit failures withhold evidence. The ledger stores no copied
body, signed media URL or reporter identity. Membership bodies have no edit API:
review returns the current report-bound body, including removed content, while
it exists; this is not a separate permanent evidence snapshot. Account/content/
report erasure cascades the evidence and its review audit. Erasing a reviewer
clears their attribution on retained report audits.

Remote URL minting does not hold a database transaction. Both member downloads
and review downloads recheck current local authority, exact bindings and Files
state after the network await; review also rechecks the live Oxy operator grant.
Erasure or revocation during that await withholds the returned URL. Already
issued bearer URLs remain subject to Oxy's bounded TTL, not instantaneous local
revocation. No private evidence is sent to CrowdSource or exposed by public
teasers, search, federation, MCP or the member directory.

Validation uses real PostgreSQL and the published OxyServer permission resolver
against a controlled HTTP authority fixture. It proves denial and revocation
behavior, not a production operator grant or live protected jury integration.

## Billing work and activation prerequisites

Peable is the canonical payment execution boundary. Its official SDK supports
`new Peable({ oxy, requester })`: Oxy owns workload credentials and the original
requester proof. Do not use Mercaria's legacy credential-backed adapter as a new
integration, embed Stripe directly, or invent an app merchant/customer mapping.

Peable `BillingSubscription` is an observation, not proof of payment. The receipt normalizer verifies the paid invoice and its signed final
invoice authority and binds all of merchant, application/environment, payer,
subscription, offer/version, community and tier. Provider identifiers stay in private `membership_billing_receipts`, not public
social IDs. A unique source key makes concurrent replays idempotent; changed
payers, communities, tiers or immutable invoice identity are rejected. Older
observations and refund-state reversals cannot rewind stored refunds. These
records are entitlement evidence, not fiscal records: community/payer erasure
removes them while Peable remains the accounting system of record.

`reconcileMembershipInvoice` uses the official Peable SDK 0.5.0 and its pinned
invoice authority keys. It reads authoritative invoice state and the verified
signed final authority, checks their payer, product, period and fiscal totals,
and disposes the requester-bound client. The reviewed versioned catalogue is
empty, so runtime calls stop before any provider request. `POST /membership-communities/:communityId/tiers/:tierId/billing/reconcile`
is a foreground-only recovery entry point accepting exactly invoice and
subscription references. It binds the payer to the authenticated actor and
returns only a recorded status. With the empty catalogue it returns 409 before
network or database writes; it accepts neither payment status nor payer overrides.
There is no webhook or task/service impersonation path. Receipt storage never writes an entitlement or
activates a paid tier; paid activation remains forbidden in PostgreSQL.

Commercial decisions remain deferred by the user: amounts, commission and grace
rules. Runtime activation additionally requires a reviewed Mention merchant and
offer catalogue, invoice authority keys, requester-preserving checkout/portal
calls, verified receipt normalization, reconciliation and bounded revocation.
No generic webhook accepting `active` is exposed and no existing Peable/Mercaria
production billing cohort is repurposed for memberships.

Sources: Oxy ADR 0033, Peable ADR 0010 and
[the billing runtime binding runbook](https://github.com/OxyHQ/oxy-infra/blob/main/docs/runbooks/51-billing-runtime-bindings.md).
The receipt tests use synthetic invoice evidence and a real local PostgreSQL
database; they do not demonstrate a live Mention merchant binding or purchase.
