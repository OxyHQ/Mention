// The shared Oxy Metro config (`@oxy.so/app-preset/metro`): monorepo watch
// folder and block list (backend, docs, `.worktrees/`, `.claude/worktrees/`,
// caches and tests), symlink + package-exports resolution, the `.wasm` /
// `.woff2` / `.woff` asset extensions (Bloom imports its web fonts straight from
// JS), the release minifier, NativeWind, the Bloom single-instance rewrite and
// the complete `react-native` shim NativeWind needs on React Native 0.88
// (`AssetRegistry`; without it every `useFonts` fails and an Android release
// renders a blank window).
//
// The minifier settings are WEB ONLY. Metro skips the JS minifier whenever the
// transform profile is `hermes-stable`/`hermes-canary` (the `const minify =
// options.minify && …` guard in metro-transform-worker), and @expo/metro-config
// sets `hermes-stable` for every Hermes-enabled native build, so none of this
// reaches the Android/iOS bundle. Verified by exporting Android twice, with
// `drop_console` on and off: byte-identical bundles.
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

const config = createOxyMetroConfig(__dirname, {
  sharedTypesPackage: '@mention/shared-types',
  // NativeWind (v5) entry, imported by `app/_layout.tsx`. This is the preset's
  // default; it is named so the file the stylesheet comes from is visible here.
  cssInput: './global.css',
  // Strips `console.*` from the production web bundle (27 KB across the 105
  // chunks). Safe because the app's only console sink (`lib/logging`, on the
  // shared `@oxy.so/core/logger`) resolves to level `silent` outside
  // development anyway, and the minifier never runs on a development build.
  dropConsole: true,
});

// Web assets are UTF-8: preserve locale text instead of expanding every
// non-ASCII character into a six-byte Unicode escape (the preset defaults to
// `ascii_only: true`).
config.transformer.minifierConfig.output.ascii_only = false;

module.exports = config;
