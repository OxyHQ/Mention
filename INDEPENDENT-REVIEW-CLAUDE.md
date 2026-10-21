# Review of Mention #1301: Jev shadow evaluation ledger

Head `e20858f5` against the PR #1300 foundation `a97ed9fe`. I read the diff and the code around it without editing or running anything, and I did not re-run the reported 638 suites / 7,586 tests.

**Verdict: no blocking defects while the gate stays closed. Not ready to open the gate.** The two release dependencies still apply: PR #1300, and the published Oxy SDK (oxy #1503).

## What checks out

- **Gate stays closed.**
  - `isJevShadowReleased()` only passes when `JEV_SHADOW_BLOCKERS` is empty, and there is no environment bypass.
  - Production builds the worker with no evaluator at `PostClassificationService.ts:473`.
  - No package or lockfile changes, and no provider, transport or Kaana code.
  - Nothing outside the ledger, the worker, the deletion manifests and the tests reads `post_evaluations`, so feed, discard and security behaviour are unchanged.
- **Migrations.**
  - 0058–0060 and their snapshots are byte-identical to the foundation.
  - The 0061 snapshot's `prevId` matches 0060's `id`. It adds exactly the two new tables and changes no others.
- **Deduplication.**
  - The unique key is `(post, fingerprint, model, policyRef, policyVersion, evaluationVersion)`.
  - The claim insert commits before inference, and its ID is the idempotency key.
  - A `cost_uncertain` or abandoned `claimed` row blocks any new claim. The worker test proves an error never produces a second request ID.
- **Final write re-checks eligibility.** Completion takes the content lock, then the post row lock, and requires the post to still be public, published and not a boost, with an identical fingerprint. The write is conditional on `state='claimed'`.
  - Deletion: rows cascade and a late result can't come back.
  - Edits and identical-text replacements cancel the old result.
  - Private and draft posts cancel.
  - `restricted` and `incomplete` posts also fail the published check.
- **Follow evidence.**
  - It looks only at accepted outbound edges for the post's own actor URI or DID. The atproto mapper stores the DID in both places.
  - It is read just before the final write, inside a savepoint, and a failed lookup becomes `unknown`.
  - Reply, mention, quote and ancestor actors are never consulted. The index `federated_follows_remote_direction_idx` covers the lookup.
- **Signals and abstention.**
  - Topics, language, spam, repetition and feed value are separate columns. Overlapping topics are allowed.
  - The schema is strict: values must be finite, topics can't repeat, and there is no `confidence` field.
  - Media-only, unknown-language and unsupported-language posts abstain with null scores.
- **Deletion manifests.**
  - Covered by `PostDeletionCascade` (`'database'`), the admin preflight probe, `CASCADED_POST_REFERENCES`, and the channel cascade (including topic rows).
  - Account erasure hard-deletes posts (`erasePosts.ts:153,294`), so evaluations cascade with them.

## Findings (most severe first)

1. **A hanging evaluator stalls canonical classification.** `PostClassificationService.ts:282,401-417`
   - The shadow pass runs in series, before Stage B, with no timeout and no abort signal.
   - One `evaluate()` call that never resolves leaves `isClassifying` set to true. Every later 5-minute cycle then returns at once, so canonical classification stops for all posts.
   - Even without a hang, up to 25 slow calls delay Stage B every cycle.
   - This contradicts the stated rule (`docs/jev-shadow-evaluation.md` L46, and the code comment) that shadow work must not prevent canonical enrichment.
   - It is dormant while the gate is closed, but it must be fixed before any binding: add a per-call deadline that marks the row `cost_uncertain`, and/or run the shadow pass after Stage B.

2. **Unlisted fediverse posts are treated as public.** `postEvaluationRepository.ts:22` with `connectors/activitypub/helpers.ts:338-343,826-828`
   - `mapApVisibility` maps any post with `as:Public` in `to` **or** `cc` to `PUBLIC`. A Mastodon "unlisted" post (`cc: Public`), where the author opted out of discovery, therefore passes the claim filter.
   - The claim also ignores actors with `federated_actors.discoverable = false` or `suspended`.
   - This is a privacy/eligibility input for the independent review. The repository filter is not a sufficient "public-only" boundary on its own.

3. **Rewrites that don't change the text throw away paid results.** `jevShadow.ts:51` together with `postRepository.ts:1615` (`replacePostContent` deletes and re-inserts every rendition)
   - Paths that pass the existing renditions through unchanged still change the fingerprint, because rendition IDs are part of it. Examples:
     - `mediaMetadataEnrichJob.ts:40`
     - the outbox re-render at `outbox.service.ts:1242`
     - the federated repair scripts
     - a user viewing a translation, where `storeMachineVariant` appends or replaces a machine rendition
   - If one of these lands while inference is in flight, the paid result is marked `cancelled`.
   - These paths don't reset the classification queue, so that text is never evaluated for the release, and the spend isn't flagged as cost.
   - Machine translations are part of the fingerprint even though they are never part of the inference input.

4. **Brief visibility toggles and edit ordering cause permanent gaps and wasted claims.**
   - A post that goes public → private → public while inference is in flight leaves a `cancelled` row with the *same* fingerprint. `onConflictDoNothing` then blocks that revision for good (`postEvaluationRepository.ts:45-51`).
   - Edits write languages and content in separate statements, in a different order on each path:
     - federated edits: classification first, then `replacePostContent` (`inbox.service.ts:1046` then `:1081`)
     - local edits: content first, then the classification patch (`updatePost.ts:516` then `:577`)
   - A claim made in between fingerprints a hybrid state and pays for it. The result is then cancelled, or an abstention is recorded against stale languages.
   - Each case is low frequency.

5. **The completion path holds a row lock the codebase deliberately avoids.** `postEvaluationRepository.ts:24,32`
   - Claim and completion take `FOR UPDATE` on the `posts` row, and completion holds it through the follow lookup and the topic inserts.
   - `lockPostContent` (`postRepository.ts:1702-1711`) exists specifically so engagement counter bumps don't queue behind a row lock.
   - The lock order is consistent with the content writers, so I see no deadlock risk. But `FOR KEY SHARE`/`FOR SHARE` on the row (or no row lock plus a re-read) would be enough. `FOR SHARE` on the renditions duplicates the advisory lock.

6. **SDK result validation is still missing (readiness gap).** `shadowSignalsSchema` (`jevShadow.ts:923-932`) does not check:
   - returned `languages` against the claimed or supported languages
   - topic slugs against the topic catalogue
   - the model or policy receipt against the release

   The docs already list this as a gate. It needs to be implemented against the published SDK types, not this projection.

7. **Results-to-cost reconciliation is weak.**
   - Nothing logs or records when `completePostEvaluation` returns `false` after a successful `evaluate()` (`PostClassificationService.ts:417`).
   - Nothing records why a row was cancelled (edit, visibility change or deletion).
   - Reconciling `cancelled` rows against spend later will require the Oxy receipt.

## Test gaps

- No test for a hanging or slow evaluator, or that Stage B still runs and `isClassifying` is released.
- No test of the follow-lookup failure path (savepoint → `unknown`), or of a local post with a null actor (`unknown`).
- No test that boosts are refused at claim, that `followers_only`/`restricted` posts are refused or cancelled, or for an actual boost, quote or reply whose *parent* actor is followed (the "contextual" case only uses an unrelated DID).
- No test for a machine-translation append, or a media-enrich pass-through rewrite, during inference (finding 3).
- No test for the public → private → public toggle leaving a permanent `cancelled` block (finding 4).
- No test for unlisted, non-discoverable or suspended remote actors (finding 2).
- No test that a schema-invalid evaluator result becomes `cost_uncertain` without using a legacy attempt (only the thrown-timeout case is covered).
- The worker test opens the gate with `vi.spyOn` on the ESM namespace. That makes it depend on vitest's module transform, so it is not a proof of the production gate path. The closed-gate test does cover production.

**Readiness:** safe to merge as a closed, inert ledger once #1300 lands, after rebasing onto main as the docs require. Opening the gate needs findings 1 and 2 resolved and finding 3 decided, plus the published SDK and the eligibility/privacy/ZDR reviews already listed in `JEV_SHADOW_BLOCKERS`.
