/**
 * The native feed row-cost harness (issue #1103): `bun run test:perf`.
 *
 * Separate from the unit-test config for one reason: the harness mounts the
 * REAL row — Bloom, Reanimated, NativeWind interop and all — rather than the
 * stubbed shapes unit tests use, and Bloom ships untranspiled TypeScript that
 * the default `transformIgnorePatterns` leaves alone. Widening that pattern for
 * every unit test would slow the whole suite; widening it here costs only the
 * harness.
 */
const base = require('./package.json').jest;
const preset = require('jest-expo/jest-preset');

const [babelJest, babelOptions] = preset.transform['\\.[jt]sx?$'];

module.exports = {
  ...base,
  transform: {
    ...preset.transform,
    '\\.[jt]sx?$': [
      babelJest,
      { ...babelOptions, plugins: [require.resolve('./test-support/perfDynamicImport')] },
    ],
  },
  rootDir: '.',
  testMatch: ['<rootDir>/**/__perf__/**/*.perf.tsx'],
  testPathIgnorePatterns: ['/node_modules/'],
  // Worklets' own Jest resolver: picks the JS (non-.native) worklet runtime so
  // real Reanimated loads without the native module.
  resolver: require.resolve('react-native-worklets/jest/resolver'),
  transformIgnorePatterns: [
    preset.transformIgnorePatterns[0].replace('(?!(', '(?!(@oxy\\.so|@syra\\.fm|'),
    ...preset.transformIgnorePatterns.slice(1),
  ],
  setupFiles: [...base.setupFiles, '<rootDir>/test-support/perfSetup.ts'],
  // Reanimated/worklets keep a frame loop alive after the last test.
  forceExit: true,
  collectCoverageFrom: undefined,
  coverageThreshold: undefined,
};
