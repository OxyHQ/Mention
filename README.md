# Mention

> A modern, cross-platform social app built with Expo, React Native, TypeScript, and a Node.js/Express backend in a monorepo structure.

---

## Table of Contents
- [About](#about)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Development Scripts](#development-scripts)
- [API Documentation](#api-documentation)
- [Contributing](#contributing)
- [License](#license)

---

## About

**Mention** is a universal social platform inspired by Twitter/X, designed for mobile and web. It features real-time feeds, user profiles, trends, notifications, and more. Built with Expo, React Native, and a Node.js backend in a modern monorepo structure, it supports file-based routing, multi-language support, and a modern UI.

## Project Structure

This is a **monorepo** using Bun workspaces with the following structure:

```
/
├── packages/            # All code packages
│   ├── frontend/        # Expo React Native app
│   │   ├── app/         # App entry, screens, and routing
│   │   │   ├── [username]/  # User profile, followers, following
│   │   │   ├── ai/          # AI assistant (Alia chat)
│   │   │   ├── p/[id]/      # Post details, replies, quotes
│   │   │   └── ...
│   │   ├── components/  # UI components
│   │   ├── assets/      # Images, icons, fonts
│   │   ├── constants/   # App-wide constants
│   │   ├── context/     # React context providers
│   │   ├── features/    # Feature modules
│   │   ├── hooks/       # Custom React hooks
│   │   ├── interfaces/  # TypeScript interfaces
│   │   ├── lib/         # Library code
│   │   ├── locales/     # i18n translation files
│   │   ├── scripts/     # Utility scripts
│   │   ├── store/       # State management
│   │   ├── styles/      # Global styles and colors
│   │   └── utils/       # Utility functions
│   ├── backend/         # Node.js/Express API server
│   │   ├── src/         # Backend source code
│   │   │   ├── controllers/ # API controllers
│   │   │   ├── middleware/  # Express middleware
│   │   │   ├── models/      # MongoDB models
│   │   │   ├── routes/      # API routes
│   │   │   ├── scripts/     # Utility scripts
│   │   │   ├── sockets/     # WebSocket handlers
│   │   │   ├── types/       # TypeScript types
│   │   │   └── utils/       # Utility functions
│   │   └── ...
│   ├── agora/           # Agora audio/video spaces app (Expo)
│   ├── agora-shared/    # Shared utilities for Agora
│   ├── mcp/             # Remote MCP server for Claude (https://mcp.mention.earth)
│   └── shared-types/    # Shared TypeScript types
│       ├── src/         # Type definitions
│       └── dist/        # Compiled types
├── package.json         # Root package.json with workspaces
├── tsconfig.json        # Root TypeScript config
└── ...
```

## Getting Started

### Prerequisites
- Node.js 18+ and Bun 1.3+
- MongoDB instance
- Expo CLI for mobile development

### Initial Setup
1. **Clone the repository**
   ```bash
   git clone https://github.com/OxyHQ/Mention.git
   cd Mention
   ```

2. **Install all dependencies**
   ```bash
   bun install
   ```

### Development

#### Start All Services
```bash
bun run dev
```

#### Start Individual Services
```bash
# Frontend only
bun run dev:frontend

# Backend only
bun run dev:backend

# MCP HTTP server (requires backend on :3000)
bun run dev:mcp:http
```

#### Frontend Development
The frontend is an Expo React Native app that can run on:
- **Web**: `bun run --cwd packages/frontend web` (or `bun run dev:frontend` then press `w`)
- **iOS**: `bun run --cwd packages/frontend ios` (requires macOS and Xcode)
- **Android**: `bun run --cwd packages/frontend android` (requires Android Studio)

#### Backend Development
The backend runs on the development server with hot reload:
```bash
bun run dev:backend
```

## Development Scripts

### Root Level (Monorepo)
- `bun run dev` — Start all services in development mode
- `bun run dev:frontend` — Start frontend development server
- `bun run dev:backend` — Start backend development server
- `bun run dev:mcp` — Start local MCP server (stdio transport)
- `bun run dev:mcp:http` — Start local MCP HTTP server (matches production transport)
- `bun run build` — Build all packages
- `bun run build:shared-types` — Build shared types package
- `bun run build:frontend` — Build frontend for production
- `bun run build:backend` — Build backend for production
- `bun run test` — Run tests across all packages
- `bun run lint` — Lint all packages
- `bun run clean` — Clean all build artifacts
- `bun install` — Install dependencies for all packages

### Frontend (`@mention/frontend`)
- `bun run --cwd packages/frontend start` — Start Expo development server
- `bun run --cwd packages/frontend android` — Run on Android device/emulator
- `bun run --cwd packages/frontend ios` — Run on iOS simulator
- `bun run --cwd packages/frontend web` — Run in web browser
- `bun run --cwd packages/frontend build` — Build static web output
- `bun run --cwd packages/frontend lint` — Lint codebase
- `bun run --cwd packages/frontend clean` — Clean build artifacts

### Backend (`@mention/backend`)
- `bun run --cwd packages/backend dev` — Start development server with hot reload
- `bun run --cwd packages/backend build` — Build the project
- `bun run --cwd packages/backend start` — Start production server
- `bun run --cwd packages/backend test` — Run backend tests from the package root
- `bun run --cwd packages/backend clean` — Clean build artifacts
- `bun run --cwd packages/backend migrate` — Run database migrations outside production

### Shared Types (`@mention/shared-types`)
- `bun run --cwd packages/shared-types build` — Build TypeScript types
- `bun run --cwd packages/shared-types dev` — Watch and rebuild types
- `bun run --cwd packages/shared-types clean` — Clean build artifacts

## Documentation

### Project Documentation

All project documentation is available in the [`docs/`](./docs/) folder:

- [Mention System Overview](./docs/MENTION_SYSTEM_README.md) - Complete guide to the mention system
- [Mention Format Specification](./docs/MENTION_FORMAT_FINAL.md) - Final format summary for mentions
- [Mention Implementation](./docs/MENTION_IMPLEMENTATION_FINAL.md) - Implementation details
- [Notifications System](./docs/MENTION_NOTIFICATIONS.md) - Notification system documentation
- [Visual Guide](./docs/MENTION_VISUAL_GUIDE.md) - Visual design guide
- [Theming Guide](./docs/THEMING_REFACTOR_SUMMARY.md) - Complete theming system documentation
- [Theme Quick Reference](./docs/THEME_QUICK_REFERENCE.md) - Quick reference for developers
- [Theming Troubleshooting](./docs/THEMING_TROUBLESHOOTING.md) - Common theming issues and solutions
- [Compose Refactoring](./docs/COMPOSE_REFACTORING.md) - Compose screen architecture
- [Performance Optimizations](./docs/PERFORMANCE_OPTIMIZATIONS.md) - Performance best practices
- [Federation (ActivityPub)](./packages/backend/README.md#federation-activitypub--fediverse) - Fediverse federation setup, endpoints, and sync
- [MCP / Claude connector](./packages/mcp/README.md) - Remote MCP server, OAuth, multi-account bundles, deployment
- [Production deployment](./docs/AWS_DEPLOYMENT.md) - CI-gated AWS/ECS and Cloudflare Pages release flow

### API Documentation

The Mention API is a robust backend service built with Express.js and TypeScript, providing functionality for social media interactions including posts, user management, authentication, and real-time communications.

For detailed API information, see the [Backend README](packages/backend/README.md).

## Contributing

Contributions are welcome! Please open issues or pull requests for bug fixes, features, or improvements.

### Development Workflow
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting: `bun run test && bun run lint`
5. Submit a pull request

## License

This project is licensed under the MIT License.
