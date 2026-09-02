const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
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
    // Agent worktrees live under `.claude/worktrees/`, each with its own full
    // node_modules. They sit inside `monorepoRoot`, which is a watchFolder, so
    // Metro crawls and watches every one of them — 15 GB at last count, which
    // exhausts the inotify watch limit and kills `expo start` with ENOSPC
    // before the dev server ever binds a port.
    blockPath(path.join(monorepoRoot, '.claude/worktrees')),
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
  // Bloom imports its four `.woff2` web fonts straight from JS so the browser
  // downloads and caches them separately from the bundle (`fonts/font-urls.web.ts`).
  // Metro does not carry `woff2` in its default `assetExts`, and only the web
  // graph reaches those imports — native loads the `.ttf` variants through
  // `useFonts` instead.
  assetExts: [...config.resolver.assetExts, 'wasm', 'woff2', 'woff'],
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
