/**
 * The opaque `(createdAt, id)` token behind every keyset-paginated list that
 * pages newest-first — `GET /search?type=posts` and `GET /notifications`.
 *
 * ## Why the pair, and not the id alone
 *
 * An id-only cursor is only correct when `id DESC` is the chronological order,
 * and it stopped being that at the cutover: `id` is `text` holding a 24-char
 * ObjectId hex for pre-cutover rows and a uuid v7 after, and `'0' < '6'` under
 * the database's collation, so `order by id desc` sorts EVERY post-cutover row
 * below every pre-cutover one. The list opens on the oldest rows and new
 * activity is unreachable until the reader pages past the entire pre-cutover
 * backlog. `created_at` is the real axis; `id` remains in the token because
 * `created_at` alone is not unique — see the tiebreak note below.
 *
 * ## Why `id` is still in it
 *
 * `created_at` defaults to `date_trunc('milliseconds', now())`, so rows written
 * in one millisecond — or, since `now()` is `transaction_timestamp()`, anywhere
 * in one transaction — share it exactly. A cursor on `created_at` alone would
 * either repeat or skip every row in such a group at a page boundary. The id
 * makes the order TOTAL; that its collation order is surprising across the two
 * shapes does not matter for a tiebreak, because the ORDER BY and the keyset
 * comparison use the same comparison and therefore agree.
 *
 * ## Why the id shape comes from `@oxyhq/db`
 *
 * This used to carry its own `/^[a-f0-9]{24}$/` — an ObjectId check, written
 * when every `_id` was one. Primary keys are `text` now, holding a 24-char
 * ObjectId hex for pre-cutover rows and a **uuid v7** for everything created
 * after (`db/schema/CONVENTIONS.md`), and the pattern had become a live break
 * rather than an obsolete one: `encodeChronoCursor` THROWS on an id it does not
 * recognise, so the first page whose last row was created after the cutover
 * returned a 500 instead of paginating. Every paginated search, in other words.
 *
 * {@link isLiveEntityId} is the ONE place either shape is spelled out, so this
 * narrows automatically when the ObjectId half is eventually retired — the two
 * live shapes are a cutover fact, not a permanent one. Hardcoding the shape
 * again here is the same root cause as the `order by id desc` hazard: code that
 * knows what an id LOOKS like instead of treating it as opaque.
 *
 * Reaching for that predicate is deliberate and is not the misuse its own doc
 * warns about. That warning is against using it as a PRECONDITION ON A QUERY,
 * where a `false` branch silently means "allowed" or "not found". Here the value
 * is not a lookup key: it is a token this server minted, and the question is
 * whether it is well-formed enough to become a KEYSET BOUND. Validation is what
 * makes a malformed cursor a clean 400 rather than a query with a garbage bound,
 * so it is narrowed to the shapes the database can actually mint — never
 * widened to "any non-empty string".
 */

import { isLiveEntityId } from '@oxyhq/db';

const CHRONO_CURSOR_VERSION = 1;
const CHRONO_CURSOR_PREFIX = `v${CHRONO_CURSOR_VERSION}.`;
const MAX_CURSOR_LENGTH = 512;

interface EncodedChronoCursor {
  v: typeof CHRONO_CURSOR_VERSION;
  t: number;
  i: string;
}

export interface ChronoCursorData {
  createdAt: Date;
  id: string;
}

/**
 * Encode the stable chronological axis as an opaque, versioned token.
 * The version prefix allows a future cursor migration to fail explicitly
 * instead of silently applying an incompatible filter.
 */
export function encodeChronoCursor(
  createdAt: Date | string,
  id: string,
): string {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('Cannot encode a chrono cursor with an invalid createdAt');
  }
  if (!isLiveEntityId(id)) {
    throw new Error('Cannot encode a chrono cursor with an invalid id');
  }

  const payload: EncodedChronoCursor = {
    v: CHRONO_CURSOR_VERSION,
    t: timestamp,
    i: id.toLowerCase(),
  };
  return `${CHRONO_CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

/**
 * Decode a cursor without throwing. Invalid, oversized, legacy, or unknown
 * versions return undefined so the route can reject them as a bad request.
 */
export function decodeChronoCursor(cursor: string): ChronoCursorData | undefined {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH
      || !cursor.startsWith(CHRONO_CURSOR_PREFIX)) {
    return undefined;
  }

  const encoded = cursor.slice(CHRONO_CURSOR_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<EncodedChronoCursor>;
    if (parsed.v !== CHRONO_CURSOR_VERSION
        || !Number.isSafeInteger(parsed.t)
        || (parsed.t as number) < 0
        // The `typeof` is what NARROWS `i` for the `toLowerCase()` below —
        // `isLiveEntityId` takes `unknown` and returns a plain boolean, not a
        // type predicate, so it cannot do that job on its own.
        || typeof parsed.i !== 'string'
        || !isLiveEntityId(parsed.i)) {
      return undefined;
    }

    return {
      createdAt: new Date(parsed.t as number),
      id: parsed.i.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}
