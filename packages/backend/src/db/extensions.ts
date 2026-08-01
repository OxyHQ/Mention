/**
 * Postgres extensions this schema requires.
 *
 * The registry is DATA, with a reason per entry — the same shape as
 * `DEFERRED_FOREIGN_KEYS` and `PROTECTED_COLUMNS`, for the same reason: a rule a
 * reader can enumerate beats a rule spread across the files that happen to need
 * it.
 *
 * ## Why this is not a numbered migration
 *
 * An extension has to exist BEFORE the first statement that names a type it
 * provides. `posts.geo` and `posts.content_geo` are `geography` columns, so a
 * migration that creates them fails outright on a database with no PostGIS —
 * and it fails only on a FRESH database, which is precisely the shape that
 * passes on a developer's warm machine and then fails in CI or on a new RDS
 * instance.
 *
 * Putting `CREATE EXTENSION` in a numbered migration would answer that only for
 * as long as nobody renumbers, squashes or regenerates the sequence. Schema TS
 * is the source of truth here and migrations get regenerated centrally under
 * whatever number is correct, so anything that must be true before migration
 * 0000 cannot live INSIDE the numbered sequence at all.
 *
 * So it is a precondition of the migrator instead: `bun run db:migrate` runs
 * `ensureExtensions` before applying anything. That is the single migration
 * mechanism in this package — a developer, CI, and the vitest harness
 * (`db/testDatabase.ts` shells out to the same script) all go through it — so
 * there is no environment where the ordering can be wrong, and no migration
 * number that can be assigned wrongly.
 *
 * ## Why `IF NOT EXISTS` is the right spelling on a managed database
 *
 * `CREATE EXTENSION` normally needs a superuser (`rds_superuser` on RDS), which
 * the application's migration role may not have. `IF NOT EXISTS` short-circuits
 * on the duplicate check BEFORE any privilege check, so once the extension is
 * installed — by infrastructure, by the master user, once — this step is a
 * NOTICE and a no-op for an unprivileged role.
 *
 * ## The trap the docker image does NOT cover
 *
 * `postgis/postgis` seeds PostGIS into `$POSTGRES_DB` and into a
 * `template_postgis` template — NOT into `template1`. Every throwaway test
 * database is `create database "mention_test_…"` with no TEMPLATE clause, i.e.
 * from `template1`, so it lands WITHOUT PostGIS. Running the right image is
 * necessary and not sufficient; this step is what makes each new database
 * usable.
 */

import postgres from 'postgres';

/** Seconds the one-shot admin connection waits before forcing itself shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

/**
 * Extension names are interpolated into DDL (`CREATE EXTENSION` takes no bound
 * parameter), so the vocabulary is constrained to what a real extension name can
 * contain. Every entry below is a literal in this file; the guard exists so a
 * future entry read from anywhere else cannot become an injection site.
 */
const EXTENSION_NAME = /^[a-z][a-z0-9_]*$/;

export interface RequiredExtension {
  /** The `CREATE EXTENSION` name. */
  readonly name: string;
  /** What in this schema stops working without it. */
  readonly reason: string;
}

/**
 * Every extension the schema depends on. An entry here is a claim that some
 * column, index or constraint does not exist without it — not a convenience.
 */
export const REQUIRED_EXTENSIONS: readonly RequiredExtension[] = [
  {
    name: 'postgis',
    reason:
      '`posts.geo` and `posts.content_geo` are generated `geography` point ' +
      'columns with GiST indexes, replacing the two Mongo `2dsphere` indexes ' +
      'that `posts.controller.ts` `$near`/`$geoWithin` and the `nearby` feed ' +
      'source query. `geography`, `ST_MakePoint`, `ST_DWithin` and ' +
      '`ST_Distance` all come from PostGIS.',
  },
];

/**
 * Create every required extension on `databaseUrl`, in one short-lived
 * connection.
 *
 * Idempotent by construction (`IF NOT EXISTS`), so it is safe to run before
 * every migration rather than only on a fresh database.
 *
 * @throws {Error} When an extension is unavailable in the server's
 *   installation, or the role may not create it and nobody has installed it
 *   already. Both are environment faults that must stop the migration rather
 *   than let it fail later with a confusing `type "geography" does not exist`.
 */
export async function ensureExtensions(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    for (const extension of REQUIRED_EXTENSIONS) {
      if (!EXTENSION_NAME.test(extension.name)) {
        throw new Error(
          `Refusing to create extension "${extension.name}": an extension name ` +
          'must match /^[a-z][a-z0-9_]*$/.'
        );
      }
      try {
        await client.unsafe(`create extension if not exists "${extension.name}"`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not ensure the "${extension.name}" extension: ${detail}\n` +
          `It is required because ${extension.reason}\n` +
          'Locally and in CI this means the Postgres image must ship it ' +
          '(docker-compose.postgres.yml and .github/workflows both use ' +
          'postgis/postgis:17-3.5). On a managed database, a role with ' +
          'sufficient privilege must run `CREATE EXTENSION` once; after that ' +
          'this step is a no-op for the migration role.'
        );
      }
    }
  } finally {
    await client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
  }
}
