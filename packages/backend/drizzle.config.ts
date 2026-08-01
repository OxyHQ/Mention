import { defineConfig } from 'drizzle-kit';
import { DATABASE_CASING } from './src/db/casing';

/**
 * drizzle-kit configuration.
 *
 * - `bun run db:generate` diffs `schema` against `out/` and writes a new SQL
 *   migration. It never opens a database, and it only ever runs on a
 *   developer's machine.
 * - Migrations are APPLIED by `bun run db:migrate` (`src/db/migrate.ts`), which
 *   uses drizzle-orm's own migrator over the files in `out/` — not
 *   `drizzle-kit migrate`. drizzle-kit is a devDependency and the shipped image
 *   installs production dependencies only, so the CLI could never apply a
 *   migration in production. Dev, CI, the vitest harness and production all run
 *   that one migrator; see its docblock.
 *
 * `casing` decides what the DDL CREATES; the same value passed to `drizzle()` in
 * `src/db/postgres.ts` decides what queries REFERENCE. Both read it from
 * `src/db/casing.ts` so they cannot drift apart.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is required by drizzle-kit. Start a local Postgres with:\n' +
    '  docker compose -f ../../docker-compose.postgres.yml up -d postgres\n' +
    'then set DATABASE_URL in packages/backend/.env.'
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  casing: DATABASE_CASING,
  strict: true,
  verbose: true,
  dbCredentials: { url },
});
