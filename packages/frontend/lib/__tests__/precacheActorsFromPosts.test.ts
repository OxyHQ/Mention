/**
 * Unit tests for the feed/post actor precache.
 *
 * `precacheActorsFromPosts` is the surviving Mention seeding wrapper: it extracts
 * every embedded actor from a batch of posts (author, related-post author,
 * boost actor) and hands them to the SDK's canonical merge-upsert,
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

import { queryClient as mockQueryClient } from '@/lib/queryClient';
import { noteIdentityChanged } from '@/lib/actorCache';
import { resetIdentityUpdates } from '@/stores/identityUpdates';
import { precacheActorsFromPosts } from '../precacheActorsFromPosts';

const mockUpsertCachedUsers = jest.fn();
jest.mock('@oxyhq/services', () => ({
  upsertCachedUsers: (...args: unknown[]) => mockUpsertCachedUsers(...args),
  // `stores/identityUpdates` writes the edit through the SDK's single-user
  // upsert; this file is about what reaches the BATCH one, so it only has to
  // exist.
  upsertCachedUser: jest.fn(),
}));

/**
 * The app's singleton actor cache client, swapped for a sentinel: the function
 * forwards it to the upsert untouched, so a bare object is enough to assert it is
 * threaded through (and priming the real client would arm its GC timer past the
 * test run). The sentinel is created INSIDE the factory — an outer variable would
 * still be undefined when the mock is hoisted above it — and both the module
 * under test and this file import that one shared reference.
 */
jest.mock('@/lib/queryClient', () => ({
  queryClient: { __sentinel: 'queryClient', invalidateQueries: jest.fn() },
}));

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
  it('extracts actors from canonical quote and boost relations', () => {
    precacheActorsFromPosts([
      {
        user: { id: 'author-1', username: 'author' },
        originalPost: { user: { id: 'quoted-1', username: 'quoted' } },
        quotedPost: { user: { id: 'quoted-1', username: 'quoted' } },
      },
      {
        user: { id: 'booster-1', username: 'booster' },
        originalPost: { user: { id: 'orig-1', username: 'orig' } },
        boost: {
          actor: { id: 'booster-1', username: 'booster' },
          originalPost: { user: { id: 'orig-1', username: 'orig' } },
        },
      },
    ]);

    expect(upsertedUsers()).toEqual([
      { id: 'author-1', username: 'author' },
      { id: 'quoted-1', username: 'quoted' },
      { id: 'booster-1', username: 'booster' },
      { id: 'orig-1', username: 'orig' },
      { id: 'booster-1', username: 'booster' },
    ]);
  });

  it('does not admit a legacy Mongo `_id` as canonical post identity', () => {
    precacheActorsFromPosts([{ user: { _id: 'author-2', username: 'mongo' } }]);
    expect(mockUpsertCachedUsers).not.toHaveBeenCalled();
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

/**
 * The merge-upsert this file delegates to is a MERGE, which is exactly why a
 * stale author is dangerous here rather than harmless: a real avatar id
 * overrides a real avatar id, so the pre-edit picture wins on arrival. Verified
 * against the SDK's own implementation — seed an entry, upsert an edit, then
 * upsert a hydrated author still carrying the old picture, and the entry is back
 * to the old picture.
 *
 * Whether a given response IS stale is a race (the server is told about the
 * write and drops its identity caches on receipt), and that is the point: on a
 * channel's own page every post in the response is authored by the account whose
 * picture just changed, so losing that race decides what its header shows. The
 * correction removes the race from the answer.
 */
describe('precacheActorsFromPosts — an identity the viewer just edited', () => {
  const EDITED = 'channel-1';

  /** The users handed to the upsert on its LAST call. */
  function lastUpsertedUsers(): unknown[] {
    const calls = mockUpsertCachedUsers.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][1] as unknown[];
  }

  /** That account as the server still hydrates it: the picture from before the edit. */
  function staleAuthorPost() {
    return { user: { id: EDITED, username: 'daily', avatar: 'avatar-before' } };
  }

  afterEach(() => {
    resetIdentityUpdates();
  });

  it('corrects a stale author on its way into the cache', () => {
    noteIdentityChanged({ id: EDITED, username: 'daily', avatar: 'avatar-after' });

    precacheActorsFromPosts([staleAuthorPost()]);

    expect(lastUpsertedUsers()).toEqual([
      { id: EDITED, username: 'daily', avatar: 'avatar-after' },
    ]);
  });

  it('leaves every other author in the same batch untouched', () => {
    noteIdentityChanged({ id: EDITED, avatar: 'avatar-after' });

    precacheActorsFromPosts([
      staleAuthorPost(),
      { user: { id: 'someone-else', username: 'else', avatar: 'their-avatar' } },
    ]);

    expect(lastUpsertedUsers()).toEqual([
      { id: EDITED, username: 'daily', avatar: 'avatar-after' },
      { id: 'someone-else', username: 'else', avatar: 'their-avatar' },
    ]);
  });

  it('retires the correction once hydration carries the edit, and stops correcting', () => {
    noteIdentityChanged({ id: EDITED, username: 'daily', avatar: 'avatar-after' });

    // The server has caught up: this batch already names the new picture.
    precacheActorsFromPosts([
      { user: { id: EDITED, username: 'daily', avatar: 'avatar-after' } },
    ]);

    // So a value that differs AFTERWARDS is a genuine change made somewhere else
    // — another device, accounts.oxy.so — and must reach the cache unedited.
    precacheActorsFromPosts([
      { user: { id: EDITED, username: 'daily', avatar: 'avatar-changed-elsewhere' } },
    ]);

    expect(lastUpsertedUsers()).toEqual([
      { id: EDITED, username: 'daily', avatar: 'avatar-changed-elsewhere' },
    ]);
  });

  it('does not retire on a batch that agrees about only SOME of the edit', () => {
    noteIdentityChanged({
      id: EDITED,
      username: 'daily',
      name: { displayName: 'Daily Digest' },
      avatar: 'avatar-after',
    });

    // The picture caught up, the name did not — that is not the server agreeing.
    precacheActorsFromPosts([
      { user: { id: EDITED, username: 'daily', avatar: 'avatar-after', name: { displayName: 'Daily' } } },
    ]);
    precacheActorsFromPosts([staleAuthorPost()]);

    expect(lastUpsertedUsers()).toEqual([
      {
        id: EDITED,
        username: 'daily',
        name: { displayName: 'Daily Digest' },
        avatar: 'avatar-after',
      },
    ]);
  });
});
