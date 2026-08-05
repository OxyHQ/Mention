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
 * Cost: one `createTestDatabase()` per listed file, paid by twenty-one files out
 * of ~500.
 *
 * ## How this list was built, and what would keep it complete
 *
 * By scanning for UNSCOPED DRIZZLE WRITES — an `update`/`delete` whose `where`
 * names no owner, or a `select` whose predicate is a status alone — and NOT by
 * looking for job-sounding names. A `Reconcil|Dispatch|Sweep|Job|Scheduler`
 * sweep finds nine of the original eleven and provably misses
 * `PostClassificationService.processQueue`, which contains none of those
 * substrings and whose two writers are called `markEmptyPosts` and
 * `classifyBatch`.
 *
 * `src/__tests__/isolatedDatabaseCoverage.test.ts` is what keeps membership
 * ASSERTABLE rather than remembered: it scans every `*.test.ts` for calls to the
 * entry points named below and fails, naming the file, if a caller is missing
 * here. That gate cannot discover a job it has never been told about — only a
 * fresh scan of the write path can — but it does guarantee that no new CALLER of
 * a known one slips in unlisted.
 *
 * ## THE SECOND SCAN, and what it says about the first
 *
 * The gate's limitation is not hypothetical: a twelfth job
 * (`backfillFederatedThreadLinks`) surfaced as an intermittent CI failure —
 * `run incomplete: unresolved=1`, green on two neighbouring commits, so it read
 * as a flake — and the gate could not have found it, exactly as it said.
 *
 * The scan that followed found **ten**, not one. Every `*.test.ts` was checked
 * for a call into a module whose DRIVING SELECT names no owner, and the answer
 * clusters almost entirely in `src/__tests__/scripts/`: an admin one-shot is a
 * whole-table reconciler BY DEFINITION, so the ten are less a set of oversights
 * than one category the first pass did not look in. The first list was built
 * from `src/services/`, where a global sweep is the exception; `src/scripts/` is
 * where it is the rule.
 *
 * **The discriminator is the DRIVING SELECT, never the write's `where`.** Every
 * one of these ten updates by primary key — `.where(eq(posts.id, row.id))` reads
 * perfectly scoped in isolation. What is unscoped is the query that CHOSE that
 * id. `normalizeFederatedText` is the limit case and worth remembering as the
 * shape: its filter is the literal `const POST_SCAN_FILTER = undefined`, so it
 * scans the entire `posts` table, and its suite runs it in write mode.
 *
 * Two entries are also a correction to work that landed hours earlier:
 * `backfillFederatedHandleQualification` and `backfillQuotedPosts` were ported
 * to Postgres with new real-rows suites, and those suites call them with
 * `dryRun: false` against the shared database. Adding a global reconciler to
 * the suite is what creates one of these; it is not a pre-existing condition.
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

  /*
   * ── THE ADMIN ONE-SHOTS ─────────────────────────────────────────────────────
   *
   * Everything below reconciles a WHOLE TABLE, because that is what an admin
   * one-shot is for. Each updates by primary key, so the write reads scoped; the
   * SELECT that chose the key does not.
   */
  {
    path: 'src/__tests__/services/federationThreadLinking.test.ts',
    jobEntryPoint: 'backfillFederatedThreadLinks',
    reason:
      'Scans `and(isNotNull(federation_in_reply_to), isNull(parent_post_id))` — every federated ' +
      'orphan in the table — and UPDATEs `parent_post_id`/`thread_id` on what it can resolve. ' +
      'The one that surfaced this class: a foreign orphan it cannot resolve makes the run ' +
      'report `unresolved=1` and throw, which reads as a flake in THIS file.',
  },
  {
    path: 'src/__tests__/scripts/normalizeFederatedText.test.ts',
    jobEntryPoint: 'normalizeStoredText',
    reason:
      'The limit case: its filter is the literal `const POST_SCAN_FILTER = undefined`, so it ' +
      'scans the ENTIRE `posts` table and rewrites variant bodies, media alt text and spoiler ' +
      'text. The suite calls it with `dryRun: false`.',
  },
  {
    path: 'src/__tests__/scripts/repairFederatedMentions.test.ts',
    jobEntryPoint: 'repairFederatedMentions',
    reason:
      'Its candidate filter is bounded by `options.actorUri` — which the suite does not pass, so ' +
      'the scan is every federated post there is, and it rewrites `post_content_variants.body` ' +
      'on whatever it decides is malformed.',
  },
  {
    path: 'src/__tests__/scripts/backfillThreadRootThreadId.test.ts',
    jobEntryPoint: 'backfillThreadRootThreadId',
    reason:
      'Groups every native post by `thread_id` across the table and stamps `thread_id` onto the ' +
      'roots it finds — so a thread another file is mid-way through seeding is a group.',
  },
  {
    path: 'src/__tests__/scripts/migrateThreadFanToChain.test.ts',
    jobEntryPoint: 'migrateThreadFanToChain',
    reason:
      'The same table-wide `thread_id` grouping, and it REPARENTS what it matches: it writes ' +
      '`parent_post_id` on continuations to convert a fan into a chain.',
  },
  {
    path: 'src/__tests__/scripts/backfillMtnRecords.test.ts',
    jobEntryPoint: 'backfillMtnRecords',
    reason:
      'Selects every local published public non-boost post in the database and signs an MTN ' +
      'record for each — so it emits chain records for posts other files own.',
  },
  {
    path: 'src/__tests__/scripts/backfillFederatedHandleQualificationRows.test.ts',
    jobEntryPoint: 'backfillFederatedHandleQualification',
    reason:
      'Reads every `federated_actors` row, then every `post_content_variants` body whose post is ' +
      'authored by one of them, and rewrites the bodies it can qualify. The suite runs it with ' +
      '`dryRun: false`.',
  },
  {
    path: 'src/__tests__/scripts/backfillQuotedPostsRows.test.ts',
    jobEntryPoint: 'backfillQuotedPosts',
    reason:
      'Selects every federated post with a null `quote_of` whose body renders as `RE: <url>` and ' +
      'UPDATEs `quote_of` on it. Its suite mocks `signedFetch` to answer with a quote for ANY ' +
      'candidate, so a foreign row entering the scan is linked to this file\'s fixture.',
  },

  /*
   * ── THE TWO THE SECOND SCAN ALSO MISSED ─────────────────────────────────────
   *
   * Found only when the scan was re-run from IMPORTS rather than from a
   * directory. Both drive an admin one-shot and neither lives under
   * `src/__tests__/scripts/`, so a rule keyed on that directory would have
   * reported clean — the same search-space error the second scan had just
   * diagnosed, repeated one level up. `scriptScope.ts` exists so a third one
   * cannot arrive this way.
   */
  {
    path: 'src/__tests__/backfillPostLanguages.test.ts',
    jobEntryPoint: 'backfillPostLanguages',
    reason:
      'Pages every post whose classification is missing or below ' +
      '`BASELINE_CLASSIFIER_VERSION` and writes languages onto each. Its own docblock says it ' +
      '"takes no scope — by design", and the suite calls it with `batchSize` only.',
  },
  {
    path: 'src/__tests__/backfillCustomFeedDefinitions.test.ts',
    jobEntryPoint: 'backfillCustomFeedDefinitions',
    reason:
      'Its filter is `isNull(custom_feeds.definition_mode)` — every unmigrated feed in the ' +
      'table — and it stamps a definition onto each. The suite calls it with no arguments.',
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
