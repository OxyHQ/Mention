import { describe, expect, it } from 'vitest';

/**
 * The anonymous feed cache key.
 *
 * An anonymous page is SHARED across every logged-out reader, so the key has to
 * name every input that can change what was built. Anything that varies the
 * response but not the key collapses distinct pages onto one entry, and the
 * failure is invisible: the cache returns a valid-looking feed built for
 * somebody else.
 *
 * Languages joined that list when `loadViewerFeedContext` started resolving an
 * anonymous reader's languages from their request. Without them in the key, a
 * Spanish reader is served the German reader's page — the exact bug the language
 * work exists to fix, reintroduced one layer above the queries.
 */

import { anonFeedCache } from '../../services/anonFeedCache';

const base = { namespace: 'mtn', type: 'for_you', limit: 30 } as const;

describe('anonFeedCache.buildKey', () => {
  it('gives two different language sets two different keys', () => {
    expect(anonFeedCache.buildKey({ ...base, languages: ['es'] })).not.toBe(
      anonFeedCache.buildKey({ ...base, languages: ['de'] }),
    );
  });

  it('separates a declared reader from an undeclared one', () => {
    expect(anonFeedCache.buildKey({ ...base, languages: ['es'] })).not.toBe(
      anonFeedCache.buildKey({ ...base, languages: [] }),
    );
    expect(anonFeedCache.buildKey({ ...base, languages: [] })).toBe(
      anonFeedCache.buildKey(base),
    );
  });

  /**
   * Order is not identity. `es,en` and `en,es` are the same reader as far as the
   * discovery predicate is concerned (it is an array OVERLAP), so keying on the
   * raw order would double the entries for no difference in output.
   */
  it('treats a re-ordered language set as ONE entry', () => {
    expect(anonFeedCache.buildKey({ ...base, languages: ['es', 'en'] })).toBe(
      anonFeedCache.buildKey({ ...base, languages: ['en', 'es'] }),
    );
  });

  /**
   * The pre-existing dimensions, re-asserted alongside the new one — a key that
   * separated languages but stopped separating cursors would pass every test
   * above and still serve page 3 to a reader asking for page 1.
   */
  it('still separates descriptor, limit and cursor', () => {
    const key = anonFeedCache.buildKey({ ...base, languages: ['es'] });
    expect(anonFeedCache.buildKey({ ...base, type: 'explore', languages: ['es'] })).not.toBe(key);
    expect(anonFeedCache.buildKey({ ...base, limit: 50, languages: ['es'] })).not.toBe(key);
    expect(anonFeedCache.buildKey({ ...base, cursor: 'c1', languages: ['es'] })).not.toBe(key);
  });
});
