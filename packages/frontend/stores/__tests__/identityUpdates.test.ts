import type { AccountCategoryId } from '@oxyhq/contracts';
import {
  applyKnownIdentity,
  getKnownIdentity,
  mergeKnownIdentity,
  reconcileKnownIdentities,
  recordIdentityChange,
  resetIdentityUpdates,
  subscribeToIdentityUpdates,
} from '../identityUpdates';

/**
 * The overlay store: the STATE half of an identity write, and the half every
 * rendered post row reads.
 *
 * The cache half — writing the edit through to React Query and correcting
 * incoming actors — belongs to `lib/actorCache.ts` and is pinned by
 * `lib/__tests__/actorCache.test.ts`. The split is not cosmetic: this module is
 * in `PostItem`'s module graph, so it must not import the SDK, and these tests
 * mock nothing at all, which is the cheap standing proof that it does not.
 */

afterEach(() => {
  resetIdentityUpdates();
});

describe('recordIdentityChange', () => {
  it('stores and returns exactly the fields the edit carried', () => {
    // A save that changed the picture alone must not also assert a name — the
    // overlay would then pin whatever the writer was holding, and would later
    // "agree" with the server about a value nobody edited.
    const stored = recordIdentityChange({ id: 'channel-1', avatar: 'avatar-after' });

    expect(stored).toEqual({ id: 'channel-1', avatar: 'avatar-after' });
    expect(getKnownIdentity('channel-1')).toBe(stored);
  });

  it('stores the description an edit carried', () => {
    // The field the channel header reads. It was absent from the recorded shape
    // for as long as this module existed, so a description edit reached the
    // server and every client-side copy kept serving the old text.
    const stored = recordIdentityChange({ id: 'channel-1', bio: 'What this is about' });

    expect(stored).toEqual({ id: 'channel-1', bio: 'What this is about' });
    expect(getKnownIdentity('channel-1')).toBe(stored);
  });

  it('stores the categories an edit carried, in the order it carried them', () => {
    // Ordered because element 0 is the primary — the one thing a reader sees
    // under the channel's name — so a list that survives as a set has lost the
    // edit that promoted one.
    const stored = recordIdentityChange({
      id: 'channel-1',
      accountCategories: ['news', 'sports'],
    });

    expect(stored).toEqual({ id: 'channel-1', accountCategories: ['news', 'sports'] });
  });

  it.each<
    [
      string,
      {
        username?: string;
        avatar?: string | null;
        bio?: string;
        name?: { displayName?: string };
        accountCategories?: AccountCategoryId[];
      },
    ]
  >([
    ['an empty username', { username: '   ' }],
    ['a cleared picture', { avatar: null }],
    ['an emptied picture', { avatar: '' }],
    ['an emptied description', { bio: '   ' }],
    ['an emptied category list', { accountCategories: [] }],
    ['an emptied display name', { name: { displayName: '  ' } }],
  ])('never records %s, so no cache can be degraded by one', (_label, fields) => {
    expect(recordIdentityChange({ id: 'channel-1', ...fields })).toEqual({ id: 'channel-1' });
  });

  it('returns a write that emptied everything without recording it', () => {
    // The caller still needs it — a declared clear reaches the caches through
    // `noteIdentityChanged` — but an entry with no fields corrects nothing, and
    // nothing could ever retire it: retirement needs a field to agree ABOUT.
    // Every recorded entry holding at least one field is what makes the sweep
    // below terminate.
    expect(recordIdentityChange({ id: 'channel-1', bio: '' })).toEqual({ id: 'channel-1' });
    expect(getKnownIdentity('channel-1')).toBeUndefined();
  });

  it('refuses a write with no id — there is nothing to key it on', () => {
    expect(recordIdentityChange({ id: '', avatar: 'avatar-after' })).toBeNull();
    expect(getKnownIdentity('')).toBeUndefined();
  });
});

describe('the recorded identity', () => {
  it('notifies subscribers when it is written, retired and reset', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToIdentityUpdates(listener);

    recordIdentityChange({ id: 'channel-1', avatar: 'avatar-after' });
    expect(listener).toHaveBeenCalledTimes(1);

    reconcileKnownIdentities([{ id: 'channel-1', avatar: 'avatar-after' }]);
    expect(listener).toHaveBeenCalledTimes(2);

    resetIdentityUpdates();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    recordIdentityChange({ id: 'channel-1', avatar: 'avatar-later' });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('does not notify when a batch agrees with nothing', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToIdentityUpdates(listener);

    // Nothing recorded at all, then a recorded entry the batch disagrees with:
    // a subscriber woken here would re-render every post row on every page.
    reconcileKnownIdentities([{ id: 'channel-1', avatar: 'avatar-before' }]);
    expect(listener).not.toHaveBeenCalled();

    recordIdentityChange({ id: 'channel-1', avatar: 'avatar-after' });
    listener.mockClear();
    reconcileKnownIdentities([{ id: 'channel-1', avatar: 'avatar-before' }]);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('is stable by reference until that user is written again', () => {
    recordIdentityChange({ id: 'channel-1', avatar: 'avatar-after' });
    const first = getKnownIdentity('channel-1');
    expect(getKnownIdentity('channel-1')).toBe(first);

    // `useKnownIdentity` hands this straight to `useSyncExternalStore`, which
    // loops forever on a snapshot that allocates.
    recordIdentityChange({ id: 'someone-else', avatar: 'other' });
    expect(getKnownIdentity('channel-1')).toBe(first);

    recordIdentityChange({ id: 'channel-1', avatar: 'avatar-later' });
    expect(getKnownIdentity('channel-1')).not.toBe(first);
  });

  it('reads as nothing for an unknown or absent id', () => {
    expect(getKnownIdentity('nobody')).toBeUndefined();
    expect(getKnownIdentity(undefined)).toBeUndefined();
  });
});

describe('merging an actor', () => {
  const actor = { id: 'channel-1', username: 'daily', avatar: 'avatar-before' };

  it('returns the same reference when nothing is recorded', () => {
    expect(mergeKnownIdentity(actor, undefined)).toBe(actor);
    expect(applyKnownIdentity(actor)).toBe(actor);
  });

  it('overrides only the recorded fields', () => {
    recordIdentityChange({ id: 'channel-1', avatar: 'avatar-after' });

    expect(applyKnownIdentity({ ...actor, verified: true })).toEqual({
      id: 'channel-1',
      username: 'daily',
      avatar: 'avatar-after',
      verified: true,
    });
  });

  it('never writes the recorded id over the actor it is merged into', () => {
    recordIdentityChange({ id: 'channel-1', avatar: 'avatar-after' });

    expect(applyKnownIdentity({ id: 'channel-1' }).id).toBe('channel-1');
    expect(mergeKnownIdentity({ id: 'other' }, getKnownIdentity('channel-1')).id).toBe('other');
  });
});

describe('reconciling against the server', () => {
  it('is a no-op when nothing has been recorded', () => {
    reconcileKnownIdentities([{ id: 'channel-1', avatar: 'avatar-before' }]);
    expect(getKnownIdentity('channel-1')).toBeUndefined();
  });

  it('accepts the plain-string display name the looser actor objects carry', () => {
    recordIdentityChange({ id: 'channel-1', name: { displayName: 'Daily Digest' } });

    reconcileKnownIdentities([{ id: 'channel-1', name: 'Daily Digest' }]);
    expect(getKnownIdentity('channel-1')).toBeUndefined();
  });

  it('keeps an entry an actor with no id cannot speak for', () => {
    recordIdentityChange({ id: 'channel-1', avatar: 'avatar-after' });

    reconcileKnownIdentities([{ avatar: 'avatar-after' }]);
    expect(getKnownIdentity('channel-1')).toEqual({ id: 'channel-1', avatar: 'avatar-after' });
  });

  /**
   * The two sides of answerability, and neither is optional.
   *
   * A post author carries no description at all — not an empty one, none — so
   * an entry holding one meets actors that can answer for some of what it holds
   * and nothing about the rest. Read that silence as disagreement and the
   * picture beside it is pinned for the session; read it as agreement and a
   * description edit is retired before anything ever confirmed it.
   */
  describe('a field the actor cannot answer for', () => {
    function editedEverything() {
      recordIdentityChange({
        id: 'channel-1',
        username: 'daily',
        name: { displayName: 'Daily Digest' },
        avatar: 'avatar-after',
        bio: 'bio-after',
      });
    }

    it('retires what a bio-less actor DOES confirm, and keeps the rest', () => {
      editedEverything();

      // A post author: handle, name and picture, never a description.
      reconcileKnownIdentities([
        { id: 'channel-1', username: 'daily', name: { displayName: 'Daily Digest' }, avatar: 'avatar-after' },
      ]);

      expect(getKnownIdentity('channel-1')).toEqual({ id: 'channel-1', bio: 'bio-after' });
    });

    it('retires the entry once an actor that CAN answer agrees', () => {
      editedEverything();

      reconcileKnownIdentities([
        { id: 'channel-1', username: 'daily', name: { displayName: 'Daily Digest' }, avatar: 'avatar-after' },
      ]);
      // A recommendation / followers row does carry one.
      reconcileKnownIdentities([{ id: 'channel-1', bio: 'bio-after' }]);

      expect(getKnownIdentity('channel-1')).toBeUndefined();
    });

    it('keeps correcting a description the server has not caught up with', () => {
      editedEverything();

      reconcileKnownIdentities([{ id: 'channel-1', bio: 'bio-before' }]);

      expect(getKnownIdentity('channel-1')).toEqual({
        id: 'channel-1',
        username: 'daily',
        name: { displayName: 'Daily Digest' },
        avatar: 'avatar-after',
        bio: 'bio-after',
      });
    });

    it('retires nothing at all while ANY field it can answer for differs', () => {
      editedEverything();

      // The picture caught up, the name did not. One lagging field is proof the
      // server copy is behind, so the picture's agreement proves nothing either.
      reconcileKnownIdentities([
        { id: 'channel-1', username: 'daily', name: { displayName: 'Daily' }, avatar: 'avatar-after' },
      ]);

      expect(getKnownIdentity('channel-1')).toEqual({
        id: 'channel-1',
        username: 'daily',
        name: { displayName: 'Daily Digest' },
        avatar: 'avatar-after',
        bio: 'bio-after',
      });
    });

    it('treats a REORDERED category list as a disagreement', () => {
      // The promotion IS the edit. A set-wise comparison calls this agreement
      // and retires the correction that carries it.
      recordIdentityChange({ id: 'channel-1', accountCategories: ['news', 'sports'] });

      reconcileKnownIdentities([{ id: 'channel-1', accountCategories: ['sports', 'news'] }]);

      expect(getKnownIdentity('channel-1')).toEqual({
        id: 'channel-1',
        accountCategories: ['news', 'sports'],
      });
    });

    it('retires the category list once an actor carries it in the same order', () => {
      recordIdentityChange({ id: 'channel-1', accountCategories: ['news', 'sports'] });

      reconcileKnownIdentities([{ id: 'channel-1', accountCategories: ['news', 'sports'] }]);

      expect(getKnownIdentity('channel-1')).toBeUndefined();
    });

    it('does not notify when every field is unanswerable', () => {
      recordIdentityChange({ id: 'channel-1', bio: 'bio-after' });
      const listener = jest.fn();
      const unsubscribe = subscribeToIdentityUpdates(listener);

      // Waking every mounted post row for a batch that said nothing is the cost
      // this guard avoids; it runs on every page of every feed.
      reconcileKnownIdentities([{ id: 'channel-1', username: 'daily', avatar: 'avatar-after' }]);

      expect(listener).not.toHaveBeenCalled();
      expect(getKnownIdentity('channel-1')).toEqual({ id: 'channel-1', bio: 'bio-after' });
      unsubscribe();
    });
  });
});
