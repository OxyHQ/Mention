# Repairing cached source identities

Oxy owns public profiles, biographies, source-network identity and verified person
links. Mention stores source actor URIs/DIDs and projects the current Oxy user id
onto imported posts. A bridge hostname is transport provenance, not a second
identity authority. Matching handles and manually entered Mention attestations do
not establish person equivalence.

Deploy the Oxy identity registry, its migrations and its historical source repair
before deploying Mention's identity resolver. Verify the Oxy
`/federation/identities/lookup` and `/resolve` responses include source actor
references and `redirectedUserIds`. Oxy-only users are repaired by Oxy's own
historical repair, even when Mention has never cached their actor.

The Mention repair scans **every cached AP actor and native AT Protocol DID**,
then every imported post, including collapsed posts. It uses keyset pagination.
It does not filter to Instagram, recently active authors or unclustered posts.

Run the read-only preview first:

```bash
DRY_RUN=true bun packages/backend/src/scripts/reconcileMetaIdentityAndCrossposts.ts
```

Preview calls Oxy **lookup only**. It never calls resolve, creates a remote user,
changes a Mention row or detects a new cluster. `actorsChanged` and `postsChanged`
are proposed changes; missing cached Oxy authority is counted as
`oxy_identity_not_resolved`. `postsExamined` reports coverage of the separate
cross-post pass; cluster creation is intentionally not simulated.

Apply the reviewed scan:

```bash
DRY_RUN=false CONFIRM_ADMIN_MUTATION=reconcileMetaIdentityAndCrossposts bun packages/backend/src/scripts/reconcileMetaIdentityAndCrossposts.ts
```

Apply refetches each source through Oxy's verified resolver. Each actor projection
runs in one transaction: only posts whose `federation_actor_uri` exactly matches
that source are changed, along with their owner authorships. It never transfers
all content from one Oxy id to another. A source with conflicting coauthorship is
reported under `authorshipConflicts` and those post rows are left unchanged for
inspection. Missing actor rows are refused. Post ids, source URLs, engagement,
content and post moderation remain attached to the same objects.

Affected clusters are dissolved in that transaction so a withdrawn identity
proof cannot leave a variant hidden. The later post pass may recreate a cluster
only through the current Oxy identity gate and current content evidence.
Failed lookups and weak-content decisions are counted in `refused`; an incomplete
scan must not be interpreted as proof that all sources converged. Save the JSON
report alongside the deploy record, inspect every refusal, and rerun after its
cause is corrected. A second successful run reports zero actor/post changes.

Legacy Mention mutes name only an Oxy user id, so their original source cannot be
reconstructed after a historical person merge. Repair retains original mute rows
and copies their protection to the new projection id, without duplicates. This
can conservatively over-mute after a person link is revoked. The normal mute and
unmute endpoints use Oxy's current group ids; an explicit unmute removes every
copy in that active group. A now-separate account can be unmuted independently.
Repair does not delete old mute rows by guessing which person the viewer meant.

The live AP/AT resolver uses the same projection operation. User-summary cache
entries for old and new ids are invalidated, and anonymous feed cache pages are
cleared. Bulk hydration accepts Oxy `redirectedUserIds`, so old source references
resolve without per-author fallback requests. Cached source posts remain
independently addressable throughout.

## Reversal and retirement

Correct or revoke the source proof in **Oxy**, then rerun preview and apply.
The same immutable-source selection restores the source's current authoritative
id and reveals former cluster members. This is the rollback procedure; do not
run an inverse global `old_user_id -> new_user_id` update because both ids may
have authored unrelated content.

`recordAttestedIdentityLink` is retired. Its default CLI invocation reads only
historical audit counts; mutating invocation fails. Its callable entry point
returns `oxy_identity_authority_required` for both registration and removal.
Historical identity claim/link tables remain for audit. No deploy in this change
drops those tables or treats their old rows as current authority.
