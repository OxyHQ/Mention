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
      {
        ...babelOptions,
        // The app ships React-Compiler output (app.json `experiments.reactCompiler`),
        // and babel-preset-expo only applies it when the caller says so — jest-expo's
        // caller does not. Without this the harness would measure hand-written hooks
        // the device never runs.
        caller: { ...babelOptions.caller, supportsReactCompiler: true },
        plugins: [require.resolve('./test-support/perfDynamicImport')],
      },
    ],
  },
  rootDir: '.',
  testMatch: ['<rootDir>/**/__perf__/**/*.perf.tsx'],
  testPathIgnorePatterns: ['/node_modules/'],
  // Reanimated's own Jest resolver (4.7+), which wraps Worklets' one: it picks
  // the JS (non-.native) worklet runtime AND Reanimated's web initializers, so
  // real Reanimated loads without the native module. Worklets' resolver alone
  // now loads Reanimated's native initializers, which call `runOnUISync`.
  resolver: require.resolve('react-native-reanimated/jest/resolver'),
  transformIgnorePatterns: [
    preset.transformIgnorePatterns[0].replace(
      '(?!(',
      '(?!(@oxy\\.so|@syra\\.fm|@mercaria\\.co/sdk|',
    ),
    ...preset.transformIgnorePatterns.slice(1),
  ],
  // Gesture Handler 3 installs its UI-runtime bindings on a timer by asking
  // Worklets for the UI runtime, which the JS worklet runtime above does not
  // have: it throws after the tests pass and fails the suite. Gesture Handler's
  // web build of that module is the no-op this runtime needs.
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '^\\./installUIRuntimeBindings$': require.resolve(
      'react-native-gesture-handler/src/handlers/gestures/installUIRuntimeBindings.web.ts',
    ),
  },
  setupFiles: [...base.setupFiles, '<rootDir>/test-support/perfSetup.ts'],
  // Reanimated/worklets keep a frame loop alive after the last test.
  forceExit: true,
  collectCoverageFrom: undefined,
  coverageThreshold: undefined,
};
