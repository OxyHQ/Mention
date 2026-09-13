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


## Run through the protected production workflow

After Oxy's authoritative resolver and Mention's package update are deployed,
use **Reconcile source identity projections** (`run-source-identity-reconciliation.yml`).
A repository admin sets `SOURCE_IDENTITY_RECONCILIATION_OPERATORS` to the allowed
GitHub logins. Dispatch only from protected `main`; reruns by another actor are
refused. The workflow uses the deployed backend task definition, including its
roles, secrets and VPC configuration, without registering a replacement or
updating the service. No input accepts code, commands, image repositories or refs.

1. Verify the backend deployment has reached the exact current `main` commit.
   Record its immutable `sha256:…` digest from the ECS task definition. The
   workflow checks the `deployed/backend` source marker, ECR commit tag digest,
   healthy ECS deployment and live digest all agree before starting a task.
2. Dispatch with `dry_run=true` (the default) and `expected_image_digest` set to
   that digest. Download and read the `source-identity-reconciliation` artifact
   and the Actions summary. It contains source SHA, image digest, mode, exit code
   and the script's count/refusal report. Dry-run is lookup-only: unresolved Oxy
   identities and post clustering are not predictions of the subsequent apply.
3. For apply, dispatch again at the same source/image with `dry_run=false`, the
   successful preview's `preview_run_id`, and
   `confirm_write=reconcileMetaIdentityAndCrossposts`. The workflow validates the
   earlier workflow run and artifact against the exact source and image before
   giving the script its existing `CONFIRM_ADMIN_MUTATION` confirmation. If main
   or the image changed, obtain a fresh preview after the new backend deploy.
4. Read every refusal and authorship conflict in the apply report. Exit zero
   means the scan finished, not that every source was resolved. Preserve the
   artifact (retained for 30 days), address refusals, then preview/apply again.

The ECS command is fixed and has a 55-minute timeout with a 30-second termination
grace. The workflow waits at most 60 minutes for completion. A timeout, nonzero
exit, missing/invalid JSON tally or incomplete log retrieval fails the workflow;
inspect the task ARN in ECS before retrying, since earlier writes remain committed.
The workflow cannot stop ECS tasks with the deploy role. Reports contain counts and inspected public selectors; inherited secret references, task definitions and raw source logs are
never uploaded. This workflow does not migrate Oxy's identity evidence or create
Mention-owned identity claims.

## Prove a candidate is absent before public discovery

The same workflow has a fixed `operation=inspect_cache` mode. Keep `dry_run=true`
and supply the exact public `actor_uri`, lowercase `canonical_acct`, and lowercase
`transport_acct`, along with the reviewed deployed image digest. This invokes
only the compiled form of `inspectFederatedIdentityCache.ts`; it makes no Oxy
requests, resolves no actors and writes no application rows. A read-only repeatable-read transaction
counts exact matches with a 15-second statement timeout.

Save its artifact before opening the candidate's profile. The report identifies
`operation=inspect_cache`, the queried public selectors, observation timestamp,
source SHA and image digest, plus four counts: actor URI matches, canonical acct
matches across `acct`/`network_acct`, transport acct matches across those columns,
and posts whose `federation_actor_uri` matches the source. All four must be zero
for absence evidence. Tombstoned actors, private posts and other retained source
history count too; a cached acct under another actor URI prevents a false claim
of absence. No profile or post content is included.

Run the same inspection after public discovery and compare the identical
selectors. A nonzero result then records Mention's materialized cache state.
This is separate from Oxy's own pre/post inspection: proving absence in only one
service does not establish a cold discovery across both. An inspection artifact
cannot authorize reconciliation apply; apply requires `operation=reconcile`
in the earlier successful preview report.

### Recover a failed workflow report

The workflow retains `reconciliation-run.json` as soon as ECS returns the task
selector, and `reconciliation-diagnostics.json` when the task stops. Diagnostics
contain the exit code and allowlisted failure categories, HTTP statuses and schema
issue paths; they never contain arbitrary log messages or task environment values.
A missing completion tally still fails the run and cannot authorize an apply.

For an older failed run without an artifact, dispatch the same workflow with
`operation=recover_report`, `dry_run=true`, its `recovery_run_id`, and the reviewed
`expected_image_digest`. The dispatcher must match the original operator. Recovery
verifies the prior main workflow, its unique launcher task selector, the stopped
ECS task and its immutable image against the prior source tag. It only reads ECS,
ECR and CloudWatch; it never starts or changes a task. Expired ECS task metadata
or unavailable logs cause recovery to fail rather than guess at another task.
Recovery evidence is diagnostic and cannot be used as a reconciliation preview.
