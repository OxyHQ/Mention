const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.projectRoot = projectRoot;

config.watchFolders = [
  projectRoot,
  path.resolve(monorepoRoot, 'packages/agora-shared'),
];

const blockPath = (dir) => {
  const resolved = path.resolve(dir);
  return new RegExp(`${resolved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*`);
};

config.resolver = {
  ...config.resolver,
  blockList: [
    blockPath(path.join(monorepoRoot, 'packages/backend')),
    blockPath(path.join(monorepoRoot, 'packages/frontend')),
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
    /\.map$/,
  ],
  extraNodeModules: {
    '@mention/agora-shared': path.resolve(monorepoRoot, 'packages/agora-shared'),
  },
  nodeModulesPaths: [
    path.join(projectRoot, 'node_modules'),
    path.join(monorepoRoot, 'node_modules'),
  ],
  unstable_enableSymlinks: false,
  sourceExts: [...config.resolver.sourceExts, 'ts', 'tsx'],
  assetExts: config.resolver.assetExts.filter((ext) => ext !== 'svg'),
};

config.transformer = {
  ...config.transformer,
  minifierConfig: {
    ...config.transformer?.minifierConfig,
    keep_classnames: false,
    keep_fnames: false,
    mangle: { keep_classnames: false, keep_fnames: false },
    output: { ascii_only: true, quote_style: 3, wrap_iife: true },
    sourceMap: { includeSources: false },
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
    },
  },
};

module.exports = config;
