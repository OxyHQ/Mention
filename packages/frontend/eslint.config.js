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
    rules: {
      ...Object.fromEntries(
        incrementalCompilerDiagnostics.map((rule) => [rule, 'warn']),
      ),
      /**
       * The icon barrel is an error, not a style preference.
       *
       * Metro does not tree-shake, so `import { RiHand } from '@oxy.so/bloom/icons'`
       * ships all 461 Remix glyphs. 166 files here were doing it, which was 334
       * glyphs nobody draws, 286 KiB of initial JavaScript and 277 KiB of the
       * largest chunk — which sat 10 KiB under its budget at the time.
       *
       * `paths` matches the module name EXACTLY, so every `@oxy.so/bloom/icons/Ri*`
       * subpath stays legal; only the barrel itself is named. A type-only member
       * has no per-glyph subpath and no runtime cost either way, so the two files
       * that need `BloomIconComponent` take it from the package root.
       */
      'no-restricted-imports': ['error', {
        paths: [{
          name: '@oxy.so/bloom/icons',
          message:
            'Import each glyph by subpath — @oxy.so/bloom/icons/RiXxx. Metro does not tree-shake, so the barrel ships all 461. For the BloomIconComponent type, import it from @oxy.so/bloom.',
        }],
      }],
    },
  },
  {
    // Tests are not shipped, so the barrel costs them nothing — and a few assert
    // on which glyph drew by importing it directly. The rule is about bundle
    // size, so it ends where the bundle does.
    files: ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx', 'test-support/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
]);
