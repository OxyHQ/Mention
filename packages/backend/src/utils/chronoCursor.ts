/**
 * The ONE `(created_at, id)` cursor and keyset behind every list that pages on
 * the chronological axis — feeds, notifications, search, likes, bookmarks,
 * subscriptions, follows, reports, applications, private mentions, channel
 * writers. A list chooses its two columns; the token, its validation and the
 * SQL comparison are this file's.
 *
 * ## Why the pair, and not the id alone
 *
 * `id` is `text` holding a 24-char ObjectId hex for pre-cutover rows and a uuid
 * v7 after, and `'0' < '6'` under the database's collation, so `order by id
 * desc` sorts EVERY post-cutover row below every pre-cutover one. `created_at`
 * is the real axis. It is not unique, though: it defaults to
 * `date_trunc('milliseconds', now())` and `now()` is `transaction_timestamp()`,
 * so a fan-out written in one transaction shares it exactly. The id makes the
 * order TOTAL; that its collation order is surprising across the two shapes does
 * not matter for a tiebreak, because the ORDER BY and the keyset use the same
 * comparison.
 *
 * ## Milliseconds, end to end
 *
 * The token carries epoch MILLISECONDS, the precision a JS `Date` holds and the
 * precision every `created_at` default writes (`@oxy.so/db`'s `createdAt()`;
 * `posts` also enforces it with a CHECK). A microsecond value would compare
 * SMALLER than the row it came from and the keyset would skip or repeat at the
 * boundary — which is why the bound is the token's instant, cast once, rather
 * than anything recomputed from the row.
 *
 * ## The forms a client may still hold
 *
 * Every list used to mint its own spelling. Tokens already handed out keep
 * decoding, whichever list receives them:
 *
 *   `<epochMs>:<id>`      the form minted now (and always, by the feeds)
 *   `<id>`                a feed cursor from before it carried a timestamp
 *   `v1.<base64url json>` notifications, search, bookmarks, memberships, DMs
 *   `<ISO 8601>|<id>`     follows, reports, job applications
 *   `<epochMs>_<id>`      subscriptions, channel writers
 *
 * Only `posts` can recover the instant a bare `<id>` lacks (`chronoCursorBoundary`
 * in `mtn/feed/CursorBuilder.ts`), so {@link decodeChronoCursor} — the strict
 * decoder every other list uses — refuses it.
 *
 * ## Why the id shape comes from `@oxy.so/db`
 *
 * {@link isLiveEntityId} is the ONE place either id shape is spelled out. A token
 * is not a lookup key: it is something this server minted, and the question is
 * whether it is well-formed enough to become a KEYSET BOUND. Narrowing it to the
 * shapes the database can mint is what makes a malformed cursor a clean refusal
 * rather than a query with a garbage bound — never widen it to "any string".
 */

import { isLiveEntityId } from '@oxy.so/db';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** Where a chronological page continues from. */
export interface ChronoAnchor {
  createdAt: Date;
  id: string;
}

/**
 * Which way a chronological page runs. Lists read newest-first; the replies list
 * is the one a reader can flip to oldest-first, and the keyset has to flip WITH
 * it — a descending bound behind an ascending sort re-serves page one forever.
 */
export type ChronoDirection = 'asc' | 'desc';

/** The two columns (or, for a grouped list, expressions) a list orders on. */
export interface ChronoAxis {
  createdAt: SQLWrapper;
  id: SQLWrapper;
}

const MAX_CURSOR_LENGTH = 512;
const V1_PREFIX = 'v1.';
const MAX_DATE_MS = 8_640_000_000_000_000;

function instant(ms: number): Date | undefined {
  return Number.isSafeInteger(ms) && Math.abs(ms) <= MAX_DATE_MS ? new Date(ms) : undefined;
}

/**
 * Encode where the next page continues. THROWS on an axis no row can have — the
 * caller passes a row it just read, so this is a programming error, not input.
 */
export function encodeChronoCursor(createdAt: Date | string, id: string): string {
  const ms = new Date(createdAt).getTime();
  if (!instant(ms)) throw new Error('Cannot encode a chrono cursor with an invalid createdAt');
  if (!isLiveEntityId(id)) throw new Error('Cannot encode a chrono cursor with an invalid id');
  return `${ms}:${id}`;
}

/**
 * Parse any form this server has ever minted (see the module doc). `createdAt`
 * is absent only for a bare `<id>`; anything unrecognised is `undefined`.
 */
export function parseChronoCursor(
  cursor: string | undefined,
): { createdAt?: Date; id: string } | undefined {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH) return undefined;
  if (cursor.startsWith(V1_PREFIX)) return parseV1(cursor.slice(V1_PREFIX.length));
  if (isLiveEntityId(cursor)) return { id: cursor };

  // `|` first: the ISO form's timestamp itself contains `:`.
  const iso = cursor.indexOf('|');
  const separator = iso >= 0 ? iso : cursor.search(/[:_]/);
  if (separator <= 0) return undefined;
  const at = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  if (!isLiveEntityId(id)) return undefined;

  const createdAt =
    iso >= 0 ? instant(Date.parse(at)) : /^-?\d+$/.test(at) ? instant(Number(at)) : undefined;
  return createdAt ? { createdAt, id } : undefined;
}

function parseV1(encoded: string): ChronoAnchor | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      v?: unknown;
      t?: unknown;
      i?: unknown;
    };
    const createdAt = typeof parsed.t === 'number' && parsed.t >= 0 ? instant(parsed.t) : undefined;
    if (parsed.v !== 1 || !createdAt || !isLiveEntityId(parsed.i)) return undefined;
    // The v1 encoder lowercased the id, so its decoder did too.
    return { createdAt, id: (parsed.i as string).toLowerCase() };
  } catch {
    return undefined;
  }
}

/**
 * The strict decoder: a cursor that names its instant, or `undefined`. What a
 * list does with `undefined` (400, or page one) is that list's documented
 * contract and stays at the call site.
 */
export function decodeChronoCursor(cursor: string | undefined): ChronoAnchor | undefined {
  const parsed = parseChronoCursor(cursor);
  return parsed?.createdAt ? { createdAt: parsed.createdAt, id: parsed.id } : undefined;
}

/**
 * The keyset predicate continuing a `(created_at, id)` page past `anchor`, for a
 * list ordered `created_at <direction>, id <direction>`.
 *
 * A ROW comparison, deliberately, not `created_at < x OR (created_at = x AND id
 * < y)`: the two are the same predicate over NOT NULL columns, but only the row
 * form is a single index range on a `(…, created_at, id)` btree, so the bound
 * starts the scan instead of filtering every newer row.
 *
 * Both bounds are bound as STRINGS with explicit casts. The postgres.js driver
 * setup disables its timestamp serializer, so a bare `Date` inside a raw `sql`
 * template reaches the socket writer unconverted and the query dies with
 * `ERR_INVALID_ARG_TYPE` — on the SECOND page only, since the first carries no
 * cursor. The cast also lets `axis` be an aggregate (`max(created_at)`), which
 * has no column encoder to borrow.
 */
export function chronoKeyset(
  axis: ChronoAxis,
  anchor: ChronoAnchor,
  direction: ChronoDirection = 'desc',
): SQL {
  const beyond = sql.raw(direction === 'asc' ? '>' : '<');
  return sql`(${axis.createdAt}, ${axis.id}) ${beyond} (${anchor.createdAt.toISOString()}::timestamptz, ${anchor.id}::text)`;
}
