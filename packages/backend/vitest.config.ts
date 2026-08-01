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

export default defineConfig({
  root: backendRoot,
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(backendRoot, 'src/__tests__/setup.ts')],
    // Creates ONE throwaway, fully-migrated Postgres database per run and points
    // DATABASE_URL at it, then drops it. A reachable Postgres is a HARD
    // prerequisite of this suite — deliberately, because the alternative
    // (skipping silently when the database is absent) is a check that cannot
    // tell success from failure. Start one with:
    //   docker compose -f ../../docker-compose.postgres.yml up -d postgres
    // The Mongo side is untouched: `src/__tests__/setup.ts` still mocks mongoose
    // wholesale and every pre-existing suite runs against that mock.
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
        // Postgres: their Mongoose models (`models/EngagementOutbox.ts`,
        // `models/PostRecentReplier.ts`) are no longer executed by any test —
        // they survive only for the historical Mongo migrations — so their
        // declarations moved from the covered column to the uncovered one.
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
        // They are the COLD-CACHE figures, and that distinction is load-bearing
        // rather than pedantic. This suite does not execute the same set of
        // lines on every run: with `node_modules/.vite` populated it measures
        // 69.16/61.84/74.41/70.42, and with that directory removed it measures
        // 69.14/61.83/74.33/70.41 — reproduced deliberately, twice each way, so
        // it is deterministic and not a flake. CI always runs cold, so the cold
        // figures are the ones a build actually has to clear; pinning the warm
        // ones red-fails every CI run with no defect behind it.
        //
        // The whole difference is FIVE statements and THREE functions in
        // `services/TrendingService.ts` (86.84% functions warm, 78.94% cold) —
        // a path whose execution depends on how long the suite has been
        // running, so those three functions are never exercised on the machine
        // that gates merges. That is a real gap in that file's tests, not a
        // property of the coverage tool, and it belongs to whoever next touches
        // `TrendingService` — its 30s `CURRENT_REC_ID_TTL_MS` memoization is the
        // place to start.
        statements: 69.14,
        branches: 61.83,
        functions: 74.33,
        lines: 70.41,
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
        'src/services/PostRecentReplierService.ts': {
          statements: 98.59,
          branches: 86,
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
        'src/utils/mongoTopology.ts': {
          statements: 100,
          branches: 100,
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
        'src/services/moderation/ModerationOutboxService.ts': {
          statements: 77.41,
          branches: 57.62,
          functions: 70.58,
          lines: 80.23,
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
        'src/services/moderation/ModerationDecisionWorker.ts': {
          statements: 97.14,
          branches: 78.57,
          functions: 100,
          lines: 96.87,
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
    alias: {
      '@mention/shared-types': path.resolve(__dirname, '../shared-types/src'),
      // The backend production build is CommonJS. Resolve the Oxy dual packages
      // to their CJS entrypoints in tests as well; Bun's Vitest runner otherwise
      // selects the ESM build and mis-interops its nested Zod 3 named export.
      '@oxyhq/protocol/node': path.resolve(
        __dirname,
        '../../node_modules/@oxyhq/protocol/dist/cjs/node/index.js',
      ),
      '@oxyhq/protocol': path.resolve(
        __dirname,
        '../../node_modules/@oxyhq/protocol/dist/cjs/index.js',
      ),
      '@oxyhq/contracts': path.resolve(
        __dirname,
        '../../node_modules/@oxyhq/contracts/dist/cjs/index.js',
      ),
    },
  },
});
