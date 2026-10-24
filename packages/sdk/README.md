# Mention SDK

External OAuth clients keep `MentionPublishingClient` with their resource-scoped
connection token. Publishing retains its durable `mcp:` effect key and never
replays an unknown outcome automatically.

Own backends use `mentionForOxyService` from `@oxy.so/mention-sdk/server`, passing
their process `OxyServer` from Oxy core 7 and the original requester proof.
The structural factory is tested with core 7; external OAuth clients need no
Oxy runtime dependency. The shared transport
owns workload attestation, refresh and origin binding. Use a verified session
`{accountId, token}` for a present person or `{accountId, taskId}` for that
coordinator's original durable task. A verified downstream hop uses
`{accountId, requesterContext}`; never copy another coordinator's task ID. An
attributed account ID alone is not proof.
Managed receivers must specify their registered `receiverApplicationId`.

The service client provides `identity`, `publish`, `importBatch`, `lookupImports`
and `undoImportBatch`. Publishing preserves the original durable `mcp:` effect
key across retries; it does not replay ambiguous outcomes automatically.
Import IDs, bounded batches, repeated query parameters and response validation
come from `@oxy.so/mention-contracts`; Move must use this contract instead of a
parallel schema. Retain the original batch ID after ambiguous delivery. No
SDK-level mutation retry is added.

SDK/contracts 0.2.0 is an additive release independent of the backend. Own
imports and publishing need the matching Mention receiver deployment before
Move/Schedio enable these methods. The SDK release itself does not enable those
routes or convert external connections into own authority. See the
[release record](../../docs/first-party-sdk-release.md).
