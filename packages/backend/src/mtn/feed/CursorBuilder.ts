/**
 * Centralized cursor handling for all feed types.
 * Replaces ad-hoc cursor parsing duplicated across strategies.
 */

import mongoose from 'mongoose';

// --- Score-based cursor (for ranked feeds: for_you, explore) ---

export interface ScoreCursorData {
  score: number;
  id: string;
}

export const ScoreCursor = {
  build(score: number, id: string): string {
    return `${score.toFixed(6)}:${id}`;
  },

  parse(cursor?: string): ScoreCursorData | undefined {
    if (!cursor) return undefined;

    if (cursor.includes(':')) {
      const colonIdx = cursor.indexOf(':');
      const scoreStr = cursor.slice(0, colonIdx);
      const id = cursor.slice(colonIdx + 1);
      const score = parseFloat(scoreStr);
      if (!isNaN(score) && id && mongoose.Types.ObjectId.isValid(id)) {
        return { score, id };
      }
    }

    // Fallback: plain ObjectId
    if (mongoose.Types.ObjectId.isValid(cursor)) {
      return { score: Infinity, id: cursor };
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
