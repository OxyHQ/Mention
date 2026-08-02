/**
 * The viewer's stored safety preferences — the ONE read path for the two per-user
 * settings that gate what content a read surface may show them:
 *
 *   - `privacy.showSensitiveContent` (default `false`): the sensitive/NSFW opt-in
 *     that makes the {@link ../../mtn/feed/feedSafety} gate viewer-conditional.
 *   - the viewer's muted words/hashtags, compiled by
 *     {@link ./muteWordMatcher.compileMuteWords}.
 *
 * Both used to be loaded inline by whichever surface happened to need them (the
 * sensitivity opt-in inside the feed-context assembler, the muted words inside the
 * MTN feed controller), which is why search and notifications consulted neither.
 * Loading them here lets any read surface apply the same rules with one import.
 *
 * Every loader is best-effort and soft-fails toward the SAFE default: an unknown
 * preference means "do not show sensitive content", and a failed muted-word lookup
 * means "no mutes" rather than a broken response — a lookup error must never break
 * a feed, a search, or a notification list.
 */

import { MAX_MUTED_LANES } from '@mention/shared-types';
import UserSettings from '../../models/UserSettings';
import { MuteWord } from '../../models/MuteWord';
import { LaneMute } from '../../models/LaneMute';
import { logger } from '../../utils/logger';
import type { MuteActorTarget, MuteTarget, MuteWordRule } from './muteWordMatcher';

/**
 * The viewer's "show sensitive/NSFW content" opt-in. `false` for anonymous
 * viewers, viewers with no settings, or on any load failure — only an explicit
 * stored `true` opts in.
 */
export async function loadShowSensitiveContent(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const doc = await UserSettings.findOne({ oxyUserId: userId }, { 'privacy.showSensitiveContent': 1 }).lean();
    return doc?.privacy?.showSensitiveContent === true;
  } catch (error) {
    logger.warn('[viewerSafety] Failed to load showSensitiveContent preference', error);
    return false;
  }
}

/** Lean projection of a `MuteWord` row — exactly the fields the matcher reads. */
interface MuteWordLean {
  value: string;
  targets: MuteTarget[];
  actorTarget?: MuteActorTarget;
}

/**
 * The viewer's muted words/hashtags, in the shape
 * {@link ./muteWordMatcher.compileMuteWords} consumes. One indexed query per
 * request — no N+1.
 *
 * Returns `[]` for anonymous viewers or on any load failure. `actorTarget` defaults
 * to `'all'` so a legacy row written before the field existed applies to every
 * author, matching the model default.
 */
export async function loadMuteWords(userId: string | undefined): Promise<MuteWordRule[]> {
  if (!userId) return [];
  try {
    const docs = await MuteWord.find(
      { userId },
      { value: 1, targets: 1, actorTarget: 1 },
    ).lean<MuteWordLean[]>();
    return docs.map((doc) => ({
      value: doc.value,
      targets: doc.targets,
      actorTarget: doc.actorTarget ?? 'all',
    }));
  } catch (error) {
    logger.warn('[viewerSafety] Failed to load muted words', error);
    return [];
  }
}

/**
 * The lane ids this reader has silenced — "do not push me this carriageway".
 *
 * **Deliberately NARROWER than {@link loadMuteWords}, and the difference is the
 * point.** Search and notifications consult muted WORDS because a muted word is a
 * safety rule about material the reader must not be shown at all. A muted lane is
 * a TIMELINE preference. Searching for something, or opening a post, is an
 * explicit act of retrieval by the reader; suppressing their own retrieval would
 * make the product look broken. So v1 applies this to FEEDS only — not search,
 * not notifications, not the post detail, not OG cards.
 *
 * Returns `[]` for anonymous readers and on any load failure: a lookup error must
 * degrade to an unfiltered feed rather than a broken one. Capped at
 * {@link MAX_MUTED_LANES}, which the mute route also enforces on write — the cap
 * is repeated here so a row set that somehow grew past it (a direct write, an
 * older cap) cannot make every feed request unboundedly large.
 */
export async function loadMutedLaneIds(userId: string | undefined): Promise<string[]> {
  if (!userId) return [];
  try {
    const docs = await LaneMute.find(
      { viewerOxyUserId: userId },
      { laneId: 1 },
    )
      .sort({ createdAt: -1 })
      .limit(MAX_MUTED_LANES)
      .lean<Array<{ laneId: string }>>();
    return docs.map((doc) => doc.laneId);
  } catch (error) {
    logger.warn('[viewerSafety] Failed to load muted lanes', error);
    return [];
  }
}
