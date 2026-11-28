import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// Explicit unit-only run: no database setup, no database test inclusion.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    globalSetup: [],
    include: [
      'src/__tests__/jevOwnedPg.test.ts',
      'src/__tests__/services/jevShadow.test.ts',
      'src/__tests__/services/jevSdk.test.ts',
      'src/__tests__/db/protectedColumns.test.ts',
      'src/__tests__/services/channelCascadeCoverage.test.ts',
      'src/__tests__/services/accountErasureCoverage.test.ts',
    ],
  },
});
