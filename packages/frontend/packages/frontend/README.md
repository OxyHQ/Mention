# Monorepo Workaround for Expo 54

This directory contains a symlink workaround for Expo 54's entry point resolution in npm workspaces.

## Why This Exists

After upgrading to Expo 54, Metro bundler resolves the entry point using the workspace path:
- Expected: `./index.js`
- Actual: `./packages/frontend/index.js`

This happens because Expo reads the workspace configuration from package.json and constructs paths relative to the workspace location.

## The Workaround

The `index.js` file in this directory is a symlink to `../../index.js` (the actual entry file at `packages/frontend/index.js`). This allows Metro to find the entry point at the path it's looking for while keeping the actual file in the correct location.

## Alternative Solutions

This is a temporary workaround. Potential long-term solutions:
1. Wait for Expo to fix monorepo entry point resolution
2. Move to a non-workspace monorepo setup (e.g., using pnpm or yarn)
3. Restructure the project to not use workspaces

Do not delete this directory or the symlink - it's required for the app to start.
