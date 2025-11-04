// Entry point for Expo Router in monorepo setup with npm workspaces
// This file is required for Expo 54 to properly resolve the entry point in a monorepo
// 
// Using CommonJS require() instead of ES6 import to ensure compatibility with Metro bundler
// Metro needs to be able to load this file before the full module system is initialized
//
// Note: A symlink exists at packages/frontend/index.js pointing to this file to work around
// Expo 54's workspace path resolution (see packages/frontend/packages/frontend/README.md)
require("expo-router/entry");
