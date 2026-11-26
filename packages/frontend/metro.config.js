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
  // A React Native `Text` or `TextInput` that names no family keeps React
  // Native's own face (Roboto on Android, San Francisco on iOS, react-native-web's
  // system stack on the web), as Mention has always drawn it. The preset's
  // default since 6.8.0 puts Bloom's base face, Inter, first on every such text
  // (`metro/base-font`), which draws them ~8% wider. Bloom's own texts name their
  // family either way. Takes effect from the app-preset release with `baseFont`.
  baseFont: false,
});

// Web assets are UTF-8: preserve locale text instead of expanding every
// non-ASCII character into a six-byte Unicode escape (the preset defaults to
// `ascii_only: true`).
config.transformer.minifierConfig.output.ascii_only = false;

// Explicit local-only UI development: watch the owning library worktrees too.
// Production and ordinary development keep the published package resolver.
if (process.env.OXY_LOCAL_CHECKOUT_SOURCES === '1') {
  const fs = require('node:fs');
  const path = require('node:path');
  const origin = new URL(process.env.OXY_LOCAL_CHECKOUT_ORIGIN || '');
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.CI ||
    !process.argv.includes('start') ||
    !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  ) {
    throw new Error('Local checkout sources require interactive Expo start on loopback');
  }
  const bloomRoot = path.resolve(process.env.OXY_LOCAL_BLOOM_SOURCE || '');
  const sdkRoot = path.resolve(process.env.OXY_LOCAL_PEABLE_SDK_SOURCE || '');
  const bloomPackage = JSON.parse(fs.readFileSync(path.join(bloomRoot, 'package.json'), 'utf8'));
  const sdkEntry = path.join(sdkRoot, 'src/ui/index.ts');
  if (bloomPackage.name !== '@oxy.so/bloom' || !fs.existsSync(sdkEntry)) {
    throw new Error('Local checkout source roots do not contain the expected packages');
  }
  config.watchFolders = [...new Set([...config.watchFolders, bloomRoot, sdkRoot])];
  const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  config.resolver.blockList = [
    ...[].concat(config.resolver.blockList || []),
    ...[bloomRoot, sdkRoot].flatMap((root) =>
      ['node_modules', '.git', '.local', '.worktrees', 'lib', 'dist', '__tests__'].map(
        (folder) => new RegExp(`^${escaped(path.join(root, folder))}(?:[/\\\\]|$)`),
      ),
    ),
  ];
  const parentResolve = config.resolver.resolveRequest;
  const appOrigin = path.join(__dirname, 'package.json');
  const sourceRoots = [bloomRoot + path.sep, sdkRoot + path.sep];
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const resolve = parentResolve || context.resolveRequest;
    if (moduleName === '@peable.to/sdk/checkout') {
      return resolve(context, path.join(sdkRoot, 'src/checkout.ts'), platform);
    }
    if (moduleName === '@peable.to/sdk/checkout/ui') {
      return resolve(context, sdkEntry, platform);
    }
    if (moduleName === '@oxy.so/bloom' || moduleName.startsWith('@oxy.so/bloom/')) {
      const key =
        moduleName === '@oxy.so/bloom' ? '.' : `.${moduleName.slice('@oxy.so/bloom'.length)}`;
      const exports = JSON.parse(
        fs.readFileSync(path.join(bloomRoot, 'package.json'), 'utf8'),
      ).exports;
      const wildcard = Object.keys(exports).find((candidate) => {
        if (!candidate.includes('*')) return false;
        const [prefix, suffix] = candidate.split('*');
        return key.startsWith(prefix) && key.endsWith(suffix);
      });
      const exportKey = exports[key] ? key : wildcard;
      const entry = exports[exportKey]?.['react-native'];
      let target = typeof entry === 'string' ? entry : entry?.default;
      if (target && wildcard && exportKey === wildcard) {
        const [prefix, suffix] = wildcard.split('*');
        target = target.replace(
          /\*/g,
          key.slice(prefix.length, suffix ? -suffix.length : undefined),
        );
      }
      if (!target?.startsWith('./src/')) throw new Error(`No local Bloom source for ${moduleName}`);
      const source = path.resolve(bloomRoot, target).replace(/\.(tsx?|jsx?)$/, '');
      return resolve(context, source, platform);
    }
    // Library worktrees have their own installs. Share the app's React, RN,
    // NativeWind/worklets and every other bare peer through the existing preset.
    const externalSource = sourceRoots.some((root) => context.originModulePath.startsWith(root));
    const bare = !moduleName.startsWith('.') && !path.isAbsolute(moduleName);
    return resolve(
      externalSource && bare ? { ...context, originModulePath: appOrigin } : context,
      moduleName,
      platform,
    );
  };
}

// DEV ONLY: the Bloom language proof app (`__perf__/lang-proof/README.md`). With
// `BLOOM_LANG_PROOF=1` the notification-settings screen reads deterministic
// stand-ins for its three app hooks; without it this config is unchanged.
if (process.env.BLOOM_LANG_PROOF === '1') {
  require('./__perf__/lang-proof/metro').withProofStandIns(config, __dirname);
}

// DEV ONLY: the Android A/B of the language (`lib/bloomLangAB.tsx`). With
// `EXPO_PUBLIC_BLOOM_LANG_AB=1` a polyfill records commit and touch times before
// any module runs; `BLOOM_LANG_PROFILING=1` also swaps React Native's production
// renderer for its profiling build, so `<Profiler>` reports times in a release
// bundle. Without either flag this config is unchanged.
if (process.env.EXPO_PUBLIC_BLOOM_LANG_AB === '1') {
  const path = require('node:path');
  const polyfill = path.join(__dirname, 'lib/bloomLangAB.polyfill.js');
  const getPolyfills = config.serializer.getPolyfills;
  config.serializer.getPolyfills = (options) => [
    ...(getPolyfills ? getPolyfills(options) : []),
    polyfill,
  ];
  // The proof's deterministic stand-ins for the Notifications screens' three hooks
  // (signed in, stored preferences, saves that resolve at once), so both forms are
  // measured without an account or the network.
  // Settings -> Notifications' stand-ins (`BLOOM_LANG_AB_STANDINS=1`) are in babel.config.js.
  if (process.env.BLOOM_LANG_PROFILING === '1') {
    const parentResolve = config.resolver.resolveRequest;
    config.resolver.resolveRequest = (context, moduleName, platform) => {
      const result = (parentResolve || context.resolveRequest)(context, moduleName, platform);
      if (result.type === 'sourceFile' && /[\\/]ReactFabric-prod\.js$/.test(result.filePath)) {
        return { ...result, filePath: result.filePath.replace(/-prod\.js$/, '-profiling.js') };
      }
      return result;
    };
  }
}

// The Bloom language compiler (`@oxy.so/bloom-language-compiler`): a pre-pass in
// front of the transform worker above (react-native-css's, which wraps Expo's),
// so the Babel config stays Expo's default and Noxcturnal and the React Compiler
// still apply. It hoists static language chains, marks `view()` bodies
// `"use memo"` and checks chains against the language spec. An optimisation
// only: the runtime renders the same tree without it.
module.exports = require('@oxy.so/bloom-language-compiler/metro').withBloomLanguage(config);
