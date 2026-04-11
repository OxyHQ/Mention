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
    '@mention/agora-shared': path.join(monorepoRoot, 'packages/agora-shared'),
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
  sourceExts: [...config.resolver.sourceExts, 'ts', 'tsx'],
  assetExts: [...config.resolver.assetExts.filter((ext) => ext !== 'svg'), 'wasm'],
};

config.transformer = {
  ...config.transformer,
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
      drop_console: false,
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
