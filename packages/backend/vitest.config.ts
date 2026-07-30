import { defineConfig } from 'vitest/config';
import path from 'path';

const backendRoot = path.resolve(__dirname, '.');

export default defineConfig({
  root: backendRoot,
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(backendRoot, 'src/__tests__/setup.ts')],
    include: [path.resolve(backendRoot, 'src/__tests__/**/*.test.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/scripts/**'],
      thresholds: {
        // Measured on the complete suite. Keep these values explicit: CI must
        // reject a regression instead of silently rewriting the baseline.
        statements: 60.68,
        branches: 53.92,
        functions: 65.88,
        lines: 61.91,
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
          statements: 76.11,
          branches: 58.49,
          functions: 100,
          lines: 76.92,
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
