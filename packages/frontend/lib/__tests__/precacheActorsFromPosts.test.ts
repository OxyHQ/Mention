/**
 * Unit tests for the feed/post actor precache.
 *
 * `precacheActorsFromPosts` is the surviving Mention seeding wrapper: it extracts
 * every embedded actor from a batch of posts (author, original/quoted authors,
 * booster, boost actor) and hands them to the SDK's canonical merge-upsert,
 * `upsertCachedUsers`. Routing through that ONE merge-upsert is the structural
 * fix for the whole "sparse feed author clobbers the authoritative profile entry"
 * class of bug — the merge preserves `createdAt` (the "Joined … disappears on the
 * user's own profile" case), the viewer `relationship` ("Follows you vanishes"),
 * and `_count`, overriding only the fields the sparse source actually carries.
 *
 * The MERGE SEMANTICS themselves are the SDK helper's own contract (and are
 * verified in the `@oxyhq/services` package). What Mention owns — and what these
 * tests pin — is the WIRING: that every post's actors are extracted and every
 * seeding path is delegated to the merge-upsert, so no writer here can clobber.
 */

const mockUpsertCachedUsers = jest.fn();
jest.mock('@oxyhq/services', () => ({
  upsertCachedUsers: (...args: unknown[]) => mockUpsertCachedUsers(...args),
}));

/**
 * The app's singleton actor cache client, swapped for a sentinel: the function
 * forwards it to the upsert untouched, so a bare object is enough to assert it is
 * threaded through (and priming the real client would arm its GC timer past the
 * test run). The sentinel is created INSIDE the factory — an outer variable would
 * still be undefined when the mock is hoisted above it — and both the module
 * under test and this file import that one shared reference.
 */
jest.mock('@/lib/queryClient', () => ({ queryClient: { __sentinel: 'queryClient' } }));

import { precacheActorsFromPosts } from '../precacheActorsFromPosts';
import { queryClient as mockQueryClient } from '@/lib/queryClient';

/** The users the upsert was asked to prime on its single call. */
function upsertedUsers(): unknown[] {
  expect(mockUpsertCachedUsers).toHaveBeenCalledTimes(1);
  const [client, users] = mockUpsertCachedUsers.mock.calls[0];
  expect(client).toBe(mockQueryClient);
  return users as unknown[];
}

beforeEach(() => {
  mockUpsertCachedUsers.mockReset();
});

describe('precacheActorsFromPosts — extraction', () => {
  it('extracts the author, original/quoted authors, booster, and boost actor', () => {
    precacheActorsFromPosts([
      {
        user: { id: 'author-1', username: 'author' },
        original: { user: { id: 'orig-1', username: 'orig' } },
        quoted: { user: { id: 'quoted-1', username: 'quoted' } },
        boostedBy: { id: 'booster-1', username: 'booster' },
        boost: { actor: { id: 'actor-1', username: 'actor' } },
      },
    ]);

    expect(upsertedUsers()).toEqual([
      { id: 'author-1', username: 'author' },
      { id: 'orig-1', username: 'orig' },
      { id: 'quoted-1', username: 'quoted' },
      { id: 'booster-1', username: 'booster' },
      { id: 'actor-1', username: 'actor' },
    ]);
  });

  it('accepts a post author carrying the id as Mongo `_id`', () => {
    precacheActorsFromPosts([{ user: { _id: 'author-2', username: 'mongo' } }]);

    expect(upsertedUsers()).toEqual([{ _id: 'author-2', username: 'mongo' }]);
  });

  it('skips a post author with no id (id-less actors cannot be keyed)', () => {
    precacheActorsFromPosts([
      { user: { username: 'no-id' } },
      { user: { id: 'author-3', username: 'has-id' } },
    ]);

    expect(upsertedUsers()).toEqual([{ id: 'author-3', username: 'has-id' }]);
  });

  it('collects actors across every post in the batch, so a repeated author merges twice', () => {
    precacheActorsFromPosts([
      { user: { id: 'author-4', username: 'a4' } },
      { user: { id: 'author-4', name: { displayName: 'A Four' } } },
    ]);

    // Both slices are handed to the merge-upsert — it is the upsert's job to fold
    // the repeated id into one cumulatively merged cache entry.
    expect(upsertedUsers()).toEqual([
      { id: 'author-4', username: 'a4' },
      { id: 'author-4', name: { displayName: 'A Four' } },
    ]);
  });
});

describe('precacheActorsFromPosts — no-op inputs', () => {
  it.each<[string, readonly unknown[] | null | undefined]>([
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
  ])('does not touch the cache for %s', (_label, input) => {
    precacheActorsFromPosts(input);
    expect(mockUpsertCachedUsers).not.toHaveBeenCalled();
  });

  it('does not touch the cache when no post carries an actor', () => {
    precacheActorsFromPosts([{}, { user: null }, { user: { username: 'no-id' } }]);
    expect(mockUpsertCachedUsers).not.toHaveBeenCalled();
  });

  it('ignores non-object entries in the batch', () => {
    precacheActorsFromPosts([null, 42, 'post', { user: { id: 'author-5' } }]);
    expect(upsertedUsers()).toEqual([{ id: 'author-5' }]);
  });
});
