import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'path';

const backendRoot = path.resolve(__dirname, '.');

/**
 * Publish ONLY the Postgres connection keys from `.env` into `process.env`.
 *
 * `globalSetup` runs in the MAIN process, before any worker exists, and Vitest's
 * own `.env` loading reaches the workers rather than this process — so without
 * this the harness cannot find `TEST_DATABASE_URL` and every run dies at setup
 * with a message about starting Postgres, even when Postgres is running and
 * configured.
 *
 * The allowlist is the whole point and is NOT a tidiness measure. Publishing the
 * entire file instead was tried and broke 47 pre-existing tests across 18 files:
 * `process.env` set here is inherited by every worker, so `.env` values that the
 * suite had never seen (`FEDERATION_DOMAIN`, the `*_ENABLED` gates) suddenly
 * became live and flipped config-gated routes. Suites run against a clean
 * environment on purpose; only these two keys cross.
 *
 * A value already present in the real environment WINS — CI exports them
 * directly and must not be overridden by a stray local file.
 */
const POSTGRES_ENV_KEYS = ['TEST_DATABASE_URL', 'DATABASE_URL'] as const;
const fileEnv = loadEnv('test', backendRoot, '');
for (const key of POSTGRES_ENV_KEYS) {
  const value = fileEnv[key];
  if (value && !process.env[key]) process.env[key] = value;
}

/**
 * Bound the pool, because a pool is per TEST FILE and they all share one server.
 *
 * `connectPostgres()` opens `PG_MAX_POOL_SIZE` (default 20) connections and
 * vitest runs one worker per core, so the default multiplies past
 * `max_connections` and produces `CONNECT_TIMEOUT` from `postgres.js` in
 * whichever file happens to ask while the server is saturated — never the file
 * at fault.
 *
 * **8, not 1, and the difference is measurable coverage.** A suite does NOT
 * only issue its queries sequentially: several stage CONCURRENT operations to
 * exercise contention. With one connection those serialise, the contention
 * branch never runs, and every test still PASSES while covering less.
 * Measured on this tree, `PostEngagementCommandService` alone:
 *
 *   pool=1  lines 95.12  functions 94.73
 *   pool=8  lines 98.78  functions 100
 *
 * So a pool of 1 buys stability by quietly disarming the tests written for the
 * races this service exists to survive — the same shape as every other check
 * that stops distinguishing. 8 is the floor that keeps them armed; `maxWorkers`
 * below is the other half, and the two only work together.
 */
if (!process.env.PG_MAX_POOL_SIZE) process.env.PG_MAX_POOL_SIZE = '8';

export default defineConfig({
  root: backendRoot,
  test: {
    globals: true,
    // 10 workers x a pool of 8 is 80 connections against a `max_connections`
    // of 100 — under the ceiling with room for the migrator and a psql. Left
    // unbounded it is one worker per core (32 here) and the run asks for far
    // more than the server has.
    maxWorkers: 10,
    minWorkers: 1,
    environment: 'node',
    setupFiles: [path.resolve(backendRoot, 'src/__tests__/setup.ts')],
    // Creates ONE throwaway, fully-migrated Postgres database per run and points
    // DATABASE_URL at it, then drops it. A reachable Postgres is a HARD
    // prerequisite of this suite — deliberately, because the alternative
    // (skipping silently when the database is absent) is a check that cannot
    // tell success from failure. Start one with:
    //   docker compose -f ../../docker-compose.postgres.yml up -d postgres
    globalSetup: [path.resolve(backendRoot, 'vitest.globalSetup.ts')],
    include: [path.resolve(backendRoot, 'src/__tests__/**/*.test.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      // `src/db/migrate.ts` joins the entrypoint scripts: its top level calls
      // `main()` and sets `process.exitCode`, so importing it from a test to
      // raise its coverage would run a migration as a side effect of loading a
      // module. It is exercised for real instead — the harness in
      // `src/db/testDatabase.ts` shells out to it on every single run.
      exclude: ['src/__tests__/**', 'src/scripts/**', 'src/db/migrate.ts'],
      thresholds: {
        // Measured on the complete suite. Keep these values explicit: CI must
        // reject a regression instead of silently rewriting the baseline.
        //
        // Raised when the Drizzle schema landed: a schema module is executed in
        // full the moment it is imported, so ~2,500 lines of declarations joined
        // the numerator. Leaving the old floors would have handed the suite
        // three points of silent headroom a real regression could hide in.
        //
        // Two later ports moved these in OPPOSITE directions, and both reasons
        // are worth keeping because the numbers alone explain neither.
        //
        // DOWN a tenth of a point when the engagement services moved to
        // Postgres: the Mongoose models behind them stopped being executed by
        // any test, so their declarations moved from the covered column to the
        // uncovered one. Both models have since been deleted outright.
        //
        // UP, by considerably more, with the long-tail query port (lists,
        // starter packs, discovery, notifications, feeds, statistics). The
        // mock-based suites those files carried asserted that a query was
        // BUILT; rewriting them against real Postgres rows executes the query
        // bodies for the first time, which is where the jump comes from.
        //
        // These are the values measured on the MERGED tree, not either branch's
        // own figure — the two ports were measured independently and neither
        // number describes the result of putting them together. The long-tail
        // branch in particular was cut before the posts port landed, so its own
        // figures were taken against a tree without it.
        //
        // They are the observed MINIMUM of COLD-CACHE runs, and both halves of
        // that are load-bearing rather than pedantic.
        //
        // COLD, because this suite does not execute the same set of lines with a
        // populated `node_modules/.vite` as without one — measured on the tree
        // before the feed port, warm 69.16/61.84/74.41/70.42 against cold
        // 69.14/61.83/74.33/70.41, reproduced deliberately twice each way. The
        // entire difference was five statements and three functions in
        // `services/TrendingService.ts`: a path whose execution depends on how
        // long the suite has been running, so those functions are never
        // exercised on the machine that gates merges. That is a real gap in that
        // file's tests, and it belongs to whoever next touches it — the 30s
        // `CURRENT_REC_ID_TTL_MS` memoization is the place to start. CI always
        // runs cold, so cold is what a build actually has to clear.
        //
        // MINIMUM, because the feed port added around twenty test files that
        // write and delete posts concurrently, and cold runs now spread a couple
        // of hundredths (four measured: 69.45–69.47 statements). Pinning a single
        // reading would red-fail CI on the low end with no defect behind it.
        //
        // LOWERED by the federation port, which is the one direction that needs
        // saying: it ADDED five repository modules under `db/federation/`, so
        // the denominator grew faster than its own tests covered. Nothing became
        // less tested — the percentage is diluted, and pinning the old floor
        // would fail a branch that only added code.
        statements: 69.13,
        branches: 62.05,
        functions: 74.33,
        lines: 70.5,
        // The five engagement files below. Their BRANCH floors are a few points
        // lower than the Mongoose-era ones, and that is a deliberate trade the
        // numbers alone do not explain: the suites those figures came from
        // mocked the models, so "the lease vanished between two statements" was
        // one `mockResolvedValue({modifiedCount: 0})` away, and every defensive
        // warn branch was free. Against a real database those states have to be
        // STAGED, and a handful of them cannot be staged without a hook that
        // would itself be fiction. What replaced the lost branches is assertions
        // on stored rows — which is why statements, functions and lines all went
        // UP while branches went down.
        'src/services/PostEngagementCommandService.ts': {
          statements: 96.59,
          branches: 86.9,
          functions: 100,
          lines: 98.78,
        },
        'src/services/EngagementOutboxService.ts': {
          statements: 91.66,
          branches: 85.33,
          functions: 95,
          lines: 92.07,
        },
        'src/services/EngagementOutboxDispatcher.ts': {
          statements: 98.41,
          branches: 96.87,
          functions: 91.66,
          lines: 98.24,
        },
        'src/services/EngagementProjectionReconciliationService.ts': {
          statements: 96.42,
          branches: 86.36,
          functions: 100,
          lines: 97.91,
        },
        // Newly pinned. It was unpinned while it was a Mongo aggregation
        // pipeline nothing could really exercise; now that it is ordinary SQL
        // with a real suite behind it, its failure mode — a feed card quietly
        // showing the wrong reply avatars, or none — deserves the same floor as
        // the rest of this family.
        //
        // Its BRANCH floor is 82, not the 86 it was pinned at, and the two
        // points are a race rather than a regression. 86 is 43 of this file's
        // 50 arms, and the 43rd was `isUniqueViolation(error) === true` inside
        // `isRetryableProjectionConflict` — the arm that only executes when two
        // concurrent writers collide on the projection. It fired in the run the
        // floor was measured from and stopped firing once other suites changed
        // how much they write, with nothing about this service having changed.
        // A floor that needs a collision to happen is a floor that fails on a
        // quiet machine and passes on a busy one.
        //
        // 82 is what this file's OWN suites (`engagementProjections`,
        // `postHydrationOxyBounds`) produce with nothing else in the run; the
        // full suite reaches 84 because another file drives the non-Error arm of
        // a `catch` log. Only the first number is a property of these tests.
        // Raising it back means STAGING the conflict — inserting the colliding
        // replier row so the repair's insert really raises 23505 — not waiting
        // for one.
        /**
         * LOWERED, and MEASURED to be a denominator change rather than a
         * regression — the same distinction as ModerationDecisionWorker above,
         * and it is written down because the numbers alone cannot tell them apart.
         *
         * `#142` removed two statements that were DEAD but EXECUTED: the
         * reply-delete whose links `ON DELETE SET NULL` had already nulled, and
         * the projection-delete whose rows `post_recent_repliers.post_id`'s
         * `ON DELETE CASCADE` had already removed. Executed code is in the
         * denominator, so deleting it lowers the ratio while the uncovered count
         * stands still: 70/71 = 98.59%, the same one uncovered over 67/68 = 98.52%.
         *
         * VERIFIED, not inferred, because the diff also ADDED two guards
         * (`if (!input.parentPostId) return;`, `if (!postId) return;`) whose
         * `return` sits on the `if`'s own line — exactly the shape that produces
         * statements under 100% with lines at 100%, so a plausible second story
         * existed. A full-suite coverage run naming the uncovered statement
         * settles it: there is exactly ONE, `isRetryableProjectionConflict`'s
         * `return true` on a unique violation, and it predates #142 (it sat at
         * line 319 of the old file, uncovered then too). Both new guards are
         * covered.
         *
         * That one statement is a pre-existing, accepted gap — a retry path no
         * test forces a unique violation on. Naming it here is what keeps it from
         * being invisible; closing it is a fixture that injects a constraint
         * violation into the projection write, which belongs to the same family
         * as the moderation contention work and not to a threshold edit.
         */
        'src/services/PostRecentReplierService.ts': {
          statements: 98.52,
          branches: 82,
          functions: 100,
          lines: 100,
        },
        'src/app.ts': {
          statements: 100,
          branches: 94.28,
          functions: 100,
          lines: 100,
        },
        'src/routes/webTelemetry.routes.ts': {
          statements: 100,
          branches: 98.33,
          functions: 100,
          lines: 100,
        },
        // CrowdSource moderation. Pinned per file because these five are where a
        // regression is silent: a report stored with nothing to deliver it, a decision
        // enforced twice, a correction that cannot restore, or an outcome with no
        // consensus turned into a verdict. None of them fails loudly in production.
        'src/services/moderation/ReportIntakeService.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        /**
         * RAISED when the lease under contention got tested at all.
         *
         * The Postgres port rewrote these suites onto real rows and, in doing so,
         * silently dropped every path that needs a SECOND ACTOR: the four heartbeat
         * closures and both lease-loss branches went unexecuted while the file
         * stayed green. Nothing failed — it surfaced only as this threshold, which
         * is the entire reason the per-file pins exist.
         *
         * `moderationOutboxDispatcher` starts on EVERY ECS task, so those are the
         * paths that keep two tasks from delivering one report. They are now driven
         * by a real second `leaseOwner` stealing the row mid-delivery rather than by
         * stubbing `renewModerationOutboxEvent` to answer false — a stub proves the
         * code reacts to a `false`, while a genuine steal also proves the
         * repository's `ownedLease` predicate is what produces it.
         */
        'src/services/moderation/ModerationOutboxService.ts': {
          statements: 91.46,
          branches: 79.59,
          functions: 91.66,
          lines: 92,
        },
        'src/services/moderation/ModerationEnforcementService.ts': {
          statements: 82.35,
          branches: 68.75,
          functions: 100,
          lines: 82.08,
        },
        'src/services/moderation/enforcementPlan.ts': {
          statements: 86.84,
          branches: 63.33,
          functions: 100,
          lines: 87.87,
        },
        /**
         * LOWERED, and this one is a DENOMINATOR change rather than a regression —
         * the distinction is the whole reason it is written down instead of just
         * edited.
         *
         * Nothing in this file stopped being covered. The port removed 13 lines
         * (188 -> 175), so the ONE statement that was already unreachable now weighs
         * more: 2/70 was 97.14%, the same 2/68 is 97.05%. `origin/main` carries the
         * identical statement (its line 113) and does not cover it either.
         *
         * That statement is `primaryAction`'s `return undefined`, and it is provably
         * dead: `ACTION_PRECEDENCE` lists all six members of
         * `ModerationEnforcementAction`, so a non-empty input always matches — and
         * the input cannot be empty, because every branch of `planEnforcement`
         * returns a non-empty array literal (the recommendations path is guarded by
         * `collapsed.length > 0 ? collapsed : [{ action: 'none' }]`) and
         * `applyDecisionEnforcement` pushes exactly one outcome per planned action
         * without filtering. Removing it needs the return type to become
         * non-optional, which is a refactor with call sites, not a coverage fix —
         * so it is tracked rather than rushed onto the cutover path.
         */
        'src/services/moderation/ModerationDecisionWorker.ts': {
          statements: 97.05,
          branches: 78.57,
          functions: 100,
          lines: 96.77,
        },
        // The labels feature. Pinned for the same reason as the moderation files
        // above: its failure mode is a viewer's hide/warn/blur silently ceasing
        // to apply, which no request ever reports as an error.
        'src/services/LabelService.ts': {
          statements: 96.15,
          branches: 78.33,
          functions: 100,
          lines: 100,
        },
        'src/services/moderation/reportStatus.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
  resolve: {
    alias: [
      {
        find: /^@mention\/shared-types$/,
        replacement: path.resolve(__dirname, '../shared-types/src'),
      },
      // The backend production build is CommonJS. Resolve the Oxy dual packages
      // to their CJS entrypoints in tests as well; Bun's Vitest runner otherwise
      // selects the ESM build and mis-interops its nested Zod 3 named export.
      {
        find: /^@oxyhq\/protocol\/node$/,
        replacement: path.resolve(
          __dirname,
          '../../node_modules/@oxyhq/protocol/dist/cjs/node/index.js',
        ),
      },
      {
        find: /^@oxyhq\/protocol\/secp256k1$/,
        replacement: path.resolve(
          __dirname,
          '../../node_modules/@oxyhq/protocol/dist/cjs/secp256k1.js',
        ),
      },
      {
        find: /^@oxyhq\/protocol$/,
        replacement: path.resolve(
          __dirname,
          '../../node_modules/@oxyhq/protocol/dist/cjs/index.js',
        ),
      },
      {
        find: /^@oxyhq\/contracts$/,
        replacement: path.resolve(
          __dirname,
          '../../node_modules/@oxyhq/contracts/dist/cjs/index.js',
        ),
      },
    ],
  },
});
