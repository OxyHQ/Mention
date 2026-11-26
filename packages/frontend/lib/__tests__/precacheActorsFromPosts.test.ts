/**
 * Unit tests for the feed/post actor precache.
 *
 * `precacheActorsFromPosts` is the surviving Mention seeding wrapper: it extracts
 * every embedded actor from a batch of posts (author, related-post author,
 * boost actor) and hands them to the account's actor writer (`lib/actorCache`),
 * which merges them into the SDK's `User` through `storeUsers`. Routing through
 * that ONE merge is the structural fix for the whole "sparse feed author
 * clobbers the authoritative profile entry" class of bug — the merge preserves
 * `createdAt` (the "Joined … disappears on the user's own profile" case), the
 * viewer `relationship` ("Follows you vanishes"), and `_count`, overriding only
 * the fields the sparse source actually carries.
 *
 * What Mention owns — and what these tests pin — is the WIRING: that every
 * post's actors are extracted and handed to the writer (a recording one, for
 * the exact list), and that what reaches the REAL `User` through the default
 * writer is corrected for an identity the viewer just edited.
 */

import { type Store, withStore } from '@oxy.so/bloom-data';
import { User } from '@oxy.so/services/ui/client';
import { type ActorWriter, noteIdentityChanged } from '@/lib/actorCache';
import { getKnownIdentity, resetIdentityUpdates } from '@/stores/identityUpdates';
import { openAccountStore, signInAs, signOutForTests } from '@/test-support/accountScope';
import { precacheActorsFromPosts } from '../precacheActorsFromPosts';

jest.mock('@oxy.so/services/ui/client', () => ({
  ...require('@/test-support/oxyUsers').oxyUsers,
}));

/**
 * The app's singleton query client, swapped for a sentinel: `noteIdentityChanged`
 * only invalidates the operated-accounts list on it.
 */
jest.mock('@/lib/queryClient', () => ({
  queryClient: { __sentinel: 'queryClient', invalidateQueries: jest.fn() },
}));

const cacheActors = jest.fn();
/** A writer that records what it is handed, for the exact extracted list. */
const recording: ActorWriter = { cacheActors, cacheActor: jest.fn() };

/** The users handed to the writer on its single call. */
function upsertedUsers(): unknown[] {
  expect(cacheActors).toHaveBeenCalledTimes(1);
  return cacheActors.mock.calls[0][0] as unknown[];
}

let store: Store;

/** The held record of `id` in the signed-in account's store. */
function held(id: string) {
  return withStore(store, () => User.get(id));
}

/** Every id the signed-in account's `User` holds. */
function storedIds(): string[] {
  return withStore(store, () => User.ids());
}

beforeEach(() => {
  cacheActors.mockReset();
  store = openAccountStore();
  signInAs('viewer-1');
});

afterEach(() => {
  signOutForTests();
});

describe('precacheActorsFromPosts — extraction', () => {
  it('extracts actors from canonical quote and boost relations', () => {
    precacheActorsFromPosts(
      [
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
      ],
      recording,
    );

    expect(upsertedUsers()).toEqual([
      { id: 'author-1', username: 'author' },
      { id: 'quoted-1', username: 'quoted' },
      { id: 'booster-1', username: 'booster' },
      { id: 'orig-1', username: 'orig' },
      { id: 'booster-1', username: 'booster' },
    ]);
  });

  it('does not admit a legacy `_id` as canonical post identity', () => {
    precacheActorsFromPosts([{ user: { _id: 'author-2', username: 'legacy' } }]);
    expect(storedIds()).toEqual([]);
  });

  it('skips a post author with no id (id-less actors cannot be keyed)', () => {
    precacheActorsFromPosts(
      [{ user: { username: 'no-id' } }, { user: { id: 'author-3', username: 'has-id' } }],
      recording,
    );

    expect(upsertedUsers()).toEqual([{ id: 'author-3', username: 'has-id' }]);
  });

  it('collects actors across every post in the batch, so a repeated author merges twice', () => {
    precacheActorsFromPosts(
      [
        { user: { id: 'author-4', username: 'a4' } },
        { user: { id: 'author-4', name: { displayName: 'A Four' } } },
      ],
      recording,
    );

    // Both slices are handed to the merge — it is the SDK's job to fold the
    // repeated id into one cumulatively merged record.
    expect(upsertedUsers()).toEqual([
      { id: 'author-4', username: 'a4' },
      { id: 'author-4', name: { displayName: 'A Four' } },
    ]);
  });

  it("folds a repeated author into one record of the account's User by default", () => {
    precacheActorsFromPosts([
      { user: { id: 'author-4', username: 'a4' } },
      { user: { id: 'author-4', name: { displayName: 'A Four' } } },
    ]);

    expect(held('author-4')).toMatchObject({
      id: 'author-4',
      username: 'a4',
      name: { displayName: 'A Four' },
    });
  });
});

describe('precacheActorsFromPosts — no-op inputs', () => {
  it.each<[string, readonly unknown[] | null | undefined]>([
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
  ])('does not touch the cache for %s', (_label, input) => {
    precacheActorsFromPosts(input);
    expect(storedIds()).toEqual([]);
  });

  it('does not touch the cache when no post carries an actor', () => {
    precacheActorsFromPosts([{}, { user: null }, { user: { username: 'no-id' } }]);
    expect(storedIds()).toEqual([]);
  });

  it('ignores non-object entries in the batch', () => {
    precacheActorsFromPosts([null, 42, 'post', { user: { id: 'author-5' } }], recording);
    expect(upsertedUsers()).toEqual([{ id: 'author-5' }]);
  });
});

/**
 * The SDK write this file reaches is a MERGE, which is exactly why a stale
 * author is dangerous here rather than harmless: a real avatar id overrides a
 * real avatar id, so the pre-edit picture wins on arrival. These run against the
 * SDK's own `User` — the edit is stored, then a hydrated author still carrying
 * the old picture arrives, and without the correction the record would be back
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

    expect(held(EDITED)).toMatchObject({ id: EDITED, username: 'daily', avatar: 'avatar-after' });
  });

  it('leaves every other author in the same batch untouched', () => {
    noteIdentityChanged({ id: EDITED, avatar: 'avatar-after' });

    precacheActorsFromPosts([
      staleAuthorPost(),
      { user: { id: 'someone-else', username: 'else', avatar: 'their-avatar' } },
    ]);

    expect(held(EDITED)).toMatchObject({ username: 'daily', avatar: 'avatar-after' });
    expect(held('someone-else')).toMatchObject({ username: 'else', avatar: 'their-avatar' });
  });

  it('retires the correction once hydration carries the edit, and stops correcting', () => {
    noteIdentityChanged({ id: EDITED, username: 'daily', avatar: 'avatar-after' });

    // The server has caught up: this batch already names the new picture.
    precacheActorsFromPosts([{ user: { id: EDITED, username: 'daily', avatar: 'avatar-after' } }]);

    // So a value that differs AFTERWARDS is a genuine change made somewhere else
    // — another device, accounts.oxy.so — and must reach the cache unedited.
    precacheActorsFromPosts([
      { user: { id: EDITED, username: 'daily', avatar: 'avatar-changed-elsewhere' } },
    ]);

    expect(held(EDITED)).toMatchObject({
      username: 'daily',
      avatar: 'avatar-changed-elsewhere',
    });
  });

  it('keeps correcting a description no post can speak for', () => {
    // The reported symptom's other half. A feed page carries the handle, the
    // name and the picture and NEVER a description, so it can retire those and
    // must leave this one recorded — otherwise the first page after the save
    // discards the correction that the bio-carrying surfaces still need.
    noteIdentityChanged({
      id: EDITED,
      username: 'daily',
      name: { displayName: 'Daily Digest' },
      avatar: 'avatar-after',
      bio: 'bio-after',
    });

    precacheActorsFromPosts([
      {
        user: {
          id: EDITED,
          username: 'daily',
          name: { displayName: 'Daily Digest' },
          avatar: 'avatar-after',
        },
      },
    ]);

    expect(getKnownIdentity(EDITED)).toEqual({ id: EDITED, bio: 'bio-after' });
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
      {
        user: {
          id: EDITED,
          username: 'daily',
          avatar: 'avatar-after',
          name: { displayName: 'Daily' },
        },
      },
    ]);
    precacheActorsFromPosts([staleAuthorPost()]);

    expect(held(EDITED)).toMatchObject({
      id: EDITED,
      username: 'daily',
      name: { displayName: 'Daily Digest' },
      avatar: 'avatar-after',
    });
  });
});
