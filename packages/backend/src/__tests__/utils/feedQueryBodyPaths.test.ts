import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { FeedQueryBuilder } from '../../utils/feedQueryBuilder';

/**
 * Every Mongo query that searches a post's BODY.
 *
 * The body moved out of `content.text` and into the `content.variants[]`
 * renditions. Mongo query keys are strings, so none of this is type-checked: a
 * clause still keyed on `content.text` compiles, runs, and matches ZERO
 * documents. Keyword feeds would silently return nothing, and a text search
 * would silently find nothing — no error, no exception, nothing to page anyone.
 * "Matched nothing" is indistinguishable from "nothing to match" unless the query
 * itself is asserted, which is what this file does.
 *
 * `content.variants.text` is MULTIKEY: it matches when ANY rendition matches,
 * which is what a keyword feed wants — a reader searching in their own language
 * should find a post whose body they can actually read.
 */

/** Every dotted key mentioned anywhere in a (possibly nested) query object. */
function queryKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) queryKeys(entry, found);
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      found.push(key);
      queryKeys(nested, found);
    }
  }
  return found;
}

describe('FeedQueryBuilder — the body is searched in its REAL home', () => {
  it('matches keywords against the renditions, never the retired content.text', () => {
    const query = FeedQueryBuilder.buildQuery({
      type: 'for_you',
      filters: { keywords: 'spaceships' },
    });

    const keys = queryKeys(query);
    expect(keys).toContain('content.variants.text');
    expect(keys).not.toContain('content.text');
  });

  it('matches a saved-posts search against the renditions', () => {
    const query = FeedQueryBuilder.buildQuery({
      type: 'saved',
      savedPostIds: [new mongoose.Types.ObjectId()],
      filters: { searchQuery: 'spaceships' },
    });

    const keys = queryKeys(query);
    expect(keys).toContain('content.variants.text');
    expect(keys).not.toContain('content.text');
  });

  it('builds a keyword regex that actually matches a body (the clause is not merely well-formed)', () => {
    const query = FeedQueryBuilder.buildQuery({
      type: 'for_you',
      filters: { keywords: 'spaceships' },
    });

    // A clause keyed correctly but built wrong would still match nothing. Pull the
    // regex out and run it against a real body.
    const or = query.$or as Array<Record<string, { $in?: RegExp[] }>>;
    const clause = or.find((entry) => 'content.variants.text' in entry);
    const regexes = clause?.['content.variants.text'].$in ?? [];
    expect(regexes).toHaveLength(1);
    expect('a movie about spaceships').toMatch(regexes[0]);
    expect('a movie about submarines').not.toMatch(regexes[0]);
  });
});
