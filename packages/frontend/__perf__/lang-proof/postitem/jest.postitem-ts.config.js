/**
 * DEV ONLY: the perf config with PostItem in its TypeScript form (`tsPostItem.ts`),
 * for the PostItem proof (`../README.md`, "PostItem"). Run any `*.perf.tsx` with
 * `-c __perf__/lang-proof/postitem/jest.postitem-ts.config.js`.
 */
const path = require('node:path');
const base = require('../../../jest.perf.config.js');

module.exports = {
  ...base,
  rootDir: path.resolve(__dirname, '../../..'),
  moduleNameMapper: {
    '^(\\.|\\.\\.|@/components/Feed)/PostItem\\.bloom$':
      '<rootDir>/__perf__/lang-proof/postitem/tsPostItem.ts',
    ...base.moduleNameMapper,
  },
};
