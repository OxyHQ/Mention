/**
 * Centralized cursor handling for all feed types.
 * Replaces ad-hoc cursor parsing duplicated across strategies.
 *
 * ## Why `isLiveEntityId` and not an ObjectId check
 *
 * Every id validation here used to be `mongoose.Types.ObjectId.isValid`. That is
 * now actively WRONG rather than merely obsolete: primary keys are `text`
 * holding a 24-char ObjectId hex for pre-cutover rows and a **uuid v7** for
 * everything created after (`db/schema/CONVENTIONS.md`). An ObjectId check
 * rejects every uuid v7, so the moment the first post-cutover post anchors a
 * page, the cursor is silently discarded and the client is handed page ONE —
 * forever, with `hasMore: true`. An infinite-scroll loop that never advances.
 *
 * `isLiveEntityId` is reached for deliberately, and it is worth saying why this
 * is not the misuse its own doc warns about. That warning is against using it as
 * a PRECONDITION ON A QUERY, where a `false` branch silently means "allowed" or
 * "not found" and a text id that matches no row already gives the right answer.
 * Here the value is not a lookup key at all: it is an opaque token the server
 * minted, and the question is whether it is well-formed enough to become a
 * KEYSET BOUND. A malformed one must reset to page one, which is exactly what
 * rejecting it does.
 */

import { isLiveEntityId } from '@oxyhq/db';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema';
import { and, eq, gt, lt, or, sql, type SQL } from 'drizzle-orm';

// --- Score-based cursor (for ranked feeds: for_you, explore) ---

export interface ScoreCursorData {
  score: number;
  id: string;
  /**
   * Millisecond timestamp used as the stable recency-scoring reference for the
   * whole pagination session. Absent on legacy cursors.
   */
  asOf?: number;
  /**
   * Bounded rolling ids from recent pages. This is deliberately not an
   * ever-growing seen set: it protects page boundaries from mutable engagement
   * while keeping cursor size and server state bounded.
   */
  excludeIds?: string[];
  /**
   * `createdAt` of the cursor item, in milliseconds. Present only for sorts whose
   * SECOND key is `createdAt` — the popular sources, whose score carries no
   * recency component and therefore ties in bulk (every zero-engagement post
   * scores the same), so `createdAt` is load-bearing in their ordering rather
   * than decorative. A keyset needs a value for every key it orders on, so those
   * sources cannot paginate without it.
   *
   * Absent on a score whose ties are effectively unique (`explore`'s
   * recency-decayed `finalScore`), and absent on every legacy cursor.
   */
  tiebreakAt?: number;
  /**
   * Set only on a cursor minted by the POPULAR FALLBACK, whose `score` is an
   * `engagementScore` — a weighted sum of likes/boosts/comments, 0 for most posts
   * and unbounded above. Every other cursor's `score` is a `finalScore`, a product
   * of near-1 ranking signals. The two are not comparable, and a `neverBlank` feed
   * hands cursors back and forth between the regimes that produce them, so the
   * reader has to be able to tell which quantity it is holding.
   *
   * ABSENCE MEANS "not the fallback", deliberately, rather than a second state
   * being written: the ranked path mints the LEGACY `score:id` form for every
   * non-pre-scored feed (`FeedEngine` only supplies `asOf` when `exec.preScored`),
   * and that form has no metadata envelope to stamp. So absence is the only signal
   * a ranked cursor can carry, and it already covers legacy cursors too — both
   * mean "compare this against a ranking score".
   */
  fromPopularFallback?: true;
}

export interface ScoreCursorBuildOptions {
  asOf?: Date | number;
  excludeIds?: Iterable<string>;
  /** See {@link ScoreCursorData.tiebreakAt}. */
  tiebreakAt?: Date | number;
  /** See {@link ScoreCursorData.fromPopularFallback}. */
  fromPopularFallback?: boolean;
}

const SCORE_CURSOR_V1_MARKER = '~v1~';
const MAX_SCORE_CURSOR_EXCLUDE_IDS = 100;
const MAX_ENCODED_SCORE_CURSOR_LENGTH = 8192;
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;
const MAX_SCORE_CURSOR_FUTURE_SKEW_MS = 5 * 60 * 1000;

interface ScoreCursorCompatV1Payload {
  a: number;
  x?: string[];
  /** See {@link ScoreCursorData.tiebreakAt}. Additive: an older parser ignores it. */
  t?: number;
  /** See {@link ScoreCursorData.fromPopularFallback}. Additive: an older parser ignores it. */
  f?: 1;
}

/** A millisecond timestamp we are willing to treat as a keyset boundary. */
function isValidCursorTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_JAVASCRIPT_DATE_MS
  );
}

function isValidScoreCursorAsOf(value: unknown): value is number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_JAVASCRIPT_DATE_MS
  ) {
    return false;
  }
  // Old pagination sessions remain valid: expiring a syntactically valid
  // cursor by wall clock would silently turn a resumed page request into page
  // one and reintroduce duplicates. The candidate window is bounded around
  // this timestamp, so accepting an older snapshot cannot broaden the query.
  return value <= Date.now() + MAX_SCORE_CURSOR_FUTURE_SKEW_MS;
}

function normalizeExcludedIds(id: string, ids?: Iterable<string>): string[] {
  const unique = new Set<string>();
  if (isLiveEntityId(id)) unique.add(id);
  if (ids) {
    for (const candidate of ids) {
      if (unique.size >= MAX_SCORE_CURSOR_EXCLUDE_IDS) break;
      if (isLiveEntityId(candidate)) unique.add(candidate);
    }
  }
  return Array.from(unique);
}

export const ScoreCursor = {
  build(score: number, id: string, options?: ScoreCursorBuildOptions): string {
    const rawAsOf = options?.asOf instanceof Date ? options.asOf.getTime() : options?.asOf;
    if (
      Number.isFinite(score)
      && isLiveEntityId(id)
      && isValidScoreCursorAsOf(rawAsOf)
    ) {
      const rawTiebreakAt = options?.tiebreakAt instanceof Date
        ? options.tiebreakAt.getTime()
        : options?.tiebreakAt;
      const metadata: ScoreCursorCompatV1Payload = {
        a: rawAsOf,
        x: normalizeExcludedIds(id, options?.excludeIds),
        ...(isValidCursorTimestamp(rawTiebreakAt) ? { t: rawTiebreakAt } : {}),
        ...(options?.fromPopularFallback === true ? { f: 1 } : {}),
      };
      const encoded = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url');
      // Keep the ObjectId after the first colon and the full-precision score at
      // the beginning. The previous backend's `parseFloat(scorePart)` therefore
      // still reads this cursor after a rollback, while the new parser restores
      // the versioned snapshot metadata.
      return `${String(score)}${SCORE_CURSOR_V1_MARKER}${encoded}:${id}`;
    }

    // Legacy-compatible output for ranked feeds that do not opt into a stable
    // scoring snapshot. String(number) preserves the full IEEE-754 round-trip;
    // the previous toFixed(6) truncated the pagination watermark.
    return `${String(score)}:${id}`;
  },

  parse(cursor?: string): ScoreCursorData | undefined {
    if (!cursor) return undefined;

    if (cursor.includes(':')) {
      const colonIdx = cursor.indexOf(':');
      const scoreStr = cursor.slice(0, colonIdx);
      const id = cursor.slice(colonIdx + 1);
      const markerIdx = scoreStr.indexOf(SCORE_CURSOR_V1_MARKER);
      const numericScore = markerIdx >= 0 ? scoreStr.slice(0, markerIdx) : scoreStr;
      const score = Number(numericScore);
      if (Number.isFinite(score) && id && isLiveEntityId(id)) {
        if (markerIdx >= 0) {
          const encoded = scoreStr.slice(markerIdx + SCORE_CURSOR_V1_MARKER.length);
          if (!encoded || encoded.length > MAX_ENCODED_SCORE_CURSOR_LENGTH) return undefined;
          try {
            const metadata = JSON.parse(
              Buffer.from(encoded, 'base64url').toString('utf8'),
            ) as Partial<ScoreCursorCompatV1Payload>;
            if (!isValidScoreCursorAsOf(metadata.a)) return undefined;
            return {
              score,
              id,
              asOf: metadata.a,
              ...(isValidCursorTimestamp(metadata.t) ? { tiebreakAt: metadata.t } : {}),
              ...(metadata.f === 1 ? { fromPopularFallback: true as const } : {}),
              excludeIds: normalizeExcludedIds(
                id,
                Array.isArray(metadata.x)
                  ? metadata.x.filter((value): value is string => typeof value === 'string')
                  : undefined,
              ),
            };
          } catch {
            return undefined;
          }
        }
        return { score, id, excludeIds: [id] };
      }
    }

    // Fallback: plain ObjectId
    if (isLiveEntityId(cursor)) {
      return { score: Infinity, id: cursor, excludeIds: [cursor] };
    }

    return undefined;
  },
};

// --- Chronological cursor (for following, author, custom, list, hashtag, saved) ---

export const ChronoCursor = {
  build(id: string, createdAt?: Date | string): string {
    if (createdAt) {
      return `${new Date(createdAt).getTime()}:${id}`;
    }
    return id;
  },

  parse(cursor?: string): { id: string; ts?: number } | undefined {
    if (!cursor) return undefined;

    const parts = cursor.split(':');
    if (parts.length === 2 && isLiveEntityId(parts[1])) {
      const ts = Number(parts[0]);
      if (!Number.isNaN(ts)) {
        return { id: parts[1], ts };
      }
    }

    if (isLiveEntityId(cursor)) {
      return { id: cursor };
    }
    return undefined;
  },
};

/**
 * The keyset predicate continuing a chronological page, matching the
 * `(created_at DESC, id DESC)` order every chronological source uses.
 *
 * ## Why this is async, and why the timestamp is not optional
 *
 * Mongo's `applyToQuery` had a second branch: given a cursor carrying only an
 * id, it filtered `_id < cursorId` and let the `{_id: -1}` sort agree with it.
 * That worked because an ObjectId ENCODES its creation time, so id order was
 * time order.
 *
 * Neither half of that survives. `posts.id` is `text` holding an ObjectId hex OR
 * a uuid v7, and those spaces interleave under text collation, so `id < X` is
 * not a time bound and `ORDER BY id DESC` is not a time order. Translating that
 * branch literally would page a feed in arbitrary order and skip rows on every
 * boundary — silently, looking like a ranking change.
 *
 * Two honest options remained for a timestamp-less cursor: ignore it (resetting
 * an old client to page one forever) or RECOVER the missing key. This does the
 * latter — one primary-key lookup fetches the anchor's `created_at` and the full
 * two-key keyset is then expressible. Legacy cursors keep paginating correctly
 * instead of silently restarting, at the cost of one indexed lookup on the rare
 * path that has no timestamp. Every cursor `FeedEngine` mints carries one, so
 * the lookup is the exception, not the hot path.
 *
 * Returns `undefined` when there is no cursor, or when the cursor names a row
 * that no longer exists — a deleted anchor cannot bound anything, and page one
 * is the correct answer rather than an empty page forever.
 */
export async function chronoCursorSql(
  cursor?: string,
  direction: ChronoDirection = 'desc',
): Promise<SQL | undefined> {
  const parsed = ChronoCursor.parse(cursor);
  if (!parsed) return undefined;

  let boundaryAt: Date;
  if (parsed.ts !== undefined) {
    boundaryAt = new Date(parsed.ts);
  } else {
    const [anchor] = await getDb()
      .select({ createdAt: posts.createdAt })
      .from(posts)
      .where(eq(posts.id, parsed.id))
      .limit(1);
    if (!anchor) return undefined;
    boundaryAt = anchor.createdAt;
  }

  const beyond = direction === 'asc' ? gt : lt;
  return or(
    beyond(posts.createdAt, boundaryAt),
    and(eq(posts.createdAt, boundaryAt), beyond(posts.id, parsed.id)),
  ) as SQL;
}

/**
 * Which way a chronological page runs. Every feed reads newest-first; the
 * replies list is the one surface a reader can flip to oldest-first, and the
 * keyset has to flip WITH it — a descending bound behind an ascending sort
 * re-serves page one forever.
 */
export type ChronoDirection = 'asc' | 'desc';

/**
 * The chronological order every keyset above is paired with.
 *
 * Exported so a source cannot order by one axis and page on another — the
 * defect that made federated posts vanish at page boundaries when an `_id` sort
 * sat behind a `createdAt` cursor.
 *
 * ## The NULLS placement is load-bearing on BOTH branches
 *
 * Both columns are NOT NULL, so none of this changes a row or an order — it
 * changes whether an index can serve the sort at all. Postgres matches an index
 * to an ORDER BY on the NULLS placement as well as the direction, and it will
 * use an index either in its declared order or in its EXACT REVERSE. Every
 * chronological index on `posts` is declared `created_at DESC NULLS LAST, id
 * DESC NULLS LAST` (that is what drizzle emits for `.desc()`), so the two
 * spellings an index can serve are:
 *
 *   forward   `desc nulls last`   — a plain `desc()` means `DESC NULLS FIRST`
 *   backward  `asc nulls first`   — a plain `asc()` means `ASC NULLS LAST`
 *
 * and drizzle's defaults are neither. Both were measured, both were wrong: the
 * ascending branch was assumed correct on the grounds that `asc()` already means
 * NULLS LAST, which is true and irrelevant — the index's reverse is NULLS FIRST.
 * An EXPLAIN test caught it, which is why there is one.
 *
 * Measured on this schema, 20,000 posts, page of 31:
 *
 *  - Following timeline (200 followed authors): plain `desc()` planned a Hash
 *    Semi Join over a SEQ SCAN of all 20,000 posts plus all 20,000 authorships,
 *    then a Sort — cost 2788.92, 40,000 rows touched. With `nulls last`: an
 *    Index Scan on `posts_created_at_idx` feeding a Nested Loop Semi Join that
 *    touched 32 rows — cost 474.33, and the LIMIT stops it early.
 *  - A chronological scan with no authorship join (discovery, global root feed):
 *    Seq Scan + Sort at cost 1636.42 / 16.536 ms, against an Index Scan at cost
 *    4.16 / 0.110 ms.
 *
 * and, for the ascending branch (the replies list flipped to oldest-first),
 * plain `asc()` planned a Sort of all 20,000 rows at cost 2139.83 against an
 * Index Only Scan Backward at cost 0.41 with `asc nulls first`.
 *
 * The cost grows with the MATCH SET, not the page, so it scales with how much
 * the viewer can see.
 *
 * NOT every caller benefits, and the difference is worth knowing before reading
 * a flat profile: the author/profile feed matches through a correlated EXISTS on
 * `post_authorships`, so its plan is a Nested Loop from the authorship index
 * into `posts_pkey` with no chronological index involved — measured identical
 * (cost 903.53) either way. This is neutral there, not an improvement.
 */
export function chronoOrderBy(direction: ChronoDirection = 'desc'): SQL[] {
  return direction === 'asc'
    ? [sql`${posts.createdAt} asc nulls first`, sql`${posts.id} asc nulls first`]
    : [sql`${posts.createdAt} desc nulls last`, sql`${posts.id} desc nulls last`];
}

/**
 * Validate that cursor advanced (prevent infinite pagination loops).
 */
export function didCursorAdvance(newCursor: string | undefined, previousCursor: string | undefined): boolean {
  if (!newCursor || !previousCursor) return true;
  return newCursor !== previousCursor;
}
