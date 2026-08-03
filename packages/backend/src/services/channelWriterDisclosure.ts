/**
 * WHETHER A CHANNEL NAMES THE PEOPLE WHO WRITE FOR IT.
 *
 * A channel is an Oxy account and AUTHORS its own posts; the person who wrote one
 * is recorded on `Post.writtenByOxyUserId`, deliberately outside `authorship`.
 * `UserSettings.channel.signPosts` is the WHOLE disclosure decision, and this
 * module is the one place that reads it.
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
import { UserSettings } from '../models/UserSettings';
import { logger } from '../utils/logger';

/**
 * Which of `candidateChannelIds` have `channel.signPosts === true`, in ONE
 * indexed `UserSettings` query.
 *
 * Batched over the whole candidate set on purpose: hydration asks about every
 * channel on a page at once, so a feed never pays a settings read per post.
 * An empty candidate set skips the query entirely, which is what makes an
 * ordinary page of posts cost nothing for this.
 *
 * The `=== true` is deliberate rather than incidental. The value is read out of a
 * document, so it is not the schema's word that reaches this line, and a loose
 * read (`Boolean(...)`) would disclose on any truthy value a stray write or a
 * hand-edited document left behind — `"false"`, `1`, `{}`. Every one of those
 * must mean anonymous.
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
    const rows = await UserSettings.find({ oxyUserId: { $in: ids } })
      .select('oxyUserId channel.signPosts')
      .lean<Array<{ oxyUserId?: string; channel?: { signPosts?: unknown } }>>();

    const signing = new Set<string>();
    for (const row of rows) {
      if (row?.oxyUserId && row.channel?.signPosts === true) {
        signing.add(String(row.oxyUserId));
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
 * The settings row is not sufficient on its own: `channel.signPosts` means
 * something on exactly one kind of account, so a row saying `true` under a
 * PERSONAL account is not a channel disclosing its writer, it is a row that
 * should not exist. Reading it as consent would name somebody on a person's own
 * post.
 *
 * `account` is the resolved Oxy identity (a `PostUser`, or anything else
 * carrying its `kind`) — Oxy owns the account kind, so it is read from the
 * identity that came back, never inferred from the presence of a settings
 * subdocument.
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
