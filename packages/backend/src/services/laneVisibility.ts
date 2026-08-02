/**
 * What a publisher's lane curation removes from their showcase.
 *
 * TWO RULES, and they are exactly the pair somebody "simplifies" into one later,
 * so both are stated here and enforced from here alone:
 *
 *  - **`tab` removes a post from the MAIN tab only.** The lane still has its own
 *    tab, and the post is still there. That is the whole point of `tab`: a
 *    carriageway that exists, is reachable, and does not crowd the front page.
 *  - **`hidden` removes a post from EVERY profile tab, the OWNER'S OWN VIEW
 *    INCLUDED.** "Not on the profile" is absolute — anything less means an owner
 *    checking their own profile sees a showcase nobody else sees. The owner still
 *    reaches the post by its URL and through the lane-management screen, and the
 *    post is still distributed to feeds, still federated, still searchable:
 *    `hidden` is curation of a showcase, never privacy.
 *
 * Both are applied by the CALLER as an exclusion on `posts.lane_id` — see
 * `buildAuthoredConditions` in `mtn/feed/engine/sources/userSources.ts`, which
 * has to spell the NULL case out: Mongo's `$nin` matched a document with no
 * `laneId`, but SQL's `not in` is NULL for a NULL column and would drop every
 * post outside every lane.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { lanes } from '../db/schema/channels';
import { logger } from '../utils/logger';
import type { AuthorFeedFilter, LaneDisplayMode, LaneOwnerType } from '@mention/shared-types';

/** Display modes that never appear on ANY profile tab. */
const HIDDEN_ONLY: readonly LaneDisplayMode[] = ['hidden'];

/** Display modes that never appear on the MAIN (`posts`) tab. */
const OFF_MAIN_TAB: readonly LaneDisplayMode[] = ['tab', 'hidden'];

/**
 * The display modes excluded from ONE profile tab.
 *
 * `likes` is deliberately absent from the caller's path entirely (it lists OTHER
 * people's posts, so the profile owner's curation has no bearing on it), but the
 * mapping is total so no tab can fall through unfiltered.
 */
export function excludedDisplayModesForTab(filter: AuthorFeedFilter): readonly LaneDisplayMode[] {
  return filter === 'posts' ? OFF_MAIN_TAB : HIDDEN_ONLY;
}

/**
 * The publisher's lane ids in any of `modes` — the ids a profile/channel query
 * excludes with `laneId: { $nin: … }`.
 *
 * One indexed lookup per feed request, served by `lanes_owner_idx`
 * (`owner_type, owner_id, …`). Fail-soft to `[]`: a lookup error must degrade to
 * an UNCURATED profile rather than an empty one — showing a post the owner meant
 * to tuck away is a far smaller harm than showing them nothing, and `hidden` is
 * curation rather than privacy (see the module docblock), so the safe direction
 * really is the permissive one here.
 */
export async function loadExcludedLaneIds(
  ownerType: LaneOwnerType,
  ownerId: string,
  modes: readonly LaneDisplayMode[],
): Promise<string[]> {
  if (!ownerId || modes.length === 0) return [];
  try {
    const rows = await getDb()
      .select({ id: lanes.id })
      .from(lanes)
      .where(
        and(
          eq(lanes.ownerType, ownerType),
          eq(lanes.ownerId, ownerId),
          inArray(lanes.displayMode, [...modes]),
        ),
      );
    return rows.map((row) => row.id);
  } catch (error) {
    logger.warn('[laneVisibility] Failed to load excluded lanes', error);
    return [];
  }
}

/**
 * Whether this user has ANY lane that removes posts from their profile.
 *
 * Read on the one path that treats an empty first page as "we have never
 * imported this author's posts" — see `resolveAuthorFeedPending`. With lanes, an
 * empty first page is reachable for an author who has plenty of posts and simply
 * curated them all off the tab, and that is CURATION, not missing federated
 * data. Fail-soft to `false`, which leaves the pre-lane behaviour intact.
 */
export async function ownerHasProfileAffectingLane(ownerId: string): Promise<boolean> {
  if (!ownerId) return false;
  try {
    const [lane] = await getDb()
      .select({ id: lanes.id })
      .from(lanes)
      .where(
        and(
          eq(lanes.ownerType, 'user'),
          eq(lanes.ownerId, ownerId),
          inArray(lanes.displayMode, [...OFF_MAIN_TAB]),
        ),
      )
      .limit(1);
    return lane != null;
  } catch (error) {
    logger.warn('[laneVisibility] Failed to probe profile-affecting lanes', error);
    return false;
  }
}
