/**
 * `user_feed_preferences` + `user_saved_feeds` — the viewer's saved-feed layout.
 *
 * ## "Has a stored layout" is NOT "has saved feeds"
 *
 * The GET handler merges `PRESET_FEEDS` differently depending on whether the
 * viewer has ever saved a layout: a first-time viewer gets the presets with
 * their `defaultPinned` honoured, and a returning one gets them appended
 * UNPINNED, because they have already had the chance to pin what they wanted.
 *
 * Mongo carried that distinction for free — `doc` was null or it was not — and
 * an empty `savedFeeds` array on an existing document was a perfectly ordinary
 * state (save a layout, then remove every entry). Collapsing the two here would
 * silently re-pin the presets for exactly those viewers, on every load, with no
 * error. So {@link loadFeedLayout} returns the two facts separately rather than
 * letting the caller infer one from the other.
 *
 * ## The layout is replaced, not merged
 *
 * `PUT /feed/preferences` sends the whole layout, so the write is
 * delete-then-insert inside one transaction. A partial failure that left the
 * old rows beside the new ones would violate `(preference_id, key)` and is the
 * reason it is a transaction rather than two statements.
 */

import { eq } from 'drizzle-orm';
import type { SavedFeed } from '@mention/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { userFeedPreferences, userSavedFeeds } from '../schema/feeds';

/** A viewer's stored layout, and whether they have one at all. */
export interface FeedLayout {
  /** The saved feeds, in stored order. Empty is a legitimate stored state. */
  savedFeeds: SavedFeed[];
  /**
   * Whether a preference row exists for this viewer.
   *
   * Distinct from `savedFeeds.length > 0` — see the module comment.
   */
  hasStored: boolean;
}

/** The viewer's stored layout. */
export async function loadFeedLayout(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<FeedLayout> {
  const [preference] = await db
    .select({ id: userFeedPreferences.id })
    .from(userFeedPreferences)
    .where(eq(userFeedPreferences.oxyUserId, oxyUserId))
    .limit(1);

  if (!preference) return { savedFeeds: [], hasStored: false };

  const rows = await db
    .select({
      key: userSavedFeeds.key,
      descriptor: userSavedFeeds.descriptor,
      pinned: userSavedFeeds.pinned,
      order: userSavedFeeds.order,
    })
    .from(userSavedFeeds)
    .where(eq(userSavedFeeds.preferenceId, preference.id))
    .orderBy(userSavedFeeds.order);

  return {
    savedFeeds: rows.map((row) => ({
      key: row.key,
      descriptor: row.descriptor as SavedFeed['descriptor'],
      pinned: row.pinned,
      order: row.order,
    })),
    hasStored: true,
  };
}

/**
 * Replace the viewer's layout with `savedFeeds`, creating the preference row if
 * this is their first save.
 *
 * @returns The layout as stored, read back rather than echoed.
 */
export async function replaceFeedLayout(
  oxyUserId: string,
  savedFeeds: readonly SavedFeed[],
  db: DatabaseOrTransaction = getDb(),
): Promise<SavedFeed[]> {
  return db.transaction(async (tx) => {
    const [preference] = await tx
      .insert(userFeedPreferences)
      .values({ oxyUserId })
      // A save from a viewer who already has a row must still return that row's
      // id, so this cannot be `DO NOTHING` — that returns nothing on conflict.
      .onConflictDoUpdate({
        target: userFeedPreferences.oxyUserId,
        set: { oxyUserId },
      })
      .returning({ id: userFeedPreferences.id });

    await tx.delete(userSavedFeeds).where(eq(userSavedFeeds.preferenceId, preference.id));

    if (savedFeeds.length > 0) {
      await tx.insert(userSavedFeeds).values(
        savedFeeds.map((feed) => ({
          preferenceId: preference.id,
          key: feed.key,
          descriptor: feed.descriptor,
          pinned: feed.pinned ?? false,
          order: feed.order ?? 0,
        })),
      );
    }

    const { savedFeeds: stored } = await loadFeedLayout(oxyUserId, tx);
    return stored;
  });
}
