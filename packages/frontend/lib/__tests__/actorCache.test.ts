import fs from 'node:fs';
import path from 'node:path';

import { type Store, withStore } from '@oxy.so/bloom-data';
import { User } from '@oxy.so/services/ui/client';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { queryClient as mockQueryClient } from '@/lib/queryClient';
import { getKnownIdentity, resetIdentityUpdates } from '@/stores/identityUpdates';
import { openAccountStore, signInAs, signOutForTests } from '@/test-support/accountScope';
import { actorWriter, cacheActor, cacheActors, noteIdentityChanged } from '../actorCache';

/**
 * The one door into the SDK's user cache.
 *
 * Six surfaces prime that cache with users they fetched, and the SDK merge they
 * all reach overrides a real value with a real value — so ANY of them can put a
 * server copy that predates a profile edit back over that edit. Guarding them
 * individually would be six guards; they share a door instead, and these pin
 * both that the door corrects what passes through it AND that nothing walks
 * around it.
 *
 * The cache is the SDK's REAL `User` entity (Services 15, one bloom-data store
 * per account) written through its real `storeUsers`, so each assertion reads
 * the record a profile screen or a post row would render.
 */

jest.mock('@oxy.so/services/ui/client', () => ({
  ...require('@/test-support/oxyUsers').oxyUsers,
}));

jest.mock('@/lib/queryClient', () => ({
  queryClient: { __sentinel: 'queryClient', invalidateQueries: jest.fn() },
}));

const invalidateQueries = mockQueryClient.invalidateQueries as unknown as jest.Mock;

let store: Store;

/** The held record of `id` in the signed-in account's store. */
function held(id: string, inStore: Store = store) {
  return withStore(inStore, () => User.get(id));
}

beforeEach(() => {
  invalidateQueries.mockReset();
  store = openAccountStore();
  signInAs('viewer-1');
});

afterEach(() => {
  resetIdentityUpdates();
  signOutForTests();
});

describe('noteIdentityChanged', () => {
  it("stores the edit in the acting viewer's User", () => {
    noteIdentityChanged(
      {
        id: 'channel-1',
        username: 'daily',
        name: { displayName: 'Daily Digest' },
        avatar: 'avatar-after',
        bio: 'bio-after',
      },
      'viewer-1',
    );

    expect(held('channel-1')).toMatchObject({
      id: 'channel-1',
      username: 'daily',
      name: { displayName: 'Daily Digest' },
      avatar: 'avatar-after',
      bio: 'bio-after',
    });
    // Indexed by handle too: the profile screen finds it by username.
    expect(withStore(store, () => User.lookup('username', 'daily'))).toBe('channel-1');
    expect(getKnownIdentity('channel-1')).toEqual({
      id: 'channel-1',
      username: 'daily',
      name: { displayName: 'Daily Digest' },
      avatar: 'avatar-after',
      bio: 'bio-after',
    });
  });

  it('merges into what a profile read stored instead of replacing it', () => {
    withStore(store, () =>
      User.put({
        id: 'channel-1',
        username: 'daily',
        avatar: 'avatar-before',
        bio: 'kept',
      } as never),
    );

    noteIdentityChanged({ id: 'channel-1', avatar: 'avatar-after' }, 'viewer-1');

    expect(held('channel-1')).toMatchObject({
      username: 'daily',
      avatar: 'avatar-after',
      bio: 'kept',
    });
  });

  it('reaches nothing for an edit accepted for an account that is no longer signed in', () => {
    // The write was for viewer-1; the device has switched to viewer-2 since.
    signInAs('viewer-2');

    noteIdentityChanged({ id: 'channel-1', avatar: 'avatar-after' }, 'viewer-1');

    expect(held('channel-1')).toBeUndefined();
    expect(getKnownIdentity('channel-1')).toBeUndefined();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  /**
   * The description, both directions.
   *
   * The `User` record behind a channel's page is what renders it, so an edit
   * that never reaches it is invisible until the page reads the profile again.
   * Setting it and emptying it are different mechanisms (a value that wins the
   * merge versus a declared clear that lowers the SDK's anti-degradation
   * guard), so one passing says nothing about the other.
   */
  describe('a description', () => {
    beforeEach(() => {
      withStore(store, () =>
        User.put({ id: 'channel-1', username: 'daily', bio: 'bio-before' } as never),
      );
    });

    it('reaches the cache when it is set', () => {
      noteIdentityChanged({ id: 'channel-1', username: 'daily', bio: 'bio-after' }, 'viewer-1');

      expect(held('channel-1')).toMatchObject({ bio: 'bio-after' });
    });

    it('reaches the cache as a DECLARED clear when it is emptied', () => {
      // Oxy omits a cleared scalar exactly as it omits an untouched one, so the
      // payload cannot carry the intent — only the declaration can. Without it
      // the SDK's guard (rightly) preserves the stale text.
      noteIdentityChanged({ id: 'channel-1', username: 'daily' }, 'viewer-1', {
        cleared: ['bio'],
      });

      expect(held('channel-1')?.bio).toBeUndefined();
      expect(held('channel-1')).toMatchObject({ username: 'daily' });
    });

    it('keeps the description for an edit that omits it without declaring a clear', () => {
      noteIdentityChanged({ id: 'channel-1', username: 'daily' }, 'viewer-1');

      expect(held('channel-1')).toMatchObject({ bio: 'bio-before' });
    });

    it('declares no clear for an edit that emptied nothing', () => {
      // The guard this lowers is what stops sparse hydration blanking real
      // identity across every Oxy app, so it must be lowered only for a field
      // the writer actually observed being emptied.
      noteIdentityChanged({ id: 'channel-1', username: 'daily', bio: 'bio-after' }, 'viewer-1', {
        cleared: [],
      });

      expect(held('channel-1')).toMatchObject({ bio: 'bio-after' });
    });
  });

  it('invalidates the operated-accounts list and nothing else in its family', () => {
    noteIdentityChanged({ id: 'channel-1', avatar: 'avatar-after' }, 'viewer-1');

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    const { predicate } = invalidateQueries.mock.calls[0][0];
    expect(predicate({ queryKey: viewerQueryKeys.operatedAccounts('viewer-1') })).toBe(true);
    expect(
      predicate({ queryKey: viewerQueryKeys.channelAccountSettings('viewer-1', 'channel-1') }),
    ).toBe(false);
    expect(predicate({ queryKey: viewerQueryKeys.notifications('viewer-1') })).toBe(false);
  });

  it('does not reconcile the edit against itself', () => {
    // Routed through `cacheActor`, the write would arrive as an actor that
    // "agrees" with what it just recorded and retire the entry on the spot —
    // leaving nothing to correct the very next feed response with.
    noteIdentityChanged({ id: 'channel-1', avatar: 'avatar-after' });

    expect(getKnownIdentity('channel-1')).toEqual({ id: 'channel-1', avatar: 'avatar-after' });
  });

  it('touches no cache for a write with no id', () => {
    noteIdentityChanged({ id: '', avatar: 'avatar-after' });

    expect(withStore(store, () => User.ids())).toEqual([]);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

describe('cacheActors / cacheActor', () => {
  // Each case writes the stale server copy over what the edit stored: without
  // the correction the SDK merge (a real value overrides a real value) would
  // leave the pre-edit value held.
  it('corrects an actor a profile edit has since superseded', () => {
    noteIdentityChanged({ id: 'channel-1', username: 'daily', avatar: 'avatar-after' });

    cacheActors([{ id: 'channel-1', username: 'daily', avatar: 'avatar-before' }]);

    expect(held('channel-1')).toMatchObject({
      id: 'channel-1',
      username: 'daily',
      avatar: 'avatar-after',
    });
  });

  it('corrects a single actor the same way', () => {
    noteIdentityChanged({ id: 'channel-1', avatar: 'avatar-after' });

    cacheActor({ id: 'channel-1', username: 'daily', avatar: 'avatar-before' });

    expect(held('channel-1')).toMatchObject({
      id: 'channel-1',
      username: 'daily',
      avatar: 'avatar-after',
    });
  });

  it('leaves every other actor in the batch untouched', () => {
    noteIdentityChanged({ id: 'channel-1', avatar: 'avatar-after' });

    cacheActors([
      { id: 'channel-1', username: 'daily', avatar: 'avatar-before' },
      { id: 'someone-else', username: 'else', avatar: 'their-avatar' },
    ]);

    expect(held('channel-1')).toMatchObject({ username: 'daily', avatar: 'avatar-after' });
    expect(held('someone-else')).toMatchObject({ username: 'else', avatar: 'their-avatar' });
  });

  it('corrects a stale description on a surface that carries one', () => {
    // Recommendations, similar accounts and the followers/following lists all
    // carry a bio, and the SDK merge overrides a real value with a real value —
    // so any of them can put the pre-edit text straight back over the edit.
    noteIdentityChanged({ id: 'channel-1', username: 'daily', bio: 'bio-after' });

    cacheActors([
      { id: 'channel-1', username: 'daily', bio: 'bio-before' },
      { id: 'someone-else', username: 'else', bio: 'their-bio' },
    ]);

    expect(held('channel-1')).toMatchObject({ bio: 'bio-after' });
    expect(held('someone-else')).toMatchObject({ bio: 'their-bio' });
  });

  it('retires the correction once a surface carries the edit, and stops correcting', () => {
    noteIdentityChanged({ id: 'channel-1', username: 'daily', avatar: 'avatar-after' });

    cacheActors([{ id: 'channel-1', username: 'daily', avatar: 'avatar-after' }]);
    expect(getKnownIdentity('channel-1')).toBeUndefined();

    // So a value that differs AFTERWARDS is a genuine change made somewhere else
    // — another device, accounts.oxy.so — and must reach the cache unedited.
    cacheActors([{ id: 'channel-1', username: 'daily', avatar: 'avatar-elsewhere' }]);
    expect(held('channel-1')).toMatchObject({ avatar: 'avatar-elsewhere' });
  });

  it('retires from a SINGLE-actor surface too', () => {
    noteIdentityChanged({ id: 'channel-1', avatar: 'avatar-after' });

    cacheActor({ id: 'channel-1', avatar: 'avatar-after' });
    expect(getKnownIdentity('channel-1')).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
  ])('does not touch the cache for %s', (_label, input) => {
    cacheActors(input as never);
    expect(withStore(store, () => User.ids())).toEqual([]);
  });

  it('does not touch the cache for a missing single actor', () => {
    cacheActor(null);
    expect(withStore(store, () => User.ids())).toEqual([]);
  });
});

/**
 * A surface takes its writer before it awaits. An answer that lands after the
 * account changed must prime nothing: neither the store of the account that
 * asked (closed on device) nor the next account's, which would otherwise show
 * the previous account's people and their viewer-relative `relationship`.
 */
describe('actorWriter', () => {
  it('writes into the store it was taken in, even when another is active by then', () => {
    const writer = actorWriter();
    const other = openAccountStore();

    writer.cacheActors([{ id: 'user-1', username: 'one' }]);

    expect(held('user-1')).toMatchObject({ username: 'one' });
    expect(held('user-1', other)).toBeUndefined();
  });

  it('writes nothing once the account it was taken for is left', () => {
    const writer = actorWriter();
    signInAs('viewer-2');
    const next = openAccountStore();

    writer.cacheActors([{ id: 'user-1', username: 'one' }]);
    writer.cacheActor({ id: 'user-2', username: 'two' });

    expect(held('user-1')).toBeUndefined();
    expect(held('user-2')).toBeUndefined();
    expect(withStore(next, () => User.ids())).toEqual([]);
  });

  it('writes nothing into a store that closed after it was taken', () => {
    const writer = actorWriter();
    void store.close();

    writer.cacheActors([{ id: 'user-1', username: 'one' }]);

    expect(held('user-1')).toBeUndefined();
  });
});

/**
 * Nothing walks around the door.
 *
 * Six surfaces used to call the SDK's user write directly, and a seventh added later
 * would inherit the bug in silence — the correction simply would not run for it,
 * with no error and no failing test anywhere. A guard per surface is the shape
 * that quietly becomes five of six; this asserts the property that makes one
 * guard sufficient, which is that `lib/actorCache.ts` is the only importer.
 */
describe('the door is the only way in', () => {
  const FRONTEND_ROOT = path.resolve(__dirname, '../..');
  const SKIP_DIRS = new Set([
    'node_modules',
    '.expo',
    'dist',
    'android',
    'ios',
    'coverage',
    '.git',
  ]);

  /** Every `.ts`/`.tsx` under the frontend package, tests excluded. */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name === '__tests__') continue;
        sourceFiles(full, out);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  const files = sourceFiles(FRONTEND_ROOT);

  it('scanned a plausible number of source files', () => {
    // A traversal that silently found nothing would make the assertion below
    // pass for the wrong reason.
    expect(files.length).toBeGreaterThan(300);
  });

  it('is the only module importing the SDK user-cache writes', () => {
    const importers = files.filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      // The IMPORT, not a mention in prose — several files name these helpers in
      // their docstrings, and a docstring cannot walk around anything.
      // Either SDK entry: the root barrel or the lean `ui/client` (services 9.2).
      // `storeUsers` is the merge (Services 15); `userWriter` is the same write
      // captured for later, so it would walk around the correction just as well.
      return /import\s*\{[^}]*\b(?:storeUsers|userWriter)\b[^}]*\}\s*from\s*['"]@oxy\.so\/services(?:\/ui\/client)?['"]/.test(
        source,
      );
    });

    expect(importers.map((file) => path.relative(FRONTEND_ROOT, file))).toEqual([
      'lib/actorCache.ts',
    ]);
  });
});
