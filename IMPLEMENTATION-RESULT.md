# Mention Jev shadow evaluation — implementation result

Assigned branch: `feat/jev-evaluation-20261001`.
Assigned worktree: `/home/nate/Oxy/Mention/.worktrees/jev-evaluation-20261001`.
Operational coordination log; intentionally uncommitted.

## Scope and current state

Implemented dormant shadow fanout in the existing PostClassificationService,
separate evaluation/topic tables, durable unique claims, full rendition identity
fingerprints, transactional public/published/content checks, deletion cascades,
independent signal storage and conservative abstentions. Accepted outbound
original actor URI/DID follows are observed at final write; unknown evidence is
never a rejection. No admission, import-discard, feed ranking, thread, or security
policy change. Legacy worker cadence, batch sizes and retries are unchanged.

Production SDK projection is deliberately UNBOUND and hard gates remain CLOSED.
No provider call, credential access/change, deployment, merge, or public Jev
service enablement. Oxy is the control-plane authority; canonical signed Kaana
origin remains https://kaana.ai.

## Mandatory foundation reconciliation

- PR https://github.com/OxyHQ/Mention/pull/1300 is OPEN, branch
  `ccr-968b68e8-rniv9s`, exact head `a97ed9fef846c370fdfe132e6570b8e4266b96ea`.
- Inspected federation, hydration/enrichment, schema and migration changes.
  Its original pull_request CI was observed SUCCESS, including build/lint/types, all three backend
  shards, frontend/shared-types/MCP, browser gate, CodeQL and CI complete.
  Reference run: https://github.com/OxyHQ/Mention/actions/runs/36803055769.
- Preserved 15 own files with SHA-256 manifest and binary tracked patch at
  `/tmp/mention-jev-evaluation-20261001/foundation-1300-backup`.
  No git stash. Original pre-foundation head was
  `285f4719f9beead269fce847a24c7a89c885dc87`.
- Fetched the foundation (first fetch connection reset; retry succeeded).
  Rebased this isolated branch only. Initial rebase replayed unrelated main
  commits; a second explicit `--onto` rebase made the base exactly PR1300,
  so the stacked PR contains only the pilot patch. Other branches/worktrees
  were not modified; main's original commits remain on main.
- Verified backups before removing ONLY our uncommitted wrong
  `0058_post_shadow_evaluations.sql` and our `0058_snapshot.json`.
- Regenerated `0061_post_shadow_evaluations.sql`, snapshot and journal against
  the exact foundation. Byte-verified all foundation migrations/snapshots
  0058–0060 unchanged. Snapshot adds exactly the two shadow tables; journal
  preserves all prior entries and adds exactly 0061. No production migration.
- Frozen dependency install matches the foundation lockfile. No manifest,
  dependency override or lockfile changes.

## Validation

Pre-foundation:
- Scoped PostgreSQL schema/ledger/deletion/policy: 7 suites, 165 tests passed.
- Worker/baseline/ingest regressions: 6 suites, 113 tests passed.
- Backend typecheck and shared-types/backend builds passed.
- Inference, architecture, feed-hot-path, logger, ID-shape and no-Mongo guards
  and their mutation suites passed.
- Negative control: temporarily omitted rendition ID from fingerprint; the
  identical-text replacement test failed as intended (1 failed / 6 passed).
  Source restored automatically before continuing.

On exact PR1300 foundation:
- First full backend run: 636 suites passed, 2 failed (7,584 tests passed / 2 failed).
  The schema inventory and purge guard correctly detected missing declarations
  for the new cascading references. Added the actual database dispositions to
  channel/purge manifests; no guard or test was weakened. Original output:
  `/tmp/mention-jev-evaluation-20261001/backend-foundation-tests.log`.
- Final standard backend run: **638 suites / 7,586 tests passed**, 75.44 seconds.
  `/tmp/mention-jev-evaluation-20261001/backend-foundation-tests-final.log`.
- Root build (shared-types + backend + MCP), shared-types tests, final backend
  typecheck, and git diff --check passed.
- Inference, architecture, feed-hot-path, logger, ID-shape and no-Mongo guards
  plus their mutation suites passed against the foundation.

Database tests use ONLY the session-owned PostgreSQL 17 cluster at
`/tmp/mention-jev-evaluation-20261001/postgres`, with TCP disabled and a Unix
socket inside that private directory. Standard harness creates/removes its own
synthetic throwaway databases. No existing database or other session was used.

## Blocking dependencies / review conditions

- Mention PR1300 must merge independently; then rebase pilot onto main, never
  merge the foundation topic branch into the pilot.
- Oxy https://github.com/OxyHQ/oxy/pull/1503 is OPEN/DRAFT, observed head
  `7c012cde6e38b516254f62e93e17811566092bc1` (rechecked after review), pending review and publication.
  Current published/installed core 4.0.0 lacks `decide()`. No copied contracts,
  private provider transport, SDK shims, overrides or live binding were added.
  Final source handoff may change during review. Consume the final published SDK
  through the normal package/lockfile bump before typed question/receipt wiring.
- Exact reviewed immutable model/policy/evaluation identity; independent topics
  must be Nouls, never an exclusive Choice. Preserve separate language, spam,
  repetition and feed-value signals; verify result identities and policy receipt.
- Internal eligibility, privacy and ZDR need affirmative review. TypeSafe
  standalone-resale and OpenRouter resale/competitor restrictions block ordinary
  credentials. No public Jev enablement. Hard application release blockers stay.
- Independent coordinator review required before merge or deployment.

Commit: `e20858f5670b3eae8bac788a971fb6b9eac37774`
(`feat(classification): add gated Jev shadow evaluation ledger`).
Published branch: `origin/feat/jev-evaluation-20261001`.
Stacked draft PR: https://github.com/OxyHQ/Mention/pull/1301 — OPEN/DRAFT,
base `ccr-968b68e8-rniv9s`, verified exact head matches the commit above.
This initial publication had one pilot commit above foundation PR1300; review revision recorded below.

Pilot CI: standard workflow manually dispatched for this exact head because
`pull_request` CI only automatically runs for main-targeted PRs.
https://github.com/OxyHQ/Mention/actions/runs/36816557685
Completed: FAILURE. Event: workflow_dispatch. Detailed same-event comparison below.
Deployment jobs require a successful main push, so this validation-only run
cannot deploy the pilot. Socket Security Project Report and Pull Request Alerts
are already SUCCESS. Coordinator must check completed exact-head CI and keep the
PR draft until dependencies and independent review are satisfied.

The session-owned PostgreSQL process was stopped after initial validation and restarted only for the bounded review tests;
cluster files, backups and both test logs remain in the task-specific /tmp path.
No other PostgreSQL process, existing checkout, branch, or session was modified.
Automatic review approved dependency installation, own test socket/process,
scoped git metadata/commit, branch publication, draft PR and validation dispatch.
No automatic-review rejection occurred. Operational files remain uncommitted: pre-existing IMPLEMENTATION-PROMPT.txt, this IMPLEMENTATION-RESULT.md, and the independently authored INDEPENDENT-REVIEW-CLAUDE.md (read only).


## Exact-head CI investigation and foundation control (2026-10-01)

Read full logs and every job/step, not just Socket checks:
- Pilot `e20858f5670b3eae8bac788a971fb6b9eac37774`: **FAILURE**, manual
  https://github.com/OxyHQ/Mention/actions/runs/36816557685.
- Unmodified foundation `a97ed9fef846c370fdfe132e6570b8e4266b96ea`: **FAILURE**, manual
  https://github.com/OxyHQ/Mention/actions/runs/36817842817.
  Dispatched only the existing workflow against the existing remote ref; did not
  change its branch, PR, checkout or session. Same workflow_dispatch event, exact
  workflow and dependency lock, Ubuntu runner family, Node 24.21.0/Bun 1.3.14.
  Other foundation runs/re-runs were not cancelled or modified.

| Named check/step | Pilot e20858f56 | Exact foundation a97ed9f |
| --- | --- | --- |
| Test backend (1/3), (2/3), (3/3) | All SUCCESS | All SUCCESS |
| Merge backend shard coverage floors; assert suite collection | SUCCESS | SUCCESS |
| Test shared-types | SUCCESS | SUCCESS |
| Lockfile resolves cleanly from the base | Job SUCCESS, comparison step SKIPPED | Same |
| Build, lint and typecheck / Verify Oxy dependency health | FAILURE: doctor 1.0.0 missing manifest 1.1.0 | Identical failure |
| Test mcp / stateless sessions | FAILURE: request IDs expected 3 events, got 2 at line 286 | Same failure, plus retry expected 2, got 1 |
| Test frontend / actual suite and row-cost harness | SUCCESS | SUCCESS |
| Test frontend / coverage policy | FAILURE: 10 baseline decreases, empty CI_BASE_REVISION | Same 10 decreases |
| Browser gate / media-layout.spec.ts:149 assertion 347 | FAILURE: image layout test, initial + retry | Same failure |
| Frontend bundle baseline | SUCCESS | SUCCESS |
| CI complete / require every job passed | FAILURE | FAILURE |

The browser output represents ONE failed image-layout case run twice, not two
independent failed tests (39 passed, 1 skipped). The build job's later build/lint/
schema steps did not run after doctor failed. A successful lockfile job with its
comparison skipped is not evidence that the base comparison passed.

Workflow inspection: `.github/workflows/ci.yml` declares `workflow_dispatch:`
with NO inputs. `CI_BASE_REVISION` handles merge_group, base_ref and push.before,
leaving it empty on manual dispatch. The frontend script then compares against
current origin/main, newer than this foundation (e.g. total statements 43.03 ->
42.76). There is no declared baseline input to supply. No invented input, workflow
change, guard skip, frontend refactor or unrelated dependency fix was applied.
The same-event foundation control reproduces all four failure classes, so these
failures are inherited in this environment; they still block an overall green CI.

Full outputs:
- `/tmp/mention-jev-evaluation-20261001/ci-e20858f56-full.log`
- `/tmp/mention-jev-evaluation-20261001/ci-foundation-a97ed9f-full.log`

## Independent review disposition and bounded revision

Final read-only review is `INDEPENDENT-REVIEW-CLAUDE.md`, authored independently
against e20858f56. Verdict: no blocking defects while gate closed; NOT ready to
enable. Review artifact/log/session not edited or staged.

- Finding 1 FIXED: canonical and shadow fanout start independently. A single
  existing-inference-timeout batch deadline aborts/settles a hung evaluator;
  late results cannot write, and the same durable claim becomes cost_uncertain.
  Wait for both branches before releasing the cycle guard even if one rejects.
- Finding 2 BLOCKED FOR RELEASE: durable listed/public source provenance and
  actor discoverability/suspension are not presently distinguishable by the
  public column alone. Added hard `federated_public_visibility_provenance` gate.
  No provider binding exists, so no unlisted or private post can be sent.
- Findings 3/4 BLOCKED FOR RELEASE: preserve conservative exact rendition ID/CAS
  checks, including machine additions and same-text replacement; never authorize
  new paid IDs after privacy toggles. Added hard
  `semantic_revision_and_receipt_reconciliation` gate for no-op rewrites, split
  language/content edits, recovery and cost receipts. These gaps remain explicit,
  not silently described as solved or free cancellations.
- Finding 5 RETAINED WITH RATIONALE: key-share permits non-key visibility changes;
  unlocked re-read reopens the race. Existing short row-lock transactions contain
  no inference. Changing this needs coordinated transactional edit semantics.
- Finding 6 remains SDK publication dependency: no consumer wire contract/shim or
  guessed receipt/model/policy/topic validation. Re-read current authoritative
  DECISIONS-HANDOFF.md: contracts 4.7.0 / set 3.5.0 candidate UNPUBLISHED; API hard
  gate closed; no npm release. Oxy1503 remains OPEN, mergedAt=null at head above.
- Finding 7 PARTIAL: log superseded successful result's existing evaluation ID;
  cancellation reason/receipt reconciliation remains a hard release blocker.

Synthetic coverage adds actual follow-savepoint query failure, unknown local
follow evidence, boosts/followers-only/restricted denial, privacy-toggle dedup,
machine append cancellation, invalid output quarantine, hung/late evaluations,
canonical progress and release of the worker for a subsequent batch.

Reverified migrations independently after review: 0058–0060 and snapshots match
foundation exactly; 0061 prevId chains to 0060, adds exactly two tables and no
existing table changes; journal appends only 0061. Migration reachability and
schema invariants run with the scoped ledger/worker suite on OWN PostgreSQL.

Review revision commit: `1d63205574341d83f5820317dda9c32d81ec0224`
(`fix(classification): bound dormant shadow evaluation work`), published to the
same branch/draft PR1301. Two pilot commits above exact PR1300 foundation.
- Final bounded review suite: **5 suites / 87 tests PASS**, 5.78 seconds.
  `/tmp/mention-jev-evaluation-20261001/review-fixes-tests.log`.
- Backend `bun run lint` (tsc --noEmit) PASS; git diff --check PASS.
- Inference boundary (92 mutation cases), feed-hot-path (14 cases), logger
  (9 cases) PASS. No relevant guards weakened or skipped.
- Earlier full 638/7586 run remains evidence for initial e20858f56, not falsely
  relabeled as a complete local rerun at the revised commit. New exact-head CI
  requested for standard named checks.

New exact-head standard CI: https://github.com/OxyHQ/Mention/actions/runs/36818727527
Head `1d63205574341d83f5820317dda9c32d81ec0224`, event workflow_dispatch, initially
QUEUED. No inputs are declared. Will record named completed checks below.
Hosted environment comparison caveat: both use ubuntu-24.04, runner 2.337.0,
pinned Node/Bun and unchanged lock/workflow, but GitHub allocates differing hosted
image revisions (observed 20260927.320.1 and 20260920.314.1). They are the same
declared CI environment, not claimed bit-identical machines.
Own PostgreSQL stopped successfully after final 87-test run; cluster retained.
Tracked tree clean after commit; operational/review files intentionally untracked.

Draft1301 body updated via REST PATCH after `gh pr edit` hit GitHub's deprecated
classic-project GraphQL field. This was a CLI/API compatibility error, not an
automatic approval rejection. Response confirmed base ccr-968b68e8-rniv9s,
head 1d63205574341d83f5820317dda9c32d81ec0224, draft=true. No new PR or comment.


## Final revised exact-head CI — completed

Run https://github.com/OxyHQ/Mention/actions/runs/36818727527 completed **FAILURE**
at `1d63205574341d83f5820317dda9c32d81ec0224`.

- Test backend (1/3), (2/3), (3/3): **SUCCESS**.
- CI complete / Merge shards and enforce coverage floors: **SUCCESS**;
  **638 suites / 7,596 tests passed**. Assert suite collection: **SUCCESS**.
- Test shared-types, Test mcp, Frontend bundle baseline: **SUCCESS**.
  MCP's earlier failure did not recur on this revision; no MCP change was made.
- Test frontend actual suite and row-cost harness: **SUCCESS**. Coverage policy:
  **FAILURE**, same 10 origin/main baseline decreases with empty manual baseline.
- Build, lint and typecheck: **FAILURE** at Verify Oxy dependency health, exact
  `@oxy.so/doctor 1.0.0 does not include 1.1.0 in package.json`; later checks skipped.
- Lockfile job: SUCCESS but base-comparison step SKIPPED (no green comparison claim).
- Browser gate: **FAILURE**, 38 passed / 1 skipped / 2 failed. Reproduced
  media-layout.spec.ts:149 assertion 347, AND a newly observed
  profile-chrome.spec.ts:6 case (1024, light). The profile failure is at its
  exact scrollY assertion: expected 600, got 618, both initial and retry.
  This additional failure DID NOT reproduce in the foundation control and is
  recorded as unresolved, not claimed proven inherited. Read the full test and
  failure output; git diff --quiet independently confirms frontend, e2e,
  shared-types, lock and CI workflow are unchanged against exact foundation.
  No unrelated UI refactor, workaround, guard skip or test weakening.
- CI complete / Require every CI job to have passed: **FAILURE**. Overall CI is
  not green and the draft is not ready for merge/deploy.

Full revised logs and job/step metadata:
- `/tmp/mention-jev-evaluation-20261001/ci-1d6320557-full.log`
- `/tmp/mention-jev-evaluation-20261001/ci-1d6320557-status.json`

Final handoff: same stacked draft1301, two scoped commits, no deployments/merges.
Independent coordinator must re-review revision 1d6320557 and resolve the named
CI blockers/dependencies. PR1300 foundation and authoritative Oxy1503 published
SDK remain dependencies. Commercial, internal eligibility, privacy/ZDR, source
public provenance and semantic revision/receipt reconciliation gates stay CLOSED.


## Replacement writer: rebase onto advanced foundation + privacy fix (2026-10-01)

Authorized replacement sole writer (prior Codex PID 2046216 stopped by coordinator).
Worked only in this worktree/branch. Foundation branch and other worktrees untouched.

- Fetched PR1300 foundation at exact `0a77c95cf756b1e79f98932bd10c96d96b55fd6e`
  (merge of origin/main 285f4719 into the topic branch; its pull_request CI run
  36818603794 SUCCESS). The advance changes no drizzle file.
- `git rebase --onto 0a77c95cf a97ed9fef` replayed only the two pilot commits
  (now 75cc7e306, ac588d3e3) without conflict. Local backup ref
  `backup/jev-pre-rebase-0a77` -> 1d6320557. SHA-256 manifest
  `/tmp/mention-jev-evaluation-20261001/pre-rebase-0a77-sha256.txt` re-verified OK
  for 0058-0061 SQL, snapshots and journal; 0058-0060 + snapshots `git diff --quiet`
  identical to 0a77; journal diff vs foundation appends only idx 61.
- Frozen `bun install` (pinned bun 1.3.14) against the unchanged foundation lockfile
  installed @oxy.so/doctor 1.1.0 etc.; doctor now PASSES locally (previous stale
  install reported Bloom 6.2.0 vs catalogued 6.4.0).

Privacy defect (review finding 2) FIXED in `db329ef9b`:
- Mention stores no durable listed/unlisted provenance (ActivityPub maps Public in
  `cc` to public) and atproto/Instagram actor mappers hardcode `discoverable: true`,
  so no federated column can prove eligibility. Claim AND completion now require a
  native post: null federation activity id, null federation actor URI, and no
  `federated_actors` row minted for the author (`oxy_user_id`). Unlisted,
  listed-AP, non-discoverable, suspended, followed-atproto, activity-only and
  minted-account sources are refused before any claim row; a native post whose
  author becomes a federated account mid-flight is cancelled at completion.
- Following never grants eligibility. Follow-evidence lookup kept, exported and
  tested directly (accepted / pending / inbound / contextual / savepoint failure);
  in production every completed row currently records `unknown`. Security and the
  `federated_public_visibility_provenance` gate unchanged (gate stays closed; all
  six blockers remain; no SDK binding/provider).
- Finding 3 (machine translations) FIXED where proven: shadow input is the author
  position-0 body plus `classification_languages`; `storeMachineVariant` only
  deletes/inserts `source='machine'` rows. Fingerprint now hashes author renditions
  only. Caching/replacing a translation keeps the in-flight result and opens no
  second claim. Author additions and pass-through `replacePostContent` still cancel.
  Toggle re-claim, split edits, receipts: unchanged, still gated.
- Negative controls (source restored, cmp verified): dropping the whole predicate ->
  2 failed; dropping only the minted-account clause -> 2 failed; re-adding machine
  renditions to the fingerprint -> 2 failed.

Local validation at db329ef9b (own PG17, socket `/tmp/mention-jev-evaluation-20261001/sock`,
TCP disabled, `TEST_DATABASE_URL=postgresql:///postgres` + `PGHOST`=socket dir; a first
attempt with `?host=` fell back to TCP localhost and failed auth on a foreign server
before any query — nothing created there):
- Scoped 5 suites / 91 tests PASS (`privacy-fix-tests.log`).
- FULL backend 639 suites / 7,609 tests PASS, 76.9 s (`backend-0a77-full.log`).
- backend tsc, root build, doctor, lockfile, logger, suite-collection, no-mongo,
  id-shape, architecture, inference, feed-hot-path PASS; mutation self-tests:
  architecture 24, feed-hot-path 14, id-shape 10, inference 92, logger 9,
  no-mongo 33, suite-collection PASS. git diff --check PASS.

Pushed with `--force-with-lease` pinned to 1d6320557 -> `db329ef9b`.
Exact-head CI (workflow_dispatch; pull_request only fires for main-targeted PRs):
https://github.com/OxyHQ/Mention/actions/runs/36822698253
Coordinator independently observed CI 36822698253 at db329ef9b: SUCCESS (all jobs).

## Final review fixes (`0c6217e10`)

Per `/home/nate/Oxy/.work/jev-mention-final-independent-review.md`:
- HIGH 1 FIXED: any post with a `post_imports` row is refused at claim and completion
  (Move maps Mastodon unlisted -> public with no federation columns).
- HIGH 2 FIXED: owner profile must be public (publicSeoPost semantics: no settings
  row = default public; private/followers_only refused; null owner fails closed).
  Import or profile change mid-inference cancels the result; following grants nothing.
- LOW 3 FIXED: if the claim transaction exhausts the batch deadline, the evaluator
  is not called and the claim row is deleted + logged with its id (never sent, no
  spend). Anything possibly sent remains cost_uncertain, never retried.
- LOW 4 DOCUMENTED: opportunistic/biased shadow coverage stated explicitly.
- INFO 5 unchanged (open-gate tests still use vi.spyOn; closed-gate test covers prod).
All six gates preserved; no feed/discard/provider change.

Own cluster verified first via PGHOST socket only (data_directory own, listen_addresses
'', inet_server_addr null). Scoped 5 suites / 98 PASS; pre-spend test 5/5 repeats;
negative controls: import clause -> 3 fail, profile clause -> 2 fail, old pre-spend
quarantine -> 1 fail (sources restored, cmp verified). tsc, root build, doctor,
lockfile, all guards + mutation self-tests PASS. Full backend: first run 2 timeouts in
untouched muteOperatedAccount.test.ts (passes 3/3 isolated); rerun 639 / 7,616 PASS
(`backend-final-full-2.log`). Pushed with lease db329ef9b -> 0c6217e10; PR body PATCHed
(draft, base ccr-968b68e8-rniv9s). CI dispatched: run 36824026209 (in progress at exit;
coordinator watches). No merge/deploy/provider/npm.

## Profile-visibility CAS (`add552939`)

Parent review of 0c6217e: NOT EXISTS(user_settings) under the post row lock did not
lock settings; a change could commit between final check and write. CLOSED:
- Writer inventory: `updateUserSettings` is the only path that sets/unsets
  privacyProfileVisibility (incl. missing-row insert, `privacy` object expansion).
  `ensureUserSettings` and LabelService insert default public rows (= no row);
  LabelService/channel restricted-users updates never touch visibility; account
  erasure and channel deletion delete the row only after deleting the posts.
- `lockProfileVisibility` (pg_advisory_xact_lock on `profile-visibility:<id>`):
  writer exclusive before the upsert (own transaction/savepoint); lockSnapshot takes
  it shared after content lock + post FOR UPDATE, then reads settings. Writers hold no
  prior lock -> no inversion; no transaction spans inference.
- Tests (real own PG, barriers + pg_locks waiter detection, failure-safe finally):
  change-first cancels, completion-first serializes the change after commit, each for
  existing and missing rows. 5/5 repeats. Controls: writer lock removed -> 4 fail;
  reader lock removed -> 4 fail (sources restored, cmp verified).
- Scoped 102 PASS; settings-related 18 files/199 PASS; full backend 639/7,620 PASS;
  tsc, build, doctor, lockfile, guards + mutation self-tests PASS.
- CI: 0c6217e10 run 36824026209 SUCCESS. add552939 run 36825926624 dispatched
  (queued at exit; coordinator watches). PR1301 body PATCHed (draft, base unchanged).
All gates closed; no feed/drop/provider/merge/deploy.
