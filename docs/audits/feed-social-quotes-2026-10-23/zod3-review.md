# Temporary Zod 3 dependency review — 24 October 2026

This is a bounded risk acceptance, **not a claim that Zod 3 is patched**. It
was originally set to expire on 27 October 2026. Following the 28 October
re-review below, the user approved a seven-day renewal through 4 November 2026.
**As of 25 October, its scope is only the exact
`@expo/cli/zod` 3.25.76 resolution under Expo CLI 58.1.15** in
`security-audit-exceptions.json`. The four-consumer review below records the
original 24 October state; it is retained as historical evidence.
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

## Re-review and approved renewal — 28 October 2026

The user explicitly approved a seven-day renewal on 28 October after this
review, through 4 November 2026. The exception retains the same exact resolution
and owner guard; its scope has not expanded. Its reason and compensation now
describe the actual Expo tooling boundary below. Historical Oxy runtime
consumers are not compensating controls for this remaining copy.

The reviewed source is Mention `521b11e18eab833f2c0740d8c9d2a6064e24690b` with
a fresh frozen install. The lock contains only root Zod 4.6.7 and
`@expo/cli/zod` 3.25.76, owned by CLI 58.1.15. The registry's latest CLI,
[58.1.16](https://registry.npmjs.org/@expo/cli/58.1.16), still declares
`zod: ^3.25.76`; [Zod's registry metadata](https://registry.npmjs.org/zod)
still has no stable Zod 3 after 3.25.76. The advisory still covers `<4.6.6`.
Neither a compatible CLI patch update nor a compatible Zod update removes this
resolution.

Both CLI tarballs (58.1.15 and 58.1.16) were downloaded from the registry and
their SHA-512 integrity verified against registry metadata. Their only two
JavaScript Zod importers match the installed files byte for byte:

| CLI path under `build/src/start/server/` | SHA-256 |
| --- | --- |
| `DevToolsPlugin.schema.js` | `22c5eaac593a317f3319b5941d43aeffd17fcf0ea9ad3720ba0cde6ddd298b94` |
| `createMCPDevToolsExtensionSchema.js` | `3f1f99350323211cf2c63f9e9ee5a6d5d03f17246715a3d945e648f60501417d` |

### Actual inputs and trust boundaries

`DevToolsPluginManager.queryAutolinkedPluginsAsync` scans installed project
dependencies through Expo autolinking, resolves their devtools descriptors, and
constructs `DevToolsPlugin`. That constructor calls `PluginSchema.safeParse`.
The descriptor includes command and parameter arrays. Its source is installed
package configuration, not a Mention feed or API request. The current project's
actual `queryPluginsAsync()` result contains only `expo-sqlite`, whose
`expo-module.config.json` declares a `webpageRoot` and no CLI extensions or
server entry point.

`DevToolsPluginCliExtensionResults.parseOutputText` parses a plugin subprocess's
stdout/stderr as JSON and passes it to `DevToolsPluginOutputSchema.safeParse`.
`MCPDevToolsPluginCLIExtensions.addMcpCapabilities` validates the collected
results with that same schema. These output arrays have **no schema length
limit**. The executor has a 10-second child-process timeout and caps accumulated
text at V8's `MAX_STRING_LENGTH`; neither is a credible bound on synchronous
schema-validation memory. A plugin could also obtain its output from a remote
service, so describing all possible plugin output as trusted local data would
be incorrect. The current project has no installed CLI extension to invoke
this path. Adding one changes this assessment.

`createMCPDevToolsExtensionSchema` builds a strict object from the installed
descriptor: one command enum and optional string, number or boolean parameters.
It does not accept caller-defined array/set/map schemas. The optional Expo MCP
connection requires `EXPO_UNSTABLE_MCP_SERVER`, the `expo-mcp` package and
`@expo/mcp-tunnel`. Neither package is in this lockfile, and the repository's
workflows do not configure that environment variable. This is Expo's development
integration, distinct from Mention's deployed MCP server.

The backend and MCP runtime Docker stages install their filtered production
workspaces and remove the frontend; neither starts Expo CLI. The web release
exports a static application, and native releases embed an application bundle;
CLI plugin validation is development/build tooling, not an application request
handler. This is a source/dependency-boundary assessment, not a new inspection
of deployed container files or a claim that arbitrary developer configurations
are safe.

### Remediation and any renewed acceptance

The latest published CLI does **not** officially support Zod 4: its manifest
requires major 3 and its published schema declarations expose Zod 3 types.
The two JavaScript importers use APIs also available in Zod 4, but that alone
does not establish compatibility for generated schemas, errors, declarations,
or Expo MCP integration. A blanket major override is not a supported update.
Changing imports to `zod/v4` inside the existing nested 3.25.76 package would
also leave the vulnerable installation and does not install patched 4.6.7.

A source migration would require an upstream CLI dependency/types migration
and tests of plugin parsing, generated MCP schemas, CLI execution, exports and
native bundling. A local vendor patch would need equivalent maintenance and
verification and would not become an official supported dependency update.
The existing application's direct schemas already use patched Zod 4.

The approved temporary acceptance states only the current boundary: the exact CLI-only dependency, installed
package descriptors, no installed executable CLI plugins or Expo MCP tunnel,
and no production application caller. It retains the exact dependency and
owner guard, the seven-day expiry, and the residual developer-tooling risk above.
Historical Oxy signature verification and batch limits are not compensating
controls for this remaining CLI copy. This accepts the reviewed tooling risk
temporarily; it does not patch Zod 3. `audit:security` will block again after
4 November unless the dependency is remediated or another review is approved.

## Current scope — 25 October

A separate, subsequently merged [SDK adoption change (#1620)](https://github.com/OxyHQ/Mention/pull/1620)
moved Mention to core 7.2.0, contracts 6.0.0 and protocol 1.5.1. The lockfile at
`7332b08ecf953bc88a145a7b72bc1935f25451e8` contains only root Zod 4.6.7 and
`@expo/cli/zod` 3.25.76. The exact-resolution guard was narrowed accordingly;
there are no remaining Oxy runtime Zod 3 resolutions in that graph. Expo CLI
58.1.15's two reviewed Zod consumers (`start/server/DevToolsPlugin.schema.js`
and `start/server/createMCPDevToolsExtensionSchema.js`) and their dependency
range were recorded as byte-identical to 58.1.13 in the preceding tooling update.
The expiry has not been extended. This corrects the current scope; it does not
retroactively describe PR #1601 as having performed that later SDK migration.

## Original remediations and compatibility — 24 October

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

## Original reviewed call paths — 24 October

| Consumer in the original review | Mention use and compensating boundary |
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

## Original residual runtime risk and limits

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
review. The Oxy runtime remedy subsequently landed in PR #1620 as recorded above.
The remaining Expo tooling resolution is still unpatched and separately guarded
until its expiry; the original runtime-risk discussion is historical.
