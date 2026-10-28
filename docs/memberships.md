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
| Reports | Local operator queue excludes reporter identity; scoped resolution does not hydrate the body | Route tests |

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
copied into public CrowdSource evidence. A central protected-evidence review
integration requires its own scoped authority contract before enablement.

## Billing work and activation prerequisites

Peable is the canonical payment execution boundary. Its official SDK supports
`new Peable({ oxy, requester })`: Oxy owns workload credentials and the original
requester proof. Do not use Mercaria's legacy credential-backed adapter as a new
integration, embed Stripe directly, or invent an app merchant/customer mapping.

Peable `BillingSubscription` is an observation, not proof of payment. A future
normalized entitlement grant must verify the paid invoice and its signed final
invoice authority and bind all of merchant, application/environment, payer,
subscription, offer/version, community and tier. Persist provider identifiers in
private billing records, not public social IDs. Replays, stale observations,
refunds and account erasure need transactional, idempotent handling.

Commercial decisions remain deferred by the user: amounts, commission and grace
rules. Runtime activation additionally requires a reviewed Mention merchant and
offer catalogue, invoice authority keys, requester-preserving checkout/portal
calls, verified receipt normalization, reconciliation and bounded revocation.
No generic webhook accepting `active` is exposed and no existing Peable/Mercaria
production billing cohort is repurposed for memberships.

Sources: Oxy ADR 0033, Peable ADR 0010 and
[the billing runtime binding runbook](https://github.com/OxyHQ/oxy-infra/blob/main/docs/runbooks/51-billing-runtime-bindings.md). Catalogue and receipt
implementation is tracked separately from this tested free community flow.
