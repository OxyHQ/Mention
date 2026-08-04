/**
 * WHETHER A CHANNEL NAMES THE PEOPLE WHO WRITE FOR IT.
 *
 * A channel is an Oxy account and AUTHORS its own posts; the person who wrote one
 * is recorded on `posts.written_by_oxy_user_id`, deliberately outside `authorship`.
 * `user_settings.channel_account.sign_posts` is the WHOLE disclosure decision,
 * and this module is the one place that reads it.
 *
 * It lives apart from `PostHydrationService` because two surfaces now ask the
 * same question — the post byline ("name the writer of THIS post") and the
 * channel's writers list ("name everyone who has written for this channel") — and
 * two implementations of a consent gate is how they end up disagreeing. One of
 * the two answers would then be a leak, and the one that leaks is not
 * recoverable: a name published without consent cannot be un-published by a later
 * request that gets it right.
 *
 * It fails CLOSED at every step. A channel with no settings row is absent from
 * the signing set, a channel that never opted in is absent, a lookup that THROWS
 * yields an empty set, and an account that is not a channel is refused whatever
 * its settings row happens to say. Anonymity is the safe answer at each of them.
 */

import type { AccountKind } from '@oxyhq/contracts';
import { loadChannelSignPostsByIds } from '../db/userProfile/userSettingsRepository';
import { logger } from '../utils/logger';

/**
 * Which of `candidateChannelIds` have `channelAccount.signPosts === true`, in
 * ONE narrow query.
 *
 * Batched over the whole candidate set on purpose: hydration asks about every
 * channel on a page at once, so a feed never pays a settings read per post.
 * An empty candidate set skips the query entirely, which is what makes an
 * ordinary page of posts cost nothing for this.
 *
 * The `=== true` is deliberate rather than incidental, and it did not stop being
 * so when this moved onto Postgres. The column is NULLABLE, and a NULL means
 * "this account is not a channel" — so `null`, `false` and a row that does not
 * exist at all must every one of them mean anonymous, which is exactly what an
 * identity check gives and what any looser read (`Boolean(...)`, `!= null`,
 * a truthiness test) would get wrong in the disclosing direction.
 */
export async function loadSigningChannelIds(
  candidateChannelIds: Iterable<string>,
): Promise<Set<string>> {
  const ids = [
    ...new Set(
      [...candidateChannelIds].filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  if (ids.length === 0) {
    return new Set();
  }

  try {
    const signPostsById = await loadChannelSignPostsByIds(ids);

    const signing = new Set<string>();
    for (const [oxyUserId, signPosts] of signPostsById) {
      if (signPosts === true) {
        signing.add(oxyUserId);
      }
    }
    return signing;
  } catch (error) {
    logger.error('[ChannelWriterDisclosure] Failed to load channel signing settings:', error);
    return new Set();
  }
}

/**
 * Whether this account discloses its writers — BOTH clauses, in one place.
 *
 * The settings row is not sufficient on its own: `channelAccount.signPosts`
 * means something on exactly one kind of account, so a row saying `true` under
 * a PERSONAL account is not a channel disclosing its writer, it is a row that
 * should not exist. Reading it as consent would name somebody on a person's own
 * post.
 *
 * `account` is the resolved Oxy identity (a `PostUser`, or anything else
 * carrying its `kind`) — Oxy owns the account kind, so it is read from the
 * identity that came back, never inferred from the presence of a settings
 * row. That the column is NULL for a non-channel makes the two checks
 * correlated in practice, which is precisely why BOTH are kept: a correlation
 * is not a guarantee, and the one that fails open here publishes a name.
 */
export function disclosesWriters(
  channelOxyUserId: string,
  account: { kind?: AccountKind } | undefined,
  signingChannelIds: ReadonlySet<string>,
): boolean {
  if (!channelOxyUserId) return false;
  if (account?.kind !== 'channel') return false;
  return signingChannelIds.has(channelOxyUserId);
}
