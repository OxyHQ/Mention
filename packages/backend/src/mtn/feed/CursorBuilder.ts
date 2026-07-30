/**
 * Centralized cursor handling for all feed types.
 * Replaces ad-hoc cursor parsing duplicated across strategies.
 */

import mongoose from 'mongoose';

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
}

export interface ScoreCursorBuildOptions {
  asOf?: Date | number;
  excludeIds?: Iterable<string>;
  /** See {@link ScoreCursorData.tiebreakAt}. */
  tiebreakAt?: Date | number;
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
  if (mongoose.Types.ObjectId.isValid(id)) unique.add(id);
  if (ids) {
    for (const candidate of ids) {
      if (unique.size >= MAX_SCORE_CURSOR_EXCLUDE_IDS) break;
      if (mongoose.Types.ObjectId.isValid(candidate)) unique.add(candidate);
    }
  }
  return Array.from(unique);
}

export const ScoreCursor = {
  build(score: number, id: string, options?: ScoreCursorBuildOptions): string {
    const rawAsOf = options?.asOf instanceof Date ? options.asOf.getTime() : options?.asOf;
    if (
      Number.isFinite(score)
      && mongoose.Types.ObjectId.isValid(id)
      && isValidScoreCursorAsOf(rawAsOf)
    ) {
      const rawTiebreakAt = options?.tiebreakAt instanceof Date
        ? options.tiebreakAt.getTime()
        : options?.tiebreakAt;
      const metadata: ScoreCursorCompatV1Payload = {
        a: rawAsOf,
        x: normalizeExcludedIds(id, options?.excludeIds),
        ...(isValidCursorTimestamp(rawTiebreakAt) ? { t: rawTiebreakAt } : {}),
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
      if (Number.isFinite(score) && id && mongoose.Types.ObjectId.isValid(id)) {
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
    if (mongoose.Types.ObjectId.isValid(cursor)) {
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

  parse(cursor?: string): { id: mongoose.Types.ObjectId; ts?: number } | undefined {
    if (!cursor) return undefined;

    const parts = cursor.split(':');
    if (parts.length === 2 && mongoose.Types.ObjectId.isValid(parts[1])) {
      const ts = Number(parts[0]);
      if (!Number.isNaN(ts)) {
        return { id: new mongoose.Types.ObjectId(parts[1]), ts };
      }
    }

    if (mongoose.Types.ObjectId.isValid(cursor)) {
      return { id: new mongoose.Types.ObjectId(cursor) };
    }
    return undefined;
  },

  /** Apply cursor filter to a Mongoose match object */
  applyToQuery(match: Record<string, unknown>, cursor?: string): void {
    const parsed = this.parse(cursor);
    if (parsed?.id) {
      const createdAtFilter = parsed.ts ? new Date(parsed.ts) : undefined;
      if (createdAtFilter) {
        match.$or = [
          { createdAt: { $lt: createdAtFilter } },
          { createdAt: createdAtFilter, _id: { $lt: parsed.id } },
        ];
      } else {
        match._id = { $lt: parsed.id };
      }
    }
  },
};

/**
 * Validate that cursor advanced (prevent infinite pagination loops).
 */
export function didCursorAdvance(newCursor: string | undefined, previousCursor: string | undefined): boolean {
  if (!newCursor || !previousCursor) return true;
  return newCursor !== previousCursor;
}
