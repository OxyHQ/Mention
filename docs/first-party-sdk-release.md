# Mention SDK/contracts 0.2 release

This additive package release exposes Mention's import contract and the own
service factory on `@oxy.so/mention-sdk/server`. The root SDK remains the external
MCP OAuth publishing client. Its bounded connection token, effect-key rules and
unknown-outcome behavior are unchanged. No Oxy runtime enters the root barrel.

The structural server factory requires Oxy core 7; it imports no Oxy runtime.
Tests use
published core 7.0.0/contracts 6.0.0, including a real HTTP workload mint and the
shared receiver middleware: protocol 2, original task/account isolation,
wrong-account refusal and live revocation. Mutation retries retain the original
batch/effect key and remain the caller's explicit decision.

The runtime singleton guard and the current main branch's catalog/override pins
remain intact. The independent `tests/sdk-transport` consumer harness has its own
package and frozen lock, validating the factory against its minimum published
core 7.0.0 dependency. CI checks types and HTTP behavior against the SDK's built
server entry, the same entry packed for publication. No implementation is copied
and no package alias or local dependency path is used. Main now uses core 7.2;
the separate harness continues to verify the SDK's advertised minimum.
This branch changes no backend producer, receiver, task or database code.

Release packages through Actions after CI on this commit. Then pin SDK/contracts
0.2.0 in Move and Schedio, deploy Mention's matching runtime receiver, and only
then enable own caller traffic. The runtime branch also needs Oxy core 7.1 for
replayable file streaming and its published product SDK dependencies. This
package publication alone does not complete the Mention runtime migration or
retire Oxy's finite legacy workload transition.

Validation: eight SDK unit tests retain external publishing and own batch/effect
semantics; the independent HTTP consumer test checks the built artifact against
published core 7. SDK source/test and consumer-harness types, contracts/SDK
builds, OpenAPI drift, root lockfile singleton guard and Biome pass. Backend and MCP TypeScript passed on the original base; the rebased
release now retains main’s core 7.2 dependency resolution. Both 0.2.0 tarballs were inspected: the SDK pins contracts 0.2.0
exactly, contracts use patched Zod 4.6.7, and neither contains local dependency
paths or an Oxy runtime import in the SDK root. CI/release remain pending.
