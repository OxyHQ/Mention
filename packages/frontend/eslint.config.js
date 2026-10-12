// Minimal ESLint, run by `expo lint .` (the whole frontend). Biome (root
// biome.jsonc) formats and lints everything else, including the frontend's
// import guards (`noRestrictedImports`) and rules-of-hooks
// (`useHookAtTopLevel`). This file keeps ONLY the rules Biome has no
// equivalent for; do not add rules here that Biome can enforce.
const { defineConfig } = require('eslint/config');
const tsParser = require('@typescript-eslint/parser');
const expo = require('eslint-plugin-expo');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');

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

// Ported to Biome, so not repeated here: rules-of-hooks -> useHookAtTopLevel
// (error), exhaustive-deps -> useExhaustiveDependencies.
const {
  'react-hooks/rules-of-hooks': _rulesOfHooks,
  'react-hooks/exhaustive-deps': _exhaustiveDeps,
  ...compilerRules
} = reactHooks.configs.recommended.rules;

module.exports = defineConfig([
  {
    ignores: ['dist/*'],
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.d.ts'],
    languageOptions: { parser: tsParser },
  },
  {
    plugins: { expo, react, 'react-hooks': reactHooks },
    rules: {
      // EXPO_PUBLIC_* reads Metro cannot inline. Biome has no equivalent.
      'expo/use-dom-exports': 'error',
      'expo/no-env-var-destructuring': 'error',
      'expo/no-dynamic-env-var': 'error',

      // React Compiler diagnostics. Biome has no equivalent.
      ...compilerRules,
      ...Object.fromEntries(incrementalCompilerDiagnostics.map((rule) => [rule, 'warn'])),

      // eslint-plugin-react recommended errors that Biome has no stable
      // equivalent for. The rest of that preset maps to Biome rules
      // (useJsxKeyInIterable, noDuplicateJsxProps, noChildrenProp, ...).
      'react/display-name': 'error',
      'react/no-deprecated': 'error',
      'react/no-direct-mutation-state': 'error',
      'react/no-find-dom-node': 'error',
      'react/no-is-mounted': 'error',
      'react/no-string-refs': 'error',
      'react/no-unescaped-entities': 'error',
      'react/require-render-return': 'error',
    },
  },
]);
