/**
 * The two shapes a Mention entity id can have.
 *
 * `CONVENTIONS.md` fixes primary keys as `text` holding a 24-char ObjectId hex
 * for every row that existed before the cutover and a uuid v7 for every row
 * created after it. Both are live simultaneously and permanently — the backfill
 * copies `_id` verbatim, so a post from 2024 keeps its ObjectId forever.
 *
 * ## This is for a 400, and nothing else
 *
 * Almost every `isValidObjectId` call in the Mongoose codebase existed only to
 * dodge a `CastError`, and those get DELETED rather than widened: a `text` id
 * that matches no row already produces the "no such thing" answer the caller
 * wanted, whereas the guard's `false` branch routinely meant "allowed" or "not
 * found" and silently disabled the check it stood in front of.
 *
 * What survives is the handful of places where rejecting a malformed id is a
 * documented API contract the client relies on — `middleware/validate.ts`
 * `validateObjectId` is the one that fans out to real routes. Reach for this
 * ONLY there. Using it as a precondition on a query is the fail-open bug in a
 * new costume: it re-introduces a branch that answers "no" for a perfectly valid
 * id of the shape the code has not been taught about yet.
 *
 * A `uuid` column type is deliberately not used anywhere in the schema, so this
 * predicate is the ONLY place either shape is spelled out.
 */

/** A 24-character MongoDB ObjectId, hex, case-insensitive. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/**
 * RFC 9562 UUID version 7, as `uuidv7()` in `schema/columns.ts` emits it.
 *
 * The version nibble (`7`) and variant bits (`8`/`9`/`a`/`b`) are pinned rather
 * than accepting any UUID: nothing in this schema generates a v4, so a v4
 * arriving on a route is a client error worth rejecting, not an id to look up.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Whether `value` could name a row — i.e. it is one of the two id shapes this
 * database actually stores.
 *
 * `true` is NOT "this row exists"; it is only "this is not obviously malformed".
 * The existence question is the query's to answer.
 */
export function isLiveEntityId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return OBJECT_ID_HEX.test(value) || UUID_V7.test(value);
}
