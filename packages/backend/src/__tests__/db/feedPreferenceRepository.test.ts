/**
 * `user_feed_preferences` + `user_saved_feeds` against real rows.
 *
 * This replaces `__tests__/models/userFeedPreference.test.ts`, which asserted
 * the Mongoose schema's shape — that saved-feed subdocuments carried no `_id`,
 * and that `oxyUserId` was uniquely indexed. Both statements survive the port as
 * constraints rather than schema options (`user_saved_feeds` is keyed by
 * `(preference_id, key)`, `user_feed_preferences.oxy_user_id` is unique), so they
 * are asserted here against the database that now enforces them instead of
 * against a model object that no longer exists.
 *
 * The case worth the most is the one a stub cannot express: **having stored a
 * layout is not the same as having saved feeds.** The GET handler pins the
 * presets by their defaults for a first-time viewer and appends them unpinned
 * for a returning one, so collapsing the two silently re-pins the presets, on
 * every load, for every viewer who emptied their layout.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { userFeedPreferences, userSavedFeeds } from '../../db/schema/feeds';
import { loadFeedLayout, replaceFeedLayout } from '../../db/feeds/feedPreferenceRepository';

/** Scoped to this file: the table is shared by every parallel suite. */
const VIEWER = 'oxy-feed-pref-repo-viewer';

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  // `user_saved_feeds` cascades from `user_feed_preferences`.
  await getDb().delete(userFeedPreferences).where(eq(userFeedPreferences.oxyUserId, VIEWER));
});

afterAll(async () => {
  await closePostgres();
});

describe('a viewer with no stored layout', () => {
  it('reports no layout rather than an empty one', async () => {
    await expect(loadFeedLayout(VIEWER)).resolves.toEqual({ savedFeeds: [], hasStored: false });
  });
});

describe('storing a layout', () => {
  it('round-trips the feeds in order', async () => {
    await replaceFeedLayout(VIEWER, [
      { key: 'for_you', descriptor: 'for_you', pinned: true, order: 0 },
      { key: 'following', descriptor: 'following', pinned: false, order: 1 },
    ]);

    await expect(loadFeedLayout(VIEWER)).resolves.toEqual({
      hasStored: true,
      savedFeeds: [
        { key: 'for_you', descriptor: 'for_you', pinned: true, order: 0 },
        { key: 'following', descriptor: 'following', pinned: false, order: 1 },
      ],
    });
  });

  /**
   * Reading is ordered by `order`, not by insertion.
   *
   * The client sends the layout in display order and `order` is what carries it;
   * without the `ORDER BY` the rows come back in whatever order the heap gives,
   * which is usually insertion order — so this passes by accident unless the
   * fixture inserts them shuffled.
   */
  it('returns the feeds by their stored order, not the order they were written', async () => {
    await replaceFeedLayout(VIEWER, [
      { key: 'third', descriptor: 'trending', pinned: false, order: 2 },
      { key: 'first', descriptor: 'for_you', pinned: true, order: 0 },
      { key: 'second', descriptor: 'following', pinned: true, order: 1 },
    ]);

    const { savedFeeds } = await loadFeedLayout(VIEWER);
    expect(savedFeeds.map((feed) => feed.key)).toEqual(['first', 'second', 'third']);
  });

  /**
   * A saved feed is identified by its `key` within one layout.
   *
   * Mongo said this by giving the subdocument `_id: false`; Postgres says it
   * with `unique (preference_id, key)`. Replacing a layout therefore has to
   * clear the old rows first — leaving them beside the new ones violates it,
   * which is why the replace is one transaction.
   */
  it('replaces the layout rather than accumulating rows', async () => {
    await replaceFeedLayout(VIEWER, [
      { key: 'for_you', descriptor: 'for_you', pinned: true, order: 0 },
      { key: 'following', descriptor: 'following', pinned: true, order: 1 },
    ]);

    await replaceFeedLayout(VIEWER, [
      { key: 'for_you', descriptor: 'for_you', pinned: false, order: 0 },
    ]);

    const { savedFeeds } = await loadFeedLayout(VIEWER);
    expect(savedFeeds).toEqual([
      { key: 'for_you', descriptor: 'for_you', pinned: false, order: 0 },
    ]);
  });

  /**
   * THE distinction. A viewer who saved a layout and then removed every entry
   * has stored one — `hasStored` stays true while `savedFeeds` is empty.
   */
  it('still reports a stored layout after the viewer empties it', async () => {
    await replaceFeedLayout(VIEWER, [
      { key: 'for_you', descriptor: 'for_you', pinned: true, order: 0 },
    ]);

    await replaceFeedLayout(VIEWER, []);

    await expect(loadFeedLayout(VIEWER)).resolves.toEqual({ savedFeeds: [], hasStored: true });
  });

  /** A second save must reuse the viewer's row, not fail on its unique owner. */
  it('saves repeatedly without duplicating the viewer\'s preference row', async () => {
    await replaceFeedLayout(VIEWER, [{ key: 'a', descriptor: 'for_you', pinned: true, order: 0 }]);
    await replaceFeedLayout(VIEWER, [{ key: 'b', descriptor: 'following', pinned: true, order: 0 }]);

    const rows = await getDb()
      .select({ id: userFeedPreferences.id })
      .from(userFeedPreferences)
      .where(eq(userFeedPreferences.oxyUserId, VIEWER));
    expect(rows).toHaveLength(1);
  });

  it('leaves no orphaned saved feeds when the preference row is removed', async () => {
    await replaceFeedLayout(VIEWER, [{ key: 'a', descriptor: 'for_you', pinned: true, order: 0 }]);
    const [preference] = await getDb()
      .select({ id: userFeedPreferences.id })
      .from(userFeedPreferences)
      .where(eq(userFeedPreferences.oxyUserId, VIEWER));

    await getDb().delete(userFeedPreferences).where(eq(userFeedPreferences.oxyUserId, VIEWER));

    const orphans = await getDb()
      .select({ id: userSavedFeeds.id })
      .from(userSavedFeeds)
      .where(eq(userSavedFeeds.preferenceId, preference.id));
    expect(orphans).toEqual([]);
  });
});
