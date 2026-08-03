/**
 * Channels — the people who write for one.
 *
 * A channel is an Oxy ACCOUNT that authors its own posts; the human who wrote
 * one is recorded on the post but never shipped, and `UserSettings.channel
 * .signPosts` decides whether that person is NAMED on the post's byline. When a
 * channel names them, its page gains a list of everyone it has already named.
 *
 * The list is derived from POSTS — the distinct writers of the channel's public,
 * published posts — and never from the account's member list. Those are two
 * different facts: a member is somebody who MAY write, which includes people who
 * never have and who never consented to being named anywhere. Every name in this
 * list is one the channel is already publishing on a post any reader can open.
 */

import type { PostUser } from './post';

/**
 * One writer of a channel, with the moment they last published under it.
 *
 * `writer` is the canonical Oxy {@link PostUser} passed through UNCHANGED —
 * `name.displayName` renders directly, `avatar` stays a bare Oxy file id for
 * Bloom's `ImageResolver`, and the handle is derived with
 * `getNormalizedUserHandle`. A writer Oxy could not resolve arrives degraded
 * (empty `username`, `'Unknown user'`), never as a raw id.
 */
export interface ChannelWriter {
  writer: PostUser;
  /**
   * When this writer last published under the channel, ISO 8601. Also the
   * pagination sort key — the list is ordered by it, newest first.
   */
  lastPostAt: string;
}

/**
 * One page of a channel's writers, most recently published first.
 *
 * `nextCursor` is an opaque keyset token echoed back as `?cursor=` to fetch the
 * following page; its ABSENCE is the end of the list.
 *
 * A channel that does not name its writers has no list at all — the endpoint
 * answers 404 there, exactly as it does for an account that is not a channel and
 * for a channel this reader may not see, so nothing in the response shape can
 * report on a set that was never disclosed.
 */
export interface ChannelWritersResponse {
  writers: ChannelWriter[];
  nextCursor?: string;
}

/**
 * What deleting a channel destroys, counted.
 *
 * Shipped so a confirmation can SAY what it is about to take. A channel is a
 * publication rather than a profile, and "are you sure?" is not informed consent
 * for destroying an archive — the operator is told how many posts go before they
 * are asked, and told it again by the same shape once the deletion has run.
 *
 * Deliberately NARROWER than the server's own preview, which also carries the
 * channel id, the replies count (structurally always 0, since a channel takes no
 * replies) and the number of foreign quotes that are KEPT with their pointer
 * cleared. Those are operational facts for a log; a person deciding whether to
 * delete their channel is owed the two numbers below and nothing they would have
 * to interpret.
 */
export interface ChannelDeletionCounts {
  /** The channel's own posts. Every one of them is destroyed. */
  posts: number;
  /**
   * Other people's boosts of those posts, destroyed alongside them.
   *
   * A boost renders entirely from the post it points at, so once that post is
   * gone it is a card with nothing behind it rather than something somebody
   * wrote. Stated separately because the rows belong to other people, and an
   * operator should know their action reaches beyond their own account.
   */
  boostsByOthers: number;
}
