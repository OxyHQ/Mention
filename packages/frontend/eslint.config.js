// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// React Compiler safely skips only the components that emit these diagnostics.
// Keep every finding visible while the existing app adopts the stricter Expo 57
// rules incrementally; correctness gates such as rules-of-hooks remain errors.
const incrementalCompilerDiagnostics = [
  'react-hooks/globals',
  'react-hooks/immutability',
  'react-hooks/preserve-manual-memoization',
  'react-hooks/purity',
  'react-hooks/refs',
  'react-hooks/set-state-in-effect',
  'react-hooks/use-memo',
];

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
    rules: Object.fromEntries(
      incrementalCompilerDiagnostics.map((rule) => [rule, 'warn']),
    ),
  },
]);
