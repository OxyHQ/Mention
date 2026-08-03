/**
 * Test files that must run against their OWN throwaway Postgres database.
 *
 * The suite shares ONE database for the whole run: `vitest.globalSetup.ts`
 * creates it before any worker exists and every worker inherits the same
 * `DATABASE_URL`. That is fine for a file that only touches rows it inserted —
 * which is nearly all of them, because the fixtures scope their writes to ids
 * they generated.
 *
 * It is NOT fine for a file that invokes a BACKGROUND JOB. A job's whole purpose
 * is to page over a table and rewrite, delete or publish whatever it finds; it
 * has no owner scope, and correctly so — in production the table belongs to it.
 * Under one shared database that same sweep reaches rows another test file
 * seeded milliseconds earlier, in a different worker, with no relationship to
 * the job at all. The damage lands on the VICTIM: the offending file goes green
 * while some unrelated suite reports a `23505`, a row that vanished, or a
 * `status` that changed under it. One such collision survived a full session of
 * narrowing before the shared database was identified as the cause.
 *
 * The fix is to remove the concurrent writers, not the globalness: each file
 * below gets a private database in `src/__tests__/setup.ts`, so its job sweeps a
 * table nothing else can see. Adding a scope parameter to a production job so a
 * test can call it narrowly is explicitly NOT the fix — it changes shipped code
 * to serve the harness, and the parameter would be wrong (unset) in the one
 * place it matters.
 *
 * Cost: one `createTestDatabase()` per listed file, measured at ~0.60s, paid by
 * eleven files out of ~500.
 *
 * ## How this list was built, and what would keep it complete
 *
 * By scanning for UNSCOPED DRIZZLE WRITES — an `update`/`delete` whose `where`
 * names no owner, or a `select` whose predicate is a status alone — and NOT by
 * looking for job-sounding names. A `Reconcil|Dispatch|Sweep|Job|Scheduler`
 * sweep finds nine of these eleven and provably misses
 * `PostClassificationService.processQueue`, which contains none of those
 * substrings and whose two writers are called `markEmptyPosts` and
 * `classifyBatch`.
 *
 * `src/__tests__/isolatedDatabaseCoverage.test.ts` is what keeps membership
 * ASSERTABLE rather than remembered: it scans every `*.test.ts` for calls to the
 * entry points named below and fails, naming the file, if a caller is missing
 * here. That gate cannot discover a TWELFTH unscoped job — only a fresh scan of
 * the write path can — but it does guarantee that no new CALLER of a known one
 * slips in unlisted.
 */

/** One test file that cannot share the run's database. */
export interface IsolatedDatabaseFile {
  /**
   * Path relative to `packages/backend/`, matched as a suffix of the absolute
   * `testPath` vitest reports.
   */
  readonly path: string;
  /**
   * The job entry point this file calls. `isolatedDatabaseCoverage.test.ts`
   * scans for exactly these, so the string is load-bearing, not documentation.
   */
  readonly jobEntryPoint: string;
  /** What that entry point rewrites, and therefore what it can reach. */
  readonly reason: string;
}

export const ISOLATED_DATABASE_FILES: readonly IsolatedDatabaseFile[] = [
  {
    path: 'src/__tests__/services/engagementProjections.test.ts',
    jobEntryPoint: 'reconcileEngagementProjections',
    reason:
      'Repairs `post_recent_repliers` for every post whose projection disagrees with ' +
      'its reply rows — so a post another file just replied to is a candidate, and the ' +
      'repair inserts the replier row that file was about to insert (`23505`).',
  },
  {
    path: 'src/__tests__/services/engagementWritePath.test.ts',
    jobEntryPoint: 'dispatchEngagementOutbox',
    reason:
      'Claims and completes due `engagement_outbox` rows regardless of which post they ' +
      'belong to, so it consumes events another file enqueued and expects to still be pending.',
  },
  {
    path: 'src/__tests__/services/moderation/moderationOutboxRetry.test.ts',
    jobEntryPoint: 'dispatchModerationOutbox',
    reason:
      'Same shape on `moderation_outbox`: it leases whatever is due across the whole ' +
      'table and drives it to delivered or dead-lettered.',
  },
  {
    path: 'src/__tests__/services/moderation/moderationReconciliation.test.ts',
    jobEntryPoint: 'reconcileModerationReports',
    reason:
      'Sweeps every `queued`/`delivery_failed` report in the database and re-derives its ' +
      'missing outbox event, so it materialises rows for reports it did not create.',
  },
  {
    path: 'src/__tests__/services/scheduledPostPublisher.test.ts',
    jobEntryPoint: 'publishDuePosts',
    reason:
      'Flips EVERY `status:scheduled` post whose time has come to `published`, running the ' +
      'full publish pipeline on it. A scheduled post another file seeded is published out ' +
      'from under it.',
  },
  {
    path: 'src/__tests__/services/scheduledThreadPublication.test.ts',
    jobEntryPoint: 'publishDuePosts',
    reason:
      'The second caller of the same due-post sweep — the thread half of it. Two files, one ' +
      'entry point, and both need their own database for the same reason.',
  },
  {
    path: 'src/__tests__/followerSnapshotJob.test.ts',
    jobEntryPoint: 'runSnapshotSweep',
    reason:
      'Takes no arguments: it samples recently-active local authors database-wide, least ' +
      'recently snapshotted first, and writes an `author_follower_snapshots` row per author — ' +
      'so any author another file just posted as becomes a sample.',
  },
  {
    path: 'src/__tests__/services/federation/blocklistProposals.test.ts',
    jobEntryPoint: 'runBlocklistProposalSweep',
    reason:
      'Rewrites the whole open-proposal ledger: opens, reopens and closes `blocklist_proposals` ' +
      'rows for every domain in the report. The injectable poll bounds which domains are ' +
      'CONSIDERED, never which stored rows are rewritten.',
  },
  {
    path: 'src/__tests__/db/expiry.test.ts',
    jobEntryPoint: 'sweepExpiredRows',
    reason:
      'Deletes expired rows from a whole table in batches. Its targets include `notifications`, ' +
      '`trending` and `engagement_outbox` — tables several other files seed.',
  },
  {
    path: 'src/__tests__/services/federation/blockedDomainPurgeReconciler.test.ts',
    jobEntryPoint: 'reconcileBlockedDomainPurges',
    reason:
      'Drives every `blocked_domain_purges` row toward `purged` and appends run rows, so it ' +
      'advances purge state another file staged and left pending.',
  },
  {
    /**
     * The entry the original list predates, and the one that argues for scanning
     * writes rather than names.
     *
     * `processQueue` runs TWO unscoped writers over `posts` — the most-shared
     * table in the suite:
     *
     *   - `markEmptyPosts` (`PostClassificationService.ts:194`) updates
     *     `classificationStatus='classified'` on EVERY pending row with no
     *     content variant, with no owner term in the `where` at all.
     *   - `classifyBatch` (`:213`) selects on the same unscoped `UNCLASSIFIED`
     *     predicate plus `hasVariantSql()` / `status='published'` /
     *     `boost_of is null`, takes the `BATCH_SIZE` OLDEST rows across the whole
     *     database, and writes classification results onto whatever it picked up.
     *
     * `markEmptyPosts` is `private`, so a gate keyed on ITS name would find zero
     * callers, pass forever and protect nothing. The public cycle is the entry
     * point, and the blast radius is `processQueue` entire.
     *
     * Its docstring says "Bounded to the pending set." That is TRUE, and it is
     * not a caller bound — the pending set is every pending post in the
     * database, not the calling file's. An audit asking "does it bound its
     * work?" gets a yes and moves on. Same shape as
     * `runBlocklistProposalSweep` accepting an injectable poll and so reading as
     * scoped: a bound that is real, but is not the caller's.
     */
    path: 'src/__tests__/services/postClassification.test.ts',
    jobEntryPoint: 'processQueue',
    reason:
      'Runs the classification cycle: `markEmptyPosts` marks every pending text-less post in ' +
      'the database classified, and `classifyBatch` claims the oldest unclassified published ' +
      'posts database-wide and writes results onto them.',
  },
];

/**
 * Whether `testPath` names a file that must get its own database.
 *
 * Matched as a path SUFFIX so it holds for any checkout, worktree or CI
 * workspace root. The stored paths carry their full `src/__tests__/…` prefix, so
 * a suffix match cannot be satisfied by a same-named file elsewhere in the tree.
 *
 * @param testPath Absolute path of the test file, as `expect.getState()` reports it.
 */
export function needsIsolatedDatabase(testPath: string): boolean {
  const normalized = testPath.replace(/\\/g, '/');
  return ISOLATED_DATABASE_FILES.some((entry) => normalized.endsWith(`/${entry.path}`));
}
