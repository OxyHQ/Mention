import { sql, type SQL } from 'drizzle-orm';

/**
 * Render a ranking weight as a SQL `double precision` LITERAL.
 *
 * Not a bound parameter, and this is not a style choice. Drizzle infers a bound
 * parameter's type from the expression it sits next to, so
 * `${posts.statsBoostsCount} * ${2.5}` declares `$n` as `int4` — from the
 * COLUMN — and Postgres then rejects the value with
 * `invalid input syntax for type integer: "2.5"`. Every ranking weight is
 * fractional, so the whole composite fails at RUNTIME while compiling and
 * type-checking perfectly.
 *
 * The cast has to be on the LITERAL rather than on the surrounding expression:
 * a parameter's type is fixed at Parse time, before any outer `::double
 * precision` is reached.
 *
 * `sql.raw` is safe here and only here because the input is a number from a
 * compile-time config object, never user input — and the guard makes that a
 * checked property rather than an assumption.
 *
 * ## Why it lives in a module of its own
 *
 * It was in `utils/feedQueryBuilder.ts`, which imports the `posts` and
 * `post_media` tables. `db/schema/posts.ts` now needs this function too — the
 * engagement-rank INDEX is declared there and has to be spelled with the same
 * literals the query uses, or Postgres will not match the two. Importing the
 * query builder from the schema would close a cycle (schema → query builder →
 * schema), so the shared half moved out to a leaf that imports nothing but
 * drizzle. Copying the one-line cast into the schema instead is the option this
 * rejects: two spellings of a rule whose whole job is that both sides render
 * identically is the drift the index cannot survive.
 */
export function rankingWeight(value: number): SQL {
  if (!Number.isFinite(value)) {
    throw new Error(`Ranking weight must be a finite number, received ${String(value)}`);
  }
  return sql.raw(`${value}::double precision`);
}
