# Mention SDK

External OAuth clients keep `MentionPublishingClient` with their resource-scoped
connection token. Publishing retains its durable `mcp:` effect key and never
replays an unknown outcome automatically.

Own backends use `mentionForOxyService` from `@oxy.so/mention-sdk/server`, passing
their process `OxyServer` and the original requester proof. The shared transport
owns workload attestation, refresh and origin binding. Use a verified session
`{accountId, token}` for a present person or `{accountId, taskId}` for that
coordinator's original durable task. An attributed account ID alone is not proof.
Managed receivers must specify their registered `receiverApplicationId`.

The service client provides `importBatch`, `lookupImports` and `undoImportBatch`.
Import IDs, bounded batches, repeated query parameters and response validation
come from `@oxy.so/mention-contracts`; Move must use this contract instead of a
parallel schema. Retain the original batch ID after ambiguous delivery. No
SDK-level mutation retry is added.

This is source preparation. Publication, compatible shared core pins, receiver
cutover and Move adoption are coordinated separately; a source commit does not
prove that an endpoint has been deployed. Own scheduled publishing migration is
still pending; do not use an external OAuth connection as an own service token.
