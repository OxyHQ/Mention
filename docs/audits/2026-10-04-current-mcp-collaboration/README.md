# Current collaboration guidance and retained contracts

The MCP client instructions and README still described automatic acceptance as a
legacy bundle transition, although Mention-issued bundles are retired. Current
`resolveMcpAutoAcceptIds` accepts only invited accounts in the live central
connection's Oxy-approved membership. `createPost` and `updatePost` call that
helper; outside accounts remain pending. The change corrects those two
sentences. It changes no authentication, collaboration handler, token handling,
permissions, persistence or compatibility receiver.

Three existing membership controls pass (member, foreign account, non-MCP /
missing account set) through the package test command and the retained explicit
unit-only config. No database/app is loaded in that run. It is not a claim of
canonical full backend or CI acceptance. The initial root-script invocation,
canonical backend missing-PG setup and incorrect temporary-config path failures
are preserved separately; none is a product regression. No new product tests
were added for this wording correction.

## Bounded remaining inventory for Oxy1571

This updates the existing census at Alia `b2bc57f45` and Mention `0646d7293`.
It does not create requirements under Oxy873–880 or rescan unrelated products.

| Boundary | Current disposition |
| --- | --- |
| Alia authorization create/revoke, catalog and ticket HTTP wrappers | Already removed by Alia664/665; canonical `OxyServer.agency` methods now serve them. |
| Alia service identity | `coordinatorIdentity` in `oxy-capability-authority.ts` calls `/capabilities/service-identity`; execution authorization creation uses that exact application/credential attribution. No equivalent published agency method was found. Active, not safe to delete. |
| Alia agent capability map | `automation-coordination.ts` calls `getOxyAgentCapabilityMap` in `tools/oxy-services.ts`. It supplies assignment/resource/limit checks; no equivalent published agency method was found. Active. |
| Generic app catalog HTTP invocation | `tools/oxy-services.ts` invokes registered non-pilot app handlers. Mention alone opts into exact-bound internal MCP, with no fallback after denial. Other app contracts are not equivalent to the Mention pilot. |
| Mention `/_oxy/capabilities/:tool` | Still advertised by the signed registry in `packages/mcp/lib/tool-registry.ts`. Deletion requires a replacement registered catalog and migration of its consumers, preserving authority/effect receipts. Existing receiver and MCP parity controls are historical evidence, not proof all consumers migrated. |
| Mention central account membership | Live introspection plus `resolveMcpAutoAcceptIds`, `createPost` and `updatePost`; retained. The obsolete legacy wording is corrected here. Legacy-token recognition remains a rejection/reconnect guard, not acceptance. |
| SSE, old supported native payloads, feed converters and device cleanup | Existing `docs/COMPATIBILITY_RETIREMENT.md` records client/persistence retirement evidence. No new telemetry or backfill completion is supplied by this audit; do not remove them as dead code. |

Remaining functional acceptance already tracked by Oxy1571: real Alia Auto
response/receipt after bounded high pilot repair; Console-issued Alia machine
keys (Oxy1577/Alia666 release/adoption/runtime); Jev private commissioning,
Mention's own scoped relationship and explicit approval in Oxy1572. Mention1314
has merged and its factory remains inert. These are distinct from this wording
fix. No new grants, private prompts, provider requests or production mutations
were made. The issue's existing wider Mercaria/Peable and deployment tasks remain
with their owners; this audit does not reopen completed I01–I11 evidence.
