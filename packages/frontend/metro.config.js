const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Explicitly set projectRoot
config.projectRoot = projectRoot;

// CRITICAL: Only watch the frontend package
// This prevents Metro from watching the entire monorepo
config.watchFolders = [projectRoot];

// Helper to create block patterns
const blockPath = (dir) => {
  const resolved = path.resolve(dir);
  return new RegExp(`${resolved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*`);
};

config.resolver = {
  ...config.resolver,
  blockList: [
    // Block specific packages we don't need
    blockPath(path.join(monorepoRoot, 'packages/backend')),
    blockPath(path.join(monorepoRoot, 'packages/shared-types/src')),
    blockPath(path.join(monorepoRoot, 'docs')),
    // Block ALL generated/cache directories - these cause infinite loops
    /\.expo\/.*/,
    /\.expo-shared\/.*/,
    /\.metro\/.*/,
    /\.cache\/.*/,
    /node_modules\/\.cache\/.*/,
    /\.tsbuildinfo$/,
    // Block .expo/types specifically to avoid infinite loops with typedRoutes
    /.*\.expo\/types\/.*/,
    // Block test files
    /__tests__\/.*/,
    /\.test\.(js|ts|tsx|jsx)$/,
    /\.spec\.(js|ts|tsx|jsx)$/,
    // Block documentation files
    /\.md$/,
    /README/,
    // Block source maps in production (they can be large)
    /\.map$/,
  ],
  extraNodeModules: {
    '@mention/shared-types': path.join(monorepoRoot, 'packages/shared-types'),
  },
  // Resolve from frontend node_modules first, then root (for workspaces)
  nodeModulesPaths: [
    path.join(projectRoot, 'node_modules'),
    path.join(monorepoRoot, 'node_modules'),
  ],
  // Disable symlink following to prevent circular dependencies
  unstable_enableSymlinks: false,
  // Enable tree shaking by using source extensions
  sourceExts: [...config.resolver.sourceExts, 'ts', 'tsx'],
  assetExts: config.resolver.assetExts.filter((ext) => ext !== 'svg'),
};

// Optimize transformer for better tree shaking
config.transformer = {
  ...config.transformer,
  // Enable minification in production
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
      // Optimize compression
      arguments: true,
      dead_code: true,
      drop_console: false, // Keep console in development
      drop_debugger: true,
      ecma: 2020,
      evaluate: true,
      inline: 1,
      passes: 3, // Multiple passes for better optimization
      reduce_funcs: true,
      reduce_vars: true,
      unsafe: false,
      unsafe_comps: false,
      unsafe_math: false,
      unsafe_methods: false,
    },
  },
};

module.exports = config;

