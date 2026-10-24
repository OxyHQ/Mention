# Temporary Zod 3 dependency review — 24 October 2026

This is a bounded risk acceptance, **not a claim that Zod 3 is patched**. It
expires on 27 October 2026 and applies only to the four exact lockfile resolutions
and their pinned immediate consumers in `security-audit-exceptions.json`.
`audit:security` fails if the vulnerable range, installed vulnerable version,
resolution path or consumer version changes, or this proof is absent. A newly
introduced vulnerable Zod 4 or nested Zod 3 copy is not covered. Upstream migration
must remove the exception; extending its date requires a fresh review.

The [reviewed advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
lists versions below 4.6.6. The
[upstream fix](https://github.com/colinhacks/zod/commit/a0ebf97)
checks array, set and map upper bounds before walking their elements, in Zod 4.
It does not turn arbitrary unconstrained collections into bounded schemas. No
patched Zod 3 release was available in the npm registry at this review.

## Remediations and compatibility

Mention's own schemas already resolve Zod 4.6.7. Kaana SDK 3.2.1 and contracts
8.0.1 now remove the old nested Zod 4.4.3 resolution. Mention uses the public
DecisionRequest, responses and decisions contracts, not the changed internal
authority union; its service transport and credential behavior are unchanged.
The actual SDK/JEV tests passed 13 cases, inference/classification/trends/translation
passed 81 cases, and backend types, shared builds and lockfile validation passed.

Body-parser now resolves 2.4.0 within Express's existing compatible range. An
explicit compatible override makes that security floor reproduce from the base
lockfile, including its required new transitive dependencies,
addressing [GHSA-27r3-jxmh-p828](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828).
No global Zod major override, vendor patch or authority migration was introduced.
The remaining Oxy runtime consumers have published major upgrades coupled to a
separate first-party authority migration. They cannot safely be replaced by a
forced Zod 4 transitive override.

## Reviewed current call paths

| Remaining consumer | Mention use and compensating boundary |
| --- | --- |
| `@expo/cli` 58.1.15 | Developer/CI Expo tooling; not a backend request or shipped application schema. Its inputs are the repository's build configuration. Re-reviewed for 58.1.15 (from 58.1.13): the same two Zod consumers (`start/server/DevToolsPlugin.schema.js`, `start/server/createMCPDevToolsExtensionSchema.js`), byte-identical, and the same `zod` range. |
| `@oxy.so/core` 6.17.0 | Its direct Zod schema is scalar app-assertion claims, with a 4096-byte token cap. Capability tickets verify the trusted signature before parsing claims. The actor chain comes from the session authority and contains scalars. Service scope options are application-owned, not request-body arrays. |
| `@oxy.so/contracts` 5.8.0 | Actual server collection validators receive configured Oxy-authority responses or application-built inputs. `contentAccessBatcher.sendBatches` and `authorPublicationPolicies` chunk inputs to at most 100 before invoking the SDK. MCP catalogs are built from static tool definitions; actual MCP tool inputs use patched `zod/v4`. External-identity validators consume Oxy responses, not raw federated request bodies. |
| `@oxy.so/protocol` 1.5.0 | Mention's NodeClient pulls bounded record pages. The envelope schema treats `record` as opaque values; the app record is validated using Mention's patched Zod 4 schemas. Mention uses its own `mentionVerificationResolver` calling configured Oxy `identity.resolveDid`; it does not invoke the protocol's exported arbitrary-host DID resolver. |

Source anchors include `packages/backend/src/services/contentAccessBatcher.ts`,
`postPublicationPolicy.ts`, `mtn/MentionNodeSyncService.ts`,
`mtn/mentionVerificationResolver.ts`, `connectors/oxyIdentity.ts`,
`packages/mcp/lib/internal-capability-mcp.ts` and `tool-registry.ts`, plus the
pinned SDK's `server/capabilityTicket.ts`, `server/appAssertion.ts` and
`server/safety.ts`. Oxy session/user invalidation payloads are received from the
trusted Oxy event channels. The unused agency issuance, purchase and messaging
SDK APIs are not assumed safe simply because they share the dependency.

## Residual risk and limits

Configured-authority responses are a trust boundary, not a guarantee that every
response is small. A compromised authority, an unexpected oversized response,
or a newly added caller that sends arbitrary collections can invalidate this
assessment. This review found no current direct caller-controlled oversized
bounded Zod 3 collection path; it is not a proof that every dependency feature
is unreachable or that byte limits alone prevent memory amplification.

A local synthetic call to the dependency's `didDocumentSchema` produced 4096
issues from 20,633 bytes and approximately 5.48 MB of additional heap. That
measurement demonstrates vulnerable library behavior. The arbitrary-host DID
resolver is **not invoked by Mention**, so it is not evidence of a reachable
Mention exploit. An initial investigation inferred reachability from an exported
dependency module; tracing the actual application caller corrected that inference.
No exploit request or synthetic post was sent to production.

Root independently checked the signature-before-parse order, publication
chunking and actual Oxy DID-resolution path before approving this short exception.
The exact-resolution matcher has negative tests for unreviewed versions, paths,
consumers, advisory ranges, missing proof and expiry. Those guards detect graph
changes; future application call-site changes still require normal security
review. The lasting remedy remains upgrading the owning Oxy contracts/SDK and
removing old Zod copies, with the separate tooling dependency tracked honestly.
