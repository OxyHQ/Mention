const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
const exactModuleAliases = new Map([
  ['@expo/vector-icons', path.join(projectRoot, 'shims/expo-vector-icons.ts')],
  ['@oxyhq/bloom', path.join(projectRoot, 'shims/oxy-bloom.ts')],
]);
const bloomFontDataShim = path.join(projectRoot, 'shims/bloom-font-data.web.ts');

const config = getDefaultConfig(projectRoot);

config.projectRoot = projectRoot;

// Include monorepo root so Metro can resolve hoisted dependencies in root node_modules/
config.watchFolders = [
  monorepoRoot,
];

// Helper to create block patterns
const blockPath = (dir) => {
  const resolved = path.resolve(dir);
  return new RegExp(`${resolved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*`);
};

config.resolver = {
  ...config.resolver,
  blockList: [
    blockPath(path.join(monorepoRoot, 'packages/backend')),
    blockPath(path.join(monorepoRoot, 'packages/shared-types/src')),
    blockPath(path.join(monorepoRoot, 'docs')),
    /\.expo\/.*/,
    /\.expo-shared\/.*/,
    /\.metro\/.*/,
    /\.cache\/.*/,
    /node_modules\/\.cache\/.*/,
    /\.tsbuildinfo$/,
    /.*\.expo\/types\/.*/,
    /__tests__\/.*/,
    /\.test\.(js|ts|tsx|jsx)$/,
    /\.spec\.(js|ts|tsx|jsx)$/,
    /\.md$/,
    /README/,
  ],
  extraNodeModules: {
    '@mention/shared-types': path.join(monorepoRoot, 'packages/shared-types'),
  },
  // Resolve from frontend node_modules first, then monorepo root (for hoisted deps)
  nodeModulesPaths: [
    path.join(projectRoot, 'node_modules'),
    path.join(monorepoRoot, 'node_modules'),
  ],
  // Enable symlinks for npm workspace resolution
  unstable_enableSymlinks: true,
  // Enable package.json "exports" field resolution (required by @oxyhq/bloom subpath exports)
  unstable_enablePackageExports: true,
  // Oxy's published UI still imports the `@expo/vector-icons` barrel even
  // though it only renders Ionicons and MaterialCommunityIcons. The barrel
  // eagerly registers every glyph map/font family in web and adds megabytes of
  // unused assets. Mention itself imports icon-family subpaths directly; only
  // the exact legacy barrel request is narrowed here.
  resolveRequest: (context, moduleName, platform) => {
    // Bloom publishes its web fonts as base64 strings in font-data.web.js.
    // Keeping those bytes in the entry graph inflates every initial JS download,
    // even though the browser already has an efficient, cacheable font pipeline.
    // Limit the override to Bloom's own relative import on web so no unrelated
    // module can accidentally resolve to the shim.
    const isBloomFontDataRequest =
      platform === 'web' &&
      (moduleName === './font-data.web' || moduleName === './font-data.web.js') &&
      /[\\/]@oxyhq[\\/]bloom[\\/].*[\\/]fonts[\\/]apply-font-faces\.web\.(?:js|ts)$/.test(
        context.originModulePath ?? '',
      );

    return context.resolveRequest(
      context,
      isBloomFontDataRequest
        ? bloomFontDataShim
        : exactModuleAliases.get(moduleName) ?? moduleName,
      platform,
    );
  },
  sourceExts: [...config.resolver.sourceExts, 'ts', 'tsx'],
  // Bloom 0.3.3 imports `.woff2` files directly from JS for its bundled font system
  // (BlomusModernus, Inter Variable, Geist Mono). When Metro bundles for web
  // (`bundler: "metro"` in app.config.js) it picks `apply-font-faces.web.js`, which
  // has module-level `.woff2` imports. Metro does not include `.woff2` in default
  // `assetExts`, so we register it here so those imports resolve as static assets.
  assetExts: [...config.resolver.assetExts.filter((ext) => ext !== 'svg'), 'wasm', 'woff2', 'woff'],
};

config.transformer = {
  ...config.transformer,
  // WEB ONLY. Metro skips the JS minifier whenever the transform profile is
  // `hermes-stable`/`hermes-canary` (see the `const minify = options.minify &&
  // …` guard in metro-transform-worker), and @expo/metro-config sets
  // `hermes-stable` for every Hermes-enabled native build. So none of this
  // reaches the Android/iOS bundle — Hermes' own bytecode compiler does that
  // optimization — and tuning it will not move the `.hbc`. Verified by
  // exporting Android twice, with `drop_console` on and off: byte-identical
  // bundles (18,072,060 B each, same content hash). The web export uses the
  // `default` profile, so terser runs there and these settings apply.
  minifierConfig: {
    ...config.transformer?.minifierConfig,
    keep_classnames: false,
    keep_fnames: false,
    mangle: {
      keep_classnames: false,
      keep_fnames: false,
    },
    output: {
      ascii_only: true,
      quote_style: 3,
      wrap_iife: true,
    },
    sourceMap: {
      includeSources: false,
    },
    toplevel: false,
    compress: {
      arguments: true,
      dead_code: true,
      // Strips `console.*` from the production web bundle (27 KB across the 105
      // chunks). Safe because the app's only console sink (`lib/logging`, on
      // the shared `@oxyhq/core/logger`) resolves to level `silent` outside
      // development anyway, and the minifier never runs on a development build.
      drop_console: true,
      drop_debugger: true,
      ecma: 2020,
      evaluate: true,
      inline: 1,
      passes: 3,
      reduce_funcs: true,
      reduce_vars: true,
      unsafe: false,
      unsafe_comps: false,
      unsafe_math: false,
      unsafe_methods: false,
    },
  },
};

module.exports = withNativeWind(config, {
  inlineRem: 16,
  inlineVariables: false,
});
