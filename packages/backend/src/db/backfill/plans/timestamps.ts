/**
 * The timestamp columns, copied — and the distinction between OMITTING a key
 * and writing `null`, which is the whole reason these are shared rather than
 * inlined per plan.
 *
 * `created_at` and `updated_at` are `NOT NULL` with a database default
 * (`@oxyhq/db`). That gives a transform three answers where a naive
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

import { date, id, type MongoDocument } from '../values';

/** A 24-character lowercase-hex ObjectId, whose first four bytes are a unix time. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;

/**
 * `created_at` DERIVED from the document's own `_id` when the field is absent,
 * plus `updated_at` copied as usual.
 *
 * ## Why this exists, measured rather than hypothesised
 *
 * Six posts of 577,526 in production have NO `createdAt` at all — absent, not
 * malformed. All six are federated, five of them one batch, which points at the
 * raw federated `insertMany` path. `posts.created_at` is `NOT NULL` **with a
 * DEFAULT**, so those six do not fail loudly: they silently take `now()`, which
 * dates them to the migration instant and puts them at the top of every
 * chronological feed on day one. That is the failure mode a defaulted column
 * has and a rejecting one does not.
 *
 * ## Why the `_id` and not `updatedAt`
 *
 * An ObjectId's first four bytes ARE a unix timestamp, so the creation time is
 * carried in the document's own primary key: in-document, deterministic,
 * identical on every re-run, and within a second of the truth. `updatedAt` is
 * the tempting alternative and is WRONG — on all six it is two weeks later
 * (almost certainly the media-cache rewrite), so it would misdate them by a
 * fortnight in the direction that matters.
 *
 * Second resolution is a real loss against a millisecond `createdAt`, and it is
 * the right trade: the alternative is not a more precise value, it is `now()`.
 *
 * @throws {Error} When `_id` is not ObjectId-shaped, so no time can be derived.
 *   Every collection using this has ObjectId keys; a caller-supplied string id
 *   (`moderation_outbox`, `engagement_outbox`) carries no time at all, and
 *   silently falling back to the database default would be the exact
 *   substitution this function exists to prevent.
 */
export function timestampsCreatedFromId(doc: MongoDocument): Record<string, unknown> {
  const createdAt = date(doc, 'createdAt');
  const updatedAt = date(doc, 'updatedAt');
  return {
    createdAt: createdAt ?? objectIdCreationTime(doc),
    ...(updatedAt === null ? {} : { updatedAt }),
  };
}

/** The unix time encoded in the first four bytes of an ObjectId `_id`. */
function objectIdCreationTime(doc: MongoDocument): Date {
  const hex = id(doc, '_id');
  if (hex === null || !OBJECT_ID_HEX.test(hex)) {
    throw new Error(
      `_id ${hex ?? 'absent'} is not ObjectId-shaped, so createdAt cannot be ` +
        'derived from it. The column is NOT NULL with a DEFAULT, so omitting it ' +
        "would silently stamp the migration's own clock on a row whose real " +
        'creation time is unknown.'
    );
  }
  // Seconds since the epoch, big-endian, in the first four bytes.
  return new Date(Number.parseInt(hex.slice(0, 8), 16) * 1000);
}

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
