# Own product authentication

This branch implements the Oxy decision that own products share account access
without OAuth scopes or per-application consent. It is source under validation,
not evidence of production deployment. The platform decision and cross-repo
tracker live in [Oxy's migration ledger](https://github.com/OxyHQ/oxy/blob/feat/first-party-integration/docs/architecture/first-party-integration-migration.md).

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

## Original account and downstream operations

Shared middleware verifies every own incoming service token and requester
session/task live. Mention preserves the verified effective account. It never
substitutes a bot owner, service owner, arbitrary account header or service JWT
for the requester. For a human operating an organization, foreground profile
operations keep the original operator and effective organization separately.

- A human session uses the isolated SDK requester/session client.
- An Alia capability operation passes its actual ticket to the shared Files,
  private graph and safety APIs. The ticket's original task, actor, account,
  recipient and current authorization remain Oxy's responsibility.
- An own service call receives a short-lived `requesterContext` from Oxy through
  shared middleware. Mention uses that proof for downstream Files, graph and
  safety reads; it does not reuse the upstream coordinator's task ID under its
  own workload. Missing context fails closed. Proofs are never persisted or
  logged and downstream calls revalidate the original authority.
- External MCP media uses `withMcpMediaRequester` with the original connection
  token and exact upload tool. Oxy checks the live connection/grant and media
  capability. This grants neither a human session nor general Files access.

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

| Edge | Source in this branch | Remaining release work |
| --- | --- | --- |
| Mention backend/MCP → Oxy | Shared workload provider; MCP catalog/audit/introspection use v2 transport | Publish and pin composed core 7/contracts 6/MCP 1.4; Oxy receiver first; deploy and verify |
| Alia → Mention → Oxy Files/privacy/safety | Actual capability ticket, live revalidation, no owner/session fallback | Alia/Oxy release ordering and runtime canary |
| Move → Mention → Oxy | Own receiver and derived requester context; shared import contract and SDK `/server` factory | Move source 75dfab7 creates durable original tasks; publish/pin SDK; canary lookup/import/undo |
| Mention backend → Clarity | `clarityForOxyService`, shared canonical service transport | Clarity receiver first, SDK release/pin, caller canary |
| Mention frontend → Clarity | `clarityForOxySession`, shared linked client | Clarity SDK release/pin and frontend build/deploy |
| Mention media cache → Oxy | Shared workload transport and explicit disk body factory; no manual bearer or local auth retry | Publish/pin core streaming addition (planned 7.1), then verify streaming/cancellation and outbox retry canaries |
| Mention backend → Kaana | Product SDK own factory; immutable per-call attribution; no manual bearer | Publish/pin Kaana SDK and core; preserve one-dispatch shadow ledger and app-paid accounting |
| Mention frontend → Syra | Product SDK linked-session factory, retained lazy client-only entry | Publish/pin Syra SDK and core; runtime account-switch canary |
| Mention frontend → Alia | Existing product SDK client; no backend Alia proxy found | Coordinate final shared SDK adoption with Alia SDK owner |
| Schedio → Mention | Own publishing adapter/SDK; Schedio source f05b3d3 uses original automation root | Publish/pin SDK; receiver before caller; retain external Mastodon OAuth |

No local allowlist, token decoding fallback or `internal`-tier promotion is added
to Mention. Any temporary legacy workload bridge is centralized in Oxy and
limited to its verified live cohort. Remove that bridge only after all producers
use v2 and live consumers are verified. Existing queue/import records must not
be reclassified as authorized from app branding or an owner ID.

The manual Telegram export script now requires `IMPORT_OXY_TASK_ID` for writes:
it must identify a task created for the original account under Mention's
coordinator identity. Dry runs do not need a task. The script does not mint
requester authority from its target account argument. Operators must establish
that task through the verified account flow before running a live import; no
unattended legacy bearer is promoted automatically.

## Validation and release boundary

Local candidate packages are used only in the isolated worktree; `file:` pins
must never be committed. The final registry pins and lockfile are a release
prerequisite, not an optional cleanup. Root coordinates publication and rollout.

Coverage includes actual shared SDK → HTTP → Mention receiver → shared Files
transport, separate original person/bot owner, revoked authority, wrong account,
no task forwarding to the downstream workload, external MCP behavior and
managed-account foreground attribution. HTTP authority fixtures cover transport
composition; Oxy's API integration suites cover the database authority checks.
Run backend Vitest and Bun suites, MCP suite, SDK suite, affected frontend tests,
types, build and Biome before declaring this source checkpoint ready. Deployment
and cross-service runtime canaries are still pending.

## Own scheduled publication follow-up

The own SDK now provides `identity()` and `publish(input, originalEffectKey)`
through its shared workload/requester transport. `/publishing/v1/posts` is a thin
adapter behind central authentication and the same post-write limiter: verified
own principal plus matching account proof, durable receipt reservation, then the
existing `createPost` domain handler. No MCP grant, fabricated connector or tool
catalog is created. External `MentionPublishingClient` remains unchanged.

The existing receipt table uses a distinct `oxy-service:<appId>` namespace for
own publishers and the verified effective account. Duplicate/conflicting keys
return 409 without executing again; the SDK reports an unknown outcome and
never invents a post URL after a lost/invalid response. Schedio must retain the
same key and body for each scheduled revision. Account switch, revocation and
external branded credentials cannot select another person's publication.

Source and candidate tests only: Schedio adoption is committed as f05b3d3; published SDK pins, reader rollout and production canaries remain pending.

Kaana calls now use `kaanaForOxyService`. Calls attributed to a person create an
isolated SDK client with immutable inference attribution and dispose it afterward;
Jev's service-wide client retains `maxRetries: 0` and its existing durable ledger.
Attribution remains app-paid accounting, never private-data or payer authority.
Syra podcasts use `syraForOxySession` from the same lazy `/client` boundary, so
refresh/account switching stay with Oxy and LiveKit is not pulled into that chunk.

Files streaming now uses the shared `fetchReplayable` addition. Each authorized
attempt opens a fresh disk stream; only the shared transport decides whether a
401 warrants one retry. File handles close on cancellation, completion and before
replay. The store retains its 60-second inactivity deadline (not a total upload
duration), separate upload/delete cooldowns, deduplication and namespace deletion
behavior. Unknown batch results remain unanswered for the existing outbox to retry.
Federated owner metadata stays a domain field of the public federation endpoint,
not requester authority over personal Files. The purge script's preflight also
uses the shared v2 workload transport. No production backend manual service-token
calls remain in this branch.

This source requires the subsequent core streaming release (planned 7.1); core
7.0's ordinary raw fetch does not replay streams. Candidate validation is not a
registry pin or a deployment. The final composition must include the patched
Zod 4 foundation as well as the streaming addition before cutover.

Streaming candidate gate: 75 media-store, batch-delete and purge tests pass,
including actual HTTP mint/replay of a disk file, an interrupted upload with no
retry, pre-cancellation before opening a file, 429 cooldowns and namespace
outcomes. Backend TypeScript, production build and changed-file Biome pass.
The tests use valid five-minute workload tokens; no manual-token mock bypasses
the shared transport. Final registry-pinned composition remains pending.

The final composed core 7.1 candidate (`1421bc6`) with contracts 6 and patched
Zod 4 also passes 88 backend tests, including the transitive requester/Files
HTTP routes, all 183 MCP tests, and backend/MCP TypeScript. That supersedes the
older streaming-only candidate for compatibility evidence. Source is unchanged
from the built streaming checkpoint; package publication, registry pins and
runtime canaries remain separate release gates.

Candidate validation for this caller checkpoint: 50 backend inference/classification
tests, the Syra client integration test, backend/frontend TypeScript, backend build
and changed-file Biome checks passed. Candidate package overrides were restored
before committing; registry releases and final dependency pins remain pending.
