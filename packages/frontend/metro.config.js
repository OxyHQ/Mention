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
};

module.exports = config;

