# Backend

Express 5 API on Bun with PostgreSQL (Drizzle) and Redis. Root rules in `../../AGENTS.md` apply.

## Commands

Run from `packages/backend`.

```bash
bun run dev              # bun --watch server.ts
bun run lint             # tsc --noEmit
bun run test             # vitest and bun test halves
bun run test:vitest      # or test:bun; pass a file filter to the runner that owns the file
bun run db:generate      # new Drizzle migration
bun run db:migrate
bun run db:rebase-migrations   # after rebasing onto a main with newer migrations
```

## Conventions

- A `*.test.ts` importing `bun:test` runs under `bun test` and is excluded from Vitest (`testRunnerSplit.ts` is the one rule). In those files `mock.module` is not hoisted: register it before dynamically importing the module under test.
- Migrations are checked by `db:check-locks` on hot tables; avoid long locks there.
- Rebuild `shared-types` first; it is consumed through its built `dist`.
- More: [docs/development.md](../../docs/development.md), [docs/api.mdx](../../docs/api.mdx).
