# Vercel Deployment Guide for Mention Monorepo

This guide explains how to deploy the Mention monorepo to Vercel with proper shared-types handling.

## Overview

The Mention monorepo contains three main packages:
- `@mention/shared-types` - Shared TypeScript types
- `@mention/frontend` - React Native/Expo frontend
- `@mention/backend` - Node.js backend

## Deployment Configuration

### Frontend Deployment

Use `vercel-frontend.json` for frontend deployment:

```json
{
  "name": "mention-frontend",
  "buildCommand": "VERCEL_TARGET=frontend node scripts/build-for-vercel.js",
  "outputDirectory": "packages/frontend/dist",
  "installCommand": "npm install",
  "framework": null,
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ]
}
```

### Backend Deployment

Use `vercel-backend.json` for backend deployment:

```json
{
  "name": "mention-backend",
  "buildCommand": "VERCEL_TARGET=backend node scripts/build-for-vercel.js",
  "outputDirectory": "packages/backend/dist",
  "installCommand": "npm install",
  "framework": null,
  "functions": {
    "packages/backend/dist/server.js": {
      "runtime": "nodejs18.x"
    }
  }
}
```

## Build Process

The build process is handled by `scripts/build-for-vercel.js` which:

1. **Installs dependencies** - Runs `npm install` to install all workspace dependencies
2. **Builds shared-types** - Compiles the shared TypeScript types first
3. **Links shared-types** - Copies built shared-types to consuming packages' node_modules
4. **Builds target** - Builds either frontend or backend based on `VERCEL_TARGET` environment variable

## Key Features

### Shared Types Resolution

The build script ensures shared-types are properly available during build by:
- Building shared-types first
- Copying built files to `node_modules/@mention/shared-types` in both frontend and backend
- Using TypeScript project references for proper dependency resolution

### TypeScript Configuration

Both frontend and backend have proper TypeScript path mappings:

```json
{
  "paths": {
    "@mention/shared-types": ["../shared-types/src"],
    "@mention/shared-types/*": ["../shared-types/src/*"]
  },
  "references": [
    {
      "path": "../shared-types"
    }
  ]
}
```

## Deployment Steps

### 1. Frontend Deployment

```bash
# Copy frontend config
cp vercel-frontend.json vercel.json

# Deploy to Vercel
vercel --prod
```

### 2. Backend Deployment

```bash
# Copy backend config
cp vercel-backend.json vercel.json

# Deploy to Vercel
vercel --prod
```

## Environment Variables

Make sure to set the following environment variables in your Vercel project:

### Frontend
- `EXPO_PUBLIC_API_URL` - Backend API URL
- `EXPO_PUBLIC_OXY_CLIENT_ID` - Oxy client ID
- `EXPO_PUBLIC_OXY_REDIRECT_URI` - Oxy redirect URI

### Backend
- `MONGODB_URI` - MongoDB connection string
- `JWT_SECRET` - JWT secret for authentication
- `TELEGRAM_BOT_TOKEN` - Telegram bot token (optional)

## Troubleshooting

### Shared Types Not Found

If you encounter shared-types import errors:

1. Ensure the build script is running: `node scripts/build-for-vercel.js`
2. Check that shared-types are built: `ls packages/shared-types/dist/`
3. Verify TypeScript path mappings in `tsconfig.json` files

### Build Failures

1. Check that all dependencies are installed: `npm install`
2. Ensure TypeScript is properly configured
3. Verify that the target package exists and has a build script

## Local Development

For local development, use the workspace scripts:

```bash
# Install all dependencies
npm run install:all

# Build shared-types
npm run build:shared-types

# Start frontend
npm run dev:frontend

# Start backend
npm run dev:backend
```

## Notes

- The build script automatically handles the monorepo structure
- Shared-types are built and linked during the build process
- TypeScript project references ensure proper dependency resolution
- The `file:` dependencies in package.json work locally but are handled specially for Vercel 