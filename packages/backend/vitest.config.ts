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
        statements: 64.19,
        branches: 57.14,
        functions: 69.05,
        lines: 65.47,
        'src/services/PostEngagementCommandService.ts': {
          statements: 95.62,
          branches: 91.07,
          functions: 96,
          lines: 96.8,
        },
        'src/services/EngagementOutboxService.ts': {
          statements: 98.97,
          branches: 90.56,
          functions: 100,
          lines: 100,
        },
        'src/services/EngagementOutboxDispatcher.ts': {
          statements: 98.33,
          branches: 96.42,
          functions: 90,
          lines: 98.18,
        },
        'src/services/EngagementProjectionReconciliationService.ts': {
          statements: 97.53,
          branches: 94.73,
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
