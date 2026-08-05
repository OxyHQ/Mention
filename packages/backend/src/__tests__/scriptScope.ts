/**
 * What each `src/scripts/` module's DRIVING SELECT is bounded by.
 *
 * ## Why this exists, and why it is a declaration rather than a scan
 *
 * `isolatedDatabaseFiles.ts` lists the test files that need a private Postgres
 * because they drive a whole-table reconciler. Its companion gate keeps that
 * list from drifting, and says so in its own docblock: it can only catch a new
 * CALLER of a job it already knows about. Finding a NEW job takes a fresh scan
 * of the write path.
 *
 * That scan has now been run twice, and got a different answer each time:
 *
 *  - the first pass looked at `src/services/`, where a global sweep is the
 *    exception, and found eleven;
 *  - the second was prompted by a CI failure, looked at
 *    `src/__tests__/scripts/`, and found **ten** more — an admin one-shot is a
 *    whole-table reconciler by definition, so the gap was a CATEGORY rather than
 *    a set of individual oversights;
 *  - the third re-ran it from IMPORTS instead of from a directory and found
 *    **two more still** — `backfillPostLanguages` and
 *    `backfillCustomFeedDefinitions`, whose suites sit at the top of
 *    `src/__tests__/` and which a directory rule reports as clean.
 *
 * **Three scans, three answers, each bounded by where somebody chose to look.**
 * A fourth scan would be a fourth guess. So membership stops being scanned for
 * and becomes DECLARED: every script a test imports is classified here, once,
 * by whoever gives it that test.
 *
 * ## The discriminator, because the obvious one does not work
 *
 * **Read the DRIVING SELECT, never the write's `where`.** Every one of the
 * twelve updates by primary key — `.where(eq(posts.id, row.id))` — so a grep for
 * unscoped `update`/`delete` finds nothing and reports a clean tree. What is
 * unscoped is the query that CHOSE that id.
 *
 * Two measured shapes make the point in opposite directions:
 *
 *  - `normalizeFederatedText` is the limit case: its filter is the literal
 *    `const POST_SCAN_FILTER = undefined`, so it scans the entire `posts` table.
 *  - `backfillFederatedBoostCounts` reads like a sibling of the twelve and is
 *    NOT one: its select is
 *    `where(scope ? and(cursor, inArray(posts.id, scope)) : cursor)`, and its
 *    suite always passes `{ postIds: [...] }`. Bounded BY THE CALLER, which is
 *    the whole distinction.
 *
 * A script that takes a scope but whose test does not pass one is `whole-table`.
 * The classification describes the CALL, not the capability.
 */

/** How a script's row set is bounded when a test drives it. */
export type ScriptScope =
  /**
   * Its driving select names no owner: it pages a whole table. A test that runs
   * it must appear in `ISOLATED_DATABASE_FILES`.
   */
  | 'whole-table'
  /**
   * Bounded by an argument the caller supplies, or it writes nothing at all.
   * Safe on the shared database.
   */
  | 'caller-scoped';

export interface ScriptScopeDeclaration {
  readonly scope: ScriptScope;
  /** Why — the predicate, or the argument that bounds it. */
  readonly reason: string;
}

/**
 * Keyed by the specifier a test imports, relative to `src/scripts/` and without
 * an extension — `backfillQuotedPosts`, `lib/adminScriptSafety`.
 *
 * A script with no test needs no entry: the gate is driven by imports, so an
 * untested script cannot corrupt anybody's rows. The moment it gains a test it
 * must be classified, which is the point at which somebody knows the answer.
 */
export const SCRIPT_SCOPE: Readonly<Record<string, ScriptScopeDeclaration>> = {
  // ── Whole-table. Every one of these has a file in ISOLATED_DATABASE_FILES. ──
  backfillFederatedThreadLinks: {
    scope: 'whole-table',
    reason: 'and(isNotNull(federation_in_reply_to), isNull(parent_post_id)) over all posts.',
  },
  normalizeFederatedText: {
    scope: 'whole-table',
    reason: 'POST_SCAN_FILTER is the literal `undefined` — the entire posts table.',
  },
  repairFederatedMentions: {
    scope: 'whole-table',
    reason: 'Bounded by options.actorUri, which the suite does not pass.',
  },
  backfillThreadRootThreadId: {
    scope: 'whole-table',
    reason: 'Groups every native post by thread_id across the table.',
  },
  migrateThreadFanToChain: {
    scope: 'whole-table',
    reason: 'The same table-wide thread_id grouping, and it reparents what it matches.',
  },
  'backfill-mtn-records': {
    scope: 'whole-table',
    reason: 'Every local published public non-boost post in the database.',
  },
  backfillFederatedHandleQualification: {
    scope: 'whole-table',
    reason: 'Every federated actor, then every variant body authored by one of them.',
  },
  backfillQuotedPosts: {
    scope: 'whole-table',
    reason: 'Every federated post with a null quote_of whose body renders as `RE: <url>`.',
  },
  backfillPostLanguages: {
    scope: 'whole-table',
    reason: 'Its own docblock: "takes no scope — by design, it is a one-shot over" the table.',
  },
  backfillCustomFeedDefinitions: {
    scope: 'whole-table',
    reason: 'isNull(custom_feeds.definition_mode) — every unmigrated feed.',
  },

  // ── Caller-scoped, or read-only. Safe to share the run's database. ──────────
  assertPostgresPopulated: {
    scope: 'caller-scoped',
    reason:
      'Read-only: its whole database surface is `select count(*) from <table>`, and it holds ' +
      'no insert, update or delete. Unscoped by table — it counts every row on purpose — but ' +
      'the rule this list enforces is about rows a test can CORRUPT, and a count writes ' +
      'nothing. Its suite additionally never reaches the counting: it imports the pure ' +
      'evaluatePopulation and passes readings in, so no test drives a query at all.',
  },
  backfillFederatedBoostCounts: {
    scope: 'caller-scoped',
    reason:
      'where(scope ? and(cursor, inArray(posts.id, scope)) : cursor), and the suite always ' +
      'passes { postIds: [...] }. The counter-example that shows the class is not "backfills".',
  },
  purgeBlockedDomainContent: {
    scope: 'caller-scoped',
    reason:
      'Takes the domain set as its first argument and the suites pass a fixture-scoped ' +
      'new Set([BLOCKED]), so its writes reach no row another file owns. Its known ' +
      'intermittent failure has a DIFFERENT offender: an unscoped write that is not a job.',
  },
  purgeBlockedDomainPlatformData: {
    scope: 'caller-scoped',
    reason: 'The platform half of the same domain-argument purge, driven the same way.',
  },
  backfillFederatedPostAuthors: {
    scope: 'caller-scoped',
    reason:
      'Its runner IS table-wide, but the suite imports only `resolveAuthorOxyUserId` — a ' +
      'resolver with no database write. The classification describes the call, not the module.',
  },
  reportFederationBlocklistCandidates: {
    scope: 'caller-scoped',
    reason: 'Reads database-wide and writes nothing: it renders a report.',
  },
  evalFeedQuality: {
    scope: 'caller-scoped',
    reason: 'Reads feed_interactions since a cutoff and scores them; no writes.',
  },
  'fixtures/feedQualityLabels': {
    scope: 'caller-scoped',
    reason: 'A fixture module of static labels; it touches no database at all.',
  },

  // ── The `lib/` helpers: primitives, not sweeps. ─────────────────────────────
  'lib/adminScriptLifecycle': {
    scope: 'caller-scoped',
    reason: 'Run-completeness assertions and resource teardown; issues no query of its own.',
  },
  'lib/adminScriptCursor': {
    scope: 'caller-scoped',
    reason: 'Keyset cursor arithmetic over values the caller hands it; issues no query.',
  },
  'lib/adminScriptSafety': {
    scope: 'caller-scoped',
    reason: 'The confirmation-token guard; reads env, writes nothing.',
  },
  'lib/adminDeletionPreflight': {
    scope: 'caller-scoped',
    reason: 'Probes references for ONE named id supplied by the caller.',
  },
  'lib/repairFetchFailureLog': {
    scope: 'caller-scoped',
    reason: 'Appends to the caller\'s own failure log rows, keyed by the ids it was given.',
  },
};
