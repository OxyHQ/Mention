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
 * Neither rule may be expressed as a `match.$or`. `ChronoCursor.applyToQuery`
 * ASSIGNS `match.$or`, so a clause that put one there would filter correctly on
 * page one and silently stop filtering on every page after it. `$nin` on its own
 * key is a flat conjunctive term, and it also matches documents with NO `laneId`
 * at all — which is why a post with no lane needs no clause of its own.
 */

import { Lane } from '../models/Lane';
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
 * One indexed lookup per feed request, served by
 * `{ ownerType, ownerId, displayMode }`. Fail-soft to `[]`: a lookup error must
 * degrade to an UNCURATED profile rather than an empty one — showing a post the
 * owner meant to tuck away is a far smaller harm than showing them nothing.
 */
export async function loadExcludedLaneIds(
  ownerType: LaneOwnerType,
  ownerId: string,
  modes: readonly LaneDisplayMode[],
): Promise<string[]> {
  if (!ownerId || modes.length === 0) return [];
  try {
    const lanes = await Lane.find(
      { ownerType, ownerId, displayMode: { $in: modes } },
      { _id: 1 },
    ).lean<Array<{ _id: unknown }>>();
    return lanes.map((lane) => String(lane._id));
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
    const lane = await Lane.exists({
      ownerType: 'user',
      ownerId,
      displayMode: { $in: OFF_MAIN_TAB },
    });
    return lane != null;
  } catch (error) {
    logger.warn('[laneVisibility] Failed to probe profile-affecting lanes', error);
    return false;
  }
}
