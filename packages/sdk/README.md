# Mention SDK

External OAuth clients keep `MentionPublishingClient` with their resource-scoped
connection token. Publishing retains its durable `mcp:` effect key and never
replays an unknown outcome automatically.

Own backends use `mentionForOxyService` from `@oxy.so/mention-sdk/server`, passing
their process `OxyServer` from Oxy core 7.52 or newer and the account they act
for: `actingFor: { accountId }`, plus `requesterAccountId` when the person
operates that account rather than owns it. The calling service's entry in Oxy's
first-party registry must declare Mention in `actsForPeople` (oxy ADR 0066); Oxy
checks that declaration and the accounts live on every request, so nothing is
renewed and the same call works in the background. No session, task or
requester context is sent. The structural factory is tested with core 7.52;
external OAuth clients need no Oxy runtime dependency. The shared transport owns
workload attestation, refresh and origin binding.
Managed receivers must specify their registered `receiverApplicationId`.

The service client provides `identity`, `publish`, `importBatch`, `lookupImports`
and `undoImportBatch`. Publishing preserves the original durable `mcp:` effect
key across retries; it does not replay ambiguous outcomes automatically.
Import IDs, bounded batches, repeated query parameters and response validation
come from `@oxy.so/mention-contracts`; Move must use this contract instead of a
parallel schema. Retain the original batch ID after ambiguous delivery. No
SDK-level mutation retry is added.

SDK 0.3.0 replaces the 0.2 `requester` proofs (`token`, `taskId`,
`requesterContext`) with `actingFor`; it needs a Mention receiver that admits a
declared first-party caller, which Mention runs from the same release. The
earlier release is recorded in [first-party-sdk-release](../../docs/first-party-sdk-release.md).
