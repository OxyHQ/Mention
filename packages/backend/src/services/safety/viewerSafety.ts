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
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { laneMutes } from '../../db/schema/channels';
import { muteWords } from '../../db/schema/engagement';
import { userSettings } from '../../db/schema/userProfile';
import { logger } from '../../utils/logger';
import type { MuteTarget, MuteWordRule } from './muteWordMatcher';

/** The `mute_words.targets` element values, as `mute_words_targets_check` allows. */
const MUTE_TARGETS: readonly MuteTarget[] = ['content', 'tag'];

/**
 * Narrow one stored `targets` element.
 *
 * `targets` is a `text[]`, so drizzle hands it back as `string[]`: the element
 * CHECK (`mute_words_targets_check`) bounds the VALUES but cannot narrow the
 * TYPE. This filter is how the matcher's input is typed without a cast — it is
 * not a second line of defence, and it can never actually drop an element while
 * the constraint holds.
 */
function isMuteTarget(value: string): value is MuteTarget {
  return (MUTE_TARGETS as readonly string[]).includes(value);
}

/**
 * The viewer's "show sensitive/NSFW content" opt-in. `false` for anonymous
 * viewers, viewers with no settings, or on any load failure — only an explicit
 * stored `true` opts in.
 */
export async function loadShowSensitiveContent(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const [row] = await getDb()
      .select({ showSensitiveContent: userSettings.privacyShowSensitiveContent })
      .from(userSettings)
      .where(eq(userSettings.oxyUserId, userId))
      .limit(1);
    return row?.showSensitiveContent === true;
  } catch (error) {
    logger.warn('[viewerSafety] Failed to load showSensitiveContent preference', error);
    return false;
  }
}

/**
 * The viewer's muted words/hashtags, in the shape
 * {@link ./muteWordMatcher.compileMuteWords} consumes. One indexed query per
 * request — no N+1.
 *
 * Returns `[]` for anonymous viewers or on any load failure. `actorTarget` is
 * `NOT NULL DEFAULT 'all'` in the schema, so a row written before the field
 * existed still reads as applying to every author — the same answer Mongoose's
 * `?? 'all'` produced, now guaranteed by the column rather than the reader.
 */
export async function loadMuteWords(userId: string | undefined): Promise<MuteWordRule[]> {
  if (!userId) return [];
  try {
    const rows = await getDb()
      .select({
        value: muteWords.value,
        targets: muteWords.targets,
        actorTarget: muteWords.actorTarget,
      })
      .from(muteWords)
      .where(eq(muteWords.userId, userId));
    return rows.map((row) => ({
      value: row.value,
      targets: row.targets.filter(isMuteTarget),
      actorTarget: row.actorTarget,
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
    // `(viewer_oxy_user_id, created_at desc)` is indexed, so the cap is a real
    // limit on work rather than a truncation after the fact.
    const rows = await getDb()
      .select({ laneId: laneMutes.laneId })
      .from(laneMutes)
      .where(eq(laneMutes.viewerOxyUserId, userId))
      .orderBy(desc(laneMutes.createdAt))
      .limit(MAX_MUTED_LANES);
    return rows.map((row) => row.laneId);
  } catch (error) {
    logger.warn('[viewerSafety] Failed to load muted lanes', error);
    return [];
  }
}
