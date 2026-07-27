# @mention/shared-types

Canonical TypeScript contracts shared by the Mention frontend, backend, and
MCP workspaces.

## Rules

- This package contains transport and domain contracts, not application logic.
- Prefer a published subpath over the root barrel in runtime code. Type-only
  imports from the barrel are erased by TypeScript and are safe.
- Add a subpath export before importing a new runtime module from another
  workspace.
- Keep viewer-specific state in `PostViewerState`; do not add top-level
  `isLiked`, `isSaved`, `handle`, `avatarUrl`, or similar compatibility fields.
- Oxy remains the authority for user identity. `PostUser` is the canonical
  embedded identity shape.

## Public exports

The package publishes the root entry and focused entries including:

- `@mention/shared-types/post`
- `@mention/shared-types/feed`
- `@mention/shared-types/interaction`
- `@mention/shared-types/notification`
- `@mention/shared-types/profile`
- `@mention/shared-types/language`
- `@mention/shared-types/externalEmbeds`
- `@mention/shared-types/mtn/*`

The exact export map is declared in `package.json`.

## Commands

Run these from the repository root:

```bash
bun run build:shared-types
bun run test:shared-types
bun run lint:shared-types
```

Or from this directory:

```bash
bun run build
bun run test
bun run lint
```

The test command runs the real Bun test suite; it is not a placeholder.
