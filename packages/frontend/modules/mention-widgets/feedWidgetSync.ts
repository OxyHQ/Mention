import type { FeedDescriptor, HydratedPost } from '@mention/shared-types';

import { logger } from '@/lib/logger';

import { publishFollowingWidgetFeed, publishTrendingWidgetFeed } from './index';

/**
 * When a feed the app just downloaded is worth handing to a home-screen widget.
 *
 * ## The problem this solves
 *
 * The two feed-card widgets fetch on their own: a WorkManager tick every fifteen
 * minutes, going to the network only once the stored batch is half an hour old,
 * and both stretched further by Doze. So the posts on a home screen can be half
 * an hour behind — while the app, every time it is opened, downloads that exact
 * feed anyway.
 *
 * Handing that page over costs NO extra request. It is the cheapest freshness in
 * the whole widget, and it lands at the moment the reader was demonstrably
 * engaged rather than at a moment a scheduler picked.
 *
 * It does not replace the workers, and must not: the app is opened irregularly,
 * and a widget on a phone nobody has opened for a day still has to update
 * itself.
 *
 * ## What crosses the bridge
 *
 * Not the hydrated posts — about 5KB each, most of it engagement counts, viewer
 * state and permissions no card reads. {@link toWidgetFeedPosts} projects each
 * one down to the ten strings the card's rules consume, and the native side runs
 * those rules (`feedcard`'s `buildWidgetPost`) over them exactly as it does over
 * a page the worker fetched. So this module knows the WIRE FIELDS a post carries
 * and nothing at all about what a card decides to draw.
 */

/**
 * One post, projected to what the widget's card rules read.
 *
 * Field names are the native side's own vocabulary — the same ones it reads out
 * of the feed response and writes into its store — so there is one set of names
 * across the three encodings rather than three.
 *
 * Every field is a plain string, EMPTY for absent, never `undefined`: the native
 * rules already treat empty as "there is none" (a post with no picture, an
 * author whose handle could not be resolved), so a second way of spelling
 * absence would be a second thing to get right on both sides of the bridge.
 */
export interface WidgetFeedPost {
  /** Mention post id — the card's deep-link target. */
  id: string;
  /** The post's own body text. */
  text: string;
  /** First link preview's title, which the card prefers over the body. */
  title: string;
  /** First attached media's thumbnail, original, and alt text. */
  thumbUrl: string;
  url: string;
  alt: string;
  /** First link preview's image — the fallback when there is no attached media. */
  image: string;
  /** Author display name, handle, and avatar (a bare Oxy file id or a remote URL). */
  name: string;
  username: string;
  avatar: string;
}

/**
 * Which widget a handed-over page belongs to, and under which account.
 *
 * A discriminated union rather than a widget name plus an optional account,
 * because the account is not optional on the following widget — it is the thing
 * that decides whether the page may be stored at all.
 */
export type FeedWidgetHandoff =
  | { widget: 'trending' }
  | { widget: 'following'; accountId: string };

export interface FeedWidgetHandoffDecision {
  /** The descriptor that was requested. */
  descriptor: FeedDescriptor;
  /** The page cursor, absent for a first page. */
  cursor: string | undefined;
  /**
   * The account the request went out as, decoded from the access token it
   * carried — the server's own answer, not app state. `null` when anonymous.
   */
  viewerIdBefore: string | null;
  /**
   * And the same, read again when the response came back. A DIFFERENT value
   * means an account switch raced the request, so the page cannot be attributed
   * to either account with confidence.
   */
  viewerIdAfter: string | null;
  /** How many posts came back. */
  postCount: number;
}

/**
 * Whether this response is worth handing over, and to which widget.
 *
 * Five rules, in order:
 *
 *  1. **Nothing came back — do nothing.** This is a correctness rule and not
 *     merely an optimisation: `descriptor=following` answers an UNAUTHENTICATED
 *     request with HTTP 200 and zero posts, so an empty page is exactly what a
 *     request whose bearer did not apply looks like. Refusing to hand over an
 *     empty page means that case can never reach a store.
 *  2. **Only the FIRST page.** A widget shows the top of a feed; page four of an
 *     infinite scroll is not that, and writing on every page would turn one
 *     reading session into a dozen store writes and redraws.
 *  3. **Only if the identity held still.** A switch mid-flight leaves a page
 *     that belongs to whichever account the server saw, which is no longer
 *     something this client can assert. Dropped rather than guessed at.
 *  4. **`explore` feeds the trending-posts widget**, with no account: that
 *     rotation is anonymous, and the native side stamps it with nothing.
 *  5. **`following` feeds the following widget**, and only while signed in. The
 *     account travels with it as a claim the native side checks against the
 *     device credential.
 *
 * Every other descriptor is ignored. `for_you` in particular is NOT handed to
 * either widget: it is neither the Explore ranking the trending card is labelled
 * with nor the timeline the following card is labelled with, and a card that
 * says one thing while showing another is worse than a card that is stale.
 */
export function feedWidgetHandoffFor({
  descriptor,
  cursor,
  viewerIdBefore,
  viewerIdAfter,
  postCount,
}: FeedWidgetHandoffDecision): FeedWidgetHandoff | null {
  if (postCount <= 0) return null;
  if (cursor) return null;
  if (viewerIdBefore !== viewerIdAfter) return null;
  if (descriptor === 'explore') return { widget: 'trending' };
  if (descriptor === 'following' && viewerIdBefore) {
    return { widget: 'following', accountId: viewerIdBefore };
  }
  return null;
}

/**
 * Posts sent in one handoff.
 *
 * The widget keeps five and chooses them by which have pictures, so what it
 * needs is a POOL rather than five posts — the feed carries a picture on roughly
 * a fifth of them, and five taken in order usually contain none. Thirty is the
 * pool the widget's own fetch asks for, so a handed-over page gives its choice
 * the same room; beyond that it is bytes crossing the bridge that the choice
 * cannot reach.
 */
export const MAX_WIDGET_HANDOFF_POSTS = 30;

/**
 * Project a page of hydrated posts down to what a card reads.
 *
 * Only the FIRST attached media and the FIRST link preview, because a card draws
 * one picture. Every optional leaf collapses to `''` — see {@link WidgetFeedPost}
 * for why absence has one spelling here.
 *
 * `name.displayName` is passed through as the DTO carries it: a post whose
 * author has none is DROPPED natively (a byline that cannot name anyone could be
 * attributed to anyone), and inventing a fallback name here would be this module
 * overriding that rule from the wrong side of the bridge.
 */
export function toWidgetFeedPosts(posts: readonly HydratedPost[]): WidgetFeedPost[] {
  return posts.slice(0, MAX_WIDGET_HANDOFF_POSTS).map((post) => {
    const media = post.attachments.media?.[0];
    const preview = post.linkPreviews?.[0];
    return {
      id: post.id,
      text: post.content.text ?? '',
      title: preview?.title ?? '',
      thumbUrl: media?.thumbUrl ?? '',
      url: media?.url ?? '',
      alt: media?.alt ?? '',
      image: preview?.image ?? '',
      name: post.user.name.displayName ?? '',
      username: post.user.username ?? '',
      avatar: post.user.avatar ?? '',
    };
  });
}

/**
 * Apply {@link feedWidgetHandoffFor} to a response and act on it.
 *
 * Call it with every descriptor feed response the app receives; it decides
 * whether that response is one a widget wants.
 *
 * Fire-and-forget, like every other telemetry-shaped write in the app: the home
 * screen being a batch behind is not something to surface to a reader, but it
 * should stay visible in diagnostics. The native side no-ops when the widget in
 * question is not on a home screen, so nothing here has to ask.
 */
export function syncFeedWidget(
  decision: FeedWidgetHandoffDecision,
  posts: readonly HydratedPost[],
): void {
  const handoff = feedWidgetHandoffFor(decision);
  if (!handoff) return;

  const body = JSON.stringify(toWidgetFeedPosts(posts));
  const published =
    handoff.widget === 'trending'
      ? publishTrendingWidgetFeed(body)
      : publishFollowingWidgetFeed(handoff.accountId, body);

  void published.catch((error: unknown) => {
    logger.debug('Could not hand the feed to its home-screen widget', {
      widget: handoff.widget,
      error,
    });
  });
}
