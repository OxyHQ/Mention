# Own product authentication

This branch implements the Oxy decision that own products share account access
without OAuth scopes or per-application consent. It is source under validation,
not evidence of production deployment. The platform decision and cross-repo
tracker live in [Oxy's migration ledger](https://github.com/OxyHQ/oxy/blob/main/docs/architecture/first-party-integration-migration.md).

Own backend processes use one lazy `OxyServer` with
`createAwsWorkloadCredentialProvider()` from `@oxy.so/core/server/aws`. The
standard AWS provider supports temporary role credentials, including local
role/SSO use; no ECS environment-variable gate substitutes for attestation.
`OXY_SERVICE_API_KEY` and `OXY_SERVICE_API_SECRET` are rejected in own deployment
configuration. External customer credentials and external MCP OAuth are separate
and keep their restrictions. Provider failures do not disable classification or
inference behind a misleading “missing API key” switch.

The public deployment's registered application is
`6a2f851751b784a86fd0e916`; its service audience is
`oxy-service:6a2f851751b784a86fd0e916`. A managed deployment must configure its
own registration explicitly. An application identifier is identity, not proof
that a credential is internal. Only shared verification may produce
`authority: first_party`; API keys remain external even for an official app.

## Acting for people (oxy ADR 0066)

Oxy's own services never ask people for permissions, tasks, sessions-as-proof or
consent; permissions, scopes and consent are only for third parties. Mention's
entry in [Oxy's first-party registry](https://github.com/OxyHQ/oxy/blob/main/packages/api/src/scripts/seedOxyApplicationsSpecs.ts) declares
what its backend does for the people who use it: `oxy:files` write, `oxy:safety`
read, `oxy:privacy` read, `oxy:tools` read and Peable read. Oxy checks that
declaration and the accounts live on every call; nothing is minted, stored or
renewed. Mention preserves the verified effective account and never substitutes
a bot owner, service owner, arbitrary header or service JWT for it.

- A person's own request reads Oxy with their verified bearer (`oxy.asUser`,
  Safety `{ accessToken }`). Files they upload or that Mention keeps for them go
  through `assets.actingFor({ accountId })` (with `requesterAccountId` when they
  operate an organization).
- A Gemies/Alia capability ticket stays the tool transport into Mention. Its
  downstream Files, privacy and Safety reads are Mention acting for the ticket's
  effective account (`oxy.actingFor`, `{ actingForAccountId }`); the ticket is
  never forwarded.
- Another Oxy service (Move, Gemies) arrives through `OxyServer`'s `auth()`
  middleware as `req.serviceActingAs = { userId, authority: 'first_party',
  requesterId }`. Mention admits it only with that answer and `userId` equal to
  the request's account, then acts for that account in the same way. Imports
  stay Move-only; publishing keeps its durable `mcp:` receipt.
- Recommendations (`recommendProfiles`) use
  `agency.createFirstPartyExecutionAuthorization` on the declared `oxy:tools`.
- External MCP media uses `withMcpMediaRequester` with the original connection
  token and exact upload tool. Oxy checks the live connection/grant and media
  capability. That is third-party authority and is unchanged.

Public post media keeps the verified account as owner. Domain rules such as
Move-only importing, publication ownership, blocks, supervision, quotas and
billing are unaffected by removal of OAuth scopes between own products.

The documented external publishing SDK uses resource-bound MCP OAuth. The MCP
privacy and upload paths above preserve that proof. General external
service-plus-grant credentials do not acquire an own downstream context: the
previous private-graph helper forwarded a service JWT to Oxy's session-only
privacy route and was already refused. No supported external service-mediated
private-graph contract or caller was found in the audited docs/tests. A future
external service delegation must gain an explicit bounded central proof, not
reuse the own path or infer an account from a header.

## Migration ledger

| Edge                                        | Source in this branch                                                                                                                                                                                  | Remaining release work                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Mention backend/MCP → Oxy                   | Shared workload provider; MCP catalog/audit/introspection use v2 transport                                                                                                                             | Foundation is published/live; final lock composition, deployment and canary remain                                      |
| Gemies → Mention → Oxy Files/privacy/safety | Capability ticket into Mention; Mention acts for its account on its declared authority (ADR 0066)                                                                                                      | Verify after the declarations deploy                                                                                    |
| Move → Mention → Oxy                        | Own receiver admitting Move's declared authority; import SDK 0.3 (`actingFor`)                                                                                                                         | Receiver first, then Move on SDK 0.3                                                                                    |
| Mention backend → Clarity                   | `clarityForOxyService`, shared canonical transport; published SDK 0.10                                                                                                                                 | Reader live and legacy reconciliation verified; caller deployment/canary remain                                         |
| Mention frontend → Clarity                  | `clarityForOxySession`, shared linked client; published SDK 0.10                                                                                                                                       | Final frontend composition/build/deployment                                                                             |
| Mention memberships → Oxy Files             | Member's own request, `assets.actingFor` on Mention's declared `oxy:files`; Mention-owned private copy, authoritative linked-download visibility                                                       | Core 7.5.1 published; deploy Mention and verify a private upload/read/revocation canary                                 |
| Mention membership receipts → Peable        | Official SDK workload transport acting for the payer (declared Peable read); native invoice, subscription and PaymentIntent reads with exact offer binding; no status observations accepted as payment | SDK 2.0.0; catalogue empty, so no provider call or paid activation until the Mention merchant/offer binding is approved |
| Mention media cache → Oxy                   | SDK `assets.mediaCache` / `assets.federatedMedia` as the workload identity; Blob body streamed from disk                                                                                               | Core 7.19 methods; verify live cancellation/outbox retry after deployment                                               |
| Mention backend → Kaana                     | Published SDK 3.3 own factory and immutable attribution                                                                                                                                                | Producer receiver live; verify one-dispatch ledger and app-paid accounting                                              |
| Mention frontend → Syra                     | Linked-session factory, lazy client-only entry                                                                                                                                                         | Published SDK 0.23 pinned and artifact verified; account-switch runtime canary remains                                  |
| Mention frontend → Alia                     | Existing product SDK client; no backend Alia proxy found                                                                                                                                               | Coordinate SDK update with Alia owner; do not infer adoption from the foundation version                                |
| Schedio → Mention                           | Own publishing adapter, SDK 0.3 (`actingFor`)                                                                                                                                                          | Schedio needs its registry entry (`actsForPeople`: Mention write) before launch; external Mastodon OAuth retained       |

No local allowlist, token decoding fallback or `internal`-tier promotion is added
to Mention. Any temporary legacy workload bridge is centralized in Oxy and
limited to its verified live cohort. Remove that bridge only after all producers
use v2 and live consumers are verified. Existing queue/import records must not
be reclassified as authorized from app branding or an owner ID.

The manual Telegram export script uploads to the channel's files on Mention's
declared `oxy:files`, for the person `IMPORT_OPERATOR_OXY_USER_ID` names; Oxy
checks they run the channel at that moment. Dry runs upload nothing.

## Validation and release boundary

Local candidate packages are used only in the isolated worktree; `file:` pins
must never be committed. The final registry pins and lockfile are a release
prerequisite, not an optional cleanup. Root coordinates publication and rollout.

Coverage includes actual shared SDK → HTTP → Mention receiver → shared Files
transport, an undeclared or revoked caller, wrong account, nothing of the
incoming request forwarded downstream, external MCP behavior and
managed-account foreground attribution. HTTP authority fixtures cover transport
composition; Oxy's API integration suites cover the database authority checks.
Run backend Vitest and Bun suites, MCP suite, SDK suite, affected frontend tests,
types, build and Biome before declaring this source checkpoint ready. Deployment
and cross-service runtime canaries are still pending.

## Own scheduled publication follow-up

The own SDK now provides `identity()` and `publish(input, originalEffectKey)`
through its shared workload transport (`actingFor`). `/publishing/v1/posts` is a thin
adapter behind central authentication and the same post-write limiter: verified
first-party principal acting for the same account, durable receipt reservation, then the
existing `createPost` domain handler. No MCP grant, fabricated connector or tool
catalog is created. External `MentionPublishingClient` remains unchanged.

The existing receipt table uses a distinct `oxy-service:<appId>` namespace for
own publishers and the verified effective account. Duplicate/conflicting keys
return 409 without executing again; the SDK reports an unknown outcome and
never invents a post URL after a lost/invalid response. Schedio must retain the
same key and body for each scheduled revision. Account switch, revocation and
external branded credentials cannot select another person's publication.

The publishing SDK/contracts 0.2.0 are public. Schedio PR 71 pins those artifacts; its own receiver rollout and production canaries remain pending. Source and package publication do not demonstrate deployed authority.

Kaana calls now use `kaanaForOxyService`. Calls attributed to a person create an
isolated SDK client with immutable inference attribution and dispose it afterward;
Jev's service-wide client retains `maxRetries: 0` and its existing durable ledger.
Attribution remains app-paid accounting, never private-data or payer authority.
Syra podcasts use `syraForOxySession` from the same lazy `/client` boundary, so
refresh/account switching stay with Oxy and LiveKit is not pulled into that chunk.

The federation media store (`services/mediaCache/oxyMediaStore.ts`) calls the
SDK's `OxyServer.assets.mediaCache` / `assets.federatedMedia` (core 7.19), as
Mention's workload identity: no hand-built transport. Upload bodies are a Blob
over the temp file (`fs.openAsBlob`), streamed from disk and never buffered;
cancellation aborts the upload. Each write is sent once — no transport retry,
except that the SDK resends once with a fresh service token when Oxy answers
401 to a rotated or revoked one (core 7.20); the worker, eviction and deletion
outbox retry a failed write later. One upload is bounded at 5 minutes (request to answer), one delete call
at 60 seconds. The store keeps its separate upload/delete cooldowns, sized from
the wait a 429 names (`retryAfterSecondsOf`), its permanent refusals
(`FEDERATED_MEDIA_OWNED_ELSEWHERE`, not-a-cache-object) and namespace deletion
behavior; an id the batch delete leaves unanswered stays owed for the outbox.
Federated owner metadata stays a domain field of the public federation endpoint,
not requester authority over personal Files. The purge script's preflight mints
the same workload token (`oxy.serviceToken()`). No production backend manual
service-token calls remain.

## Published registry composition, 2026-10-25

Public core 7.3.0 includes the streaming transport introduced in 7.1; ordinary
core 7.0 fetch cannot replay streams. Contracts 6.0.0 uses patched Zod 4.
Kaana SDK 3.3, Clarity SDK 0.10, Mercaria SDK 0.7.1 and CrowdSource core 3.1
are published. Candidate-only validation has been superseded by registry-based
tests of these packages. The installed contracts declaration was compared with
the registry bytes, and stale nested Clarity 0.9 copies were removed before
checking the frontend against the published 0.10 artifact.

Registry-based gates passed: 130 focused backend tests covering media streaming,
imports and transitive requester proof; two real workload HTTP tests; 183 MCP
tests; eight frontend experience/podcast tests; backend/MCP types and builds;
and the workspace boundary check. These counts describe separate targeted runs,
not the full CI suite. The import fixture preserves the real external authority
projection, so branded external credentials reach the own-only policy rejection
without a forged first-party introspection result.

The initial composition pinned published Syra SDK 0.23 (superseded by the
0.24 live-socket follow-up below). Its tarball integrity and actual
`syraForOxySession` JavaScript/types plus `/client`, `/live` and `/upload` exports
were verified; installed source/build files match the registry artifact. The
older 0.22 artifact is not used. Frozen installation, final frontend TypeScript
and all eight affected frontend tests pass. All package references are public
registry versions; no local override is committed.

This completes the source composition prerequisite. Full runtime CI, deployment
and live cross-product/account-revocation canaries remain separate acceptance
steps. Deploy this receiver before enabling Move PR47 and Schedio PR71.


CI follow-up verifies the CrowdSource factory with Mention's shared infrastructure
provider against real loopback HTTP (workload v2, canonical recipient, no customer
key mint). Constructing the lazy client does not attest authority; dispatch still
requires the shared live workload verification. The publishing SDK is an explicit
backend test dependency and is built in CI before receiver contract tests. The
lazy Syra client has concurrent initialization/cache coverage through the existing
Jest import transform; production's asynchronous bundle boundary is unchanged.

Production configuration names were checked on 2026-10-25 for Mention task
revision 720 and MCP revision 420: neither contained retired Oxy service-key
variables or managed-deployment identity variables. Managed operators must set
`MENTION_SERVICE_APPLICATION_ID` to their registered receiver application before
starting this release; it must not use the public Mention receiver identity.
This inventory is a dated configuration check, not evidence of this branch's
runtime deployment or completion of the rollout canaries.


## Alia client transport

The frontend source uses the published `@gemies/sdk` (from OxyHQ/Gemies) with the existing
Oxy Core / services stack. Alia owns conversation, history, streaming and audio
transport through the shared Oxy session; the app keeps its existing provider,
agent selection and UI. No app-local bearer refresh or internal permission prompt
is introduced. Package installation was checked against the published artifact;
source adoption and deployment are separate rollout steps.

The backend pins the same SDK major for its isolated CSP helper.

## Feed and notification socket sessions

Feed and notification sockets resolve credentials for each handshake through
Oxy's target-bound linked client. The socket origin must match the configured
HTTP API origin (with the corresponding HTTP/WebSocket scheme); no bearer or
client-asserted user id is retained in the socket's options. Account/session
changes abort pending handshakes and close the existing socket before a new
viewer subscribes. Same-session token refresh keeps its manager and domain
subscriptions; existing feed invalidation, engagement queues and browser
back/forward-cache reconnect behavior remain owned by the socket service.

The real Socket.IO tests cover connected account switches, logout, disposal and
refresh pending across a switch. Existing post-engagement tests now run through
the actual published Oxy linked client. Jest resolves the packages' published
CommonJS entries, including protocol randomness, rather than replacing their
identity behavior with mocks. Production package resolution is unchanged.

The socket follow-up passed 3,115 frontend tests across 392 suites and frontend
TypeScript. The unchanged coverage ratchet passes; the new shared-session helper
adds one behavioural file and one measured coverage pin (305 files / 300 pins).

## Syra live socket SDK — published 0.24.0

The workspace catalog now pins public `@syra.fm/sdk` 0.24.0 for the frontend and
backend. Its live-room hook acquires a shared Oxy connection lease instead of
copying a session bearer. Two mounted consumers share the connection; account
changes abort the old authority, and late cleanup cannot close the next account.
The backend's headless podcast client contract is unchanged.

The [Actions release](https://github.com/OxyHQ/Syra/actions/runs/40192840084)
published source `41da86f21471a44bcee898c6ab93a25a8dbec496`. Registry integrity,
the public `/live/socket` export, runtime `connectWithOxy` implementation and its
declarations were verified; Mention's installed JavaScript and declarations
match the downloaded registry artifact. The supported optional peers are core
> =7.1 <8 and services >=13 <14, satisfied by the existing workspace.

Local composition gates passed: frontend and backend TypeScript, 24 frontend
checks covering Syra HTTP clients, live-room ownership and real Socket.IO session
switches, five backend podcast checks, frozen install, registry-only lock guard
and Oxy Doctor. CI and frontend deployment remain separate acceptance steps;
this consumer pin does not activate workload-v1 retirement.
