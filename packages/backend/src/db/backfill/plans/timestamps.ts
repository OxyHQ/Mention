/**
 * The timestamp columns, copied — and the distinction between OMITTING a key
 * and writing `null`, which is the whole reason these are shared rather than
 * inlined per plan.
 *
 * `created_at` and `updated_at` are `NOT NULL` with a database default
 * (`db/schema/columns.ts`). That gives a transform three answers where a naive
 * port sees two:
 *
 * - **Copy the source value.** What every document that has one gets, and the
 *   only answer that preserves history. `schema/CONVENTIONS.md` names this as
 *   why `updated_at` is maintained by the application rather than by a trigger:
 *   a trigger would fire during the backfill and stamp every migrated row with
 *   the migration's own clock.
 * - **OMIT the key**, letting the default apply. The right answer for a document
 *   written before the field existed.
 * - **Write `null`** — refused by the column, and never what anyone means.
 *
 * `buildRow` rejects `undefined` precisely so a transform cannot fall into the
 * gap between the first two by accident; these functions are where the choice is
 * made, once, for every plan.
 *
 * ## Which of the three shapes a collection has is a fact about its MODEL
 *
 * Not every Mention model declares `{ timestamps: true }`. `pokes` and `mutes`
 * declare `createdAt` by hand and have no `updatedAt` at all; `trending` is the
 * mirror image, with a hand-declared `updatedAt` and no `createdAt`; and
 * `trendbatches` has neither. Their tables match, so reading a field a model
 * never wrote would INVENT a timestamp — which is why there is a function per
 * shape rather than one function that shrugs.
 */

import { date, type MongoDocument } from '../values';

/** `created_at` + `updated_at` — for a model with `{ timestamps: true }`. */
export function timestamps(doc: MongoDocument): Record<string, unknown> {
  const createdAt = date(doc, 'createdAt');
  const updatedAt = date(doc, 'updatedAt');
  return {
    ...(createdAt === null ? {} : { createdAt }),
    ...(updatedAt === null ? {} : { updatedAt }),
  };
}

/** `created_at` alone — for a model that declares no `updatedAt`. */
export function createdOnly(doc: MongoDocument): Record<string, unknown> {
  const createdAt = date(doc, 'createdAt');
  return createdAt === null ? {} : { createdAt };
}

/** `updated_at` alone — for a model whose table has no `created_at` column. */
export function updatedOnly(doc: MongoDocument): Record<string, unknown> {
  const updatedAt = date(doc, 'updatedAt');
  return updatedAt === null ? {} : { updatedAt };
}

/**
 * Any OTHER `NOT NULL DEFAULT` date column, omitted when the source has none.
 *
 * `at`, `last_seen_at`, `last_used_at` and friends are the same three-answer
 * problem under a different name, so they get the same treatment rather than a
 * `?? new Date()` at the call site — which would stamp the migration's clock on
 * exactly the rows whose history is missing.
 */
export function optionalDate(
  doc: MongoDocument,
  path: string,
  property: string
): Record<string, unknown> {
  const value = date(doc, path);
  return value === null ? {} : { [property]: value };
}
