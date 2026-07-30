import type { FeedDescriptor, HydratedPost } from '@mention/shared-types';

import { logger } from '@oxyhq/core/logger';

import {
  followingWidgetNeedsFeed,
  publishFollowingWidgetFeed,
  publishTrendingWidgetFeed,
} from './index';

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
 * That is true of {@link syncFeedWidget} and STOPS BEING TRUE at
 * {@link prefetchFollowingWidgetFeed}, which spends a request on purpose. The
 * two live in the same file and have opposite cost profiles; read each one's own
 * doc rather than the paragraph above.
 *
 * Neither replaces the workers, and must not: the app is opened irregularly, and
 * a widget on a phone nobody has opened for a day still has to update itself.
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

/**
 * Whether this response is a moment worth ASKING the widget if it wants a
 * following page fetched for it.
 *
 * This is the JS half of a two-sided gate. It answers "is the app in a state
 * where such a request would make sense at all"; the expensive half — is a
 * widget even placed, and is its batch actually stale — is
 * {@link followingWidgetNeedsFeed}, answered natively because only that side
 * knows. Asking here first keeps the native round trip off the hot path.
 *
 * Four rules:
 *
 *  1. **Not while one is already in flight.** Two feed screens opening together
 *     would otherwise each start a fetch for the same widget.
 *  2. **Not when signed out.** Without a bearer the request answers 200 with
 *     zero posts (`descriptor=following` does), so it would spend a request to
 *     learn nothing and leave the store exactly as stale.
 *  3. **Not on a `following` load.** That response already fed the widget. This
 *     rule is also what makes recursion impossible BY CONSTRUCTION rather than
 *     by luck: the fetch this function authorises is itself a `following` load,
 *     and it cannot authorise another.
 *  4. **Only on a first page.** A reader paging through a feed is mid-session,
 *     not opening the app.
 */
export function shouldOfferFollowingPrefetch({
  descriptor,
  cursor,
  viewerId,
  prefetchInFlight,
}: {
  descriptor: FeedDescriptor;
  cursor: string | undefined;
  viewerId: string | null;
  prefetchInFlight: boolean;
}): boolean {
  if (prefetchInFlight) return false;
  if (!viewerId) return false;
  if (descriptor === 'following') return false;
  if (cursor) return false;
  return true;
}

let prefetchInFlight = false;

/**
 * Fetch the following timeline FOR THE WIDGET, when that is worth a request.
 *
 * ## This one is not free, unlike {@link syncFeedWidget}
 *
 * It exists because the handoff only ever covers the feed the reader opened, and
 * Mention's home defaults to For You — so the following widget would be fed only
 * on a visit to a tab many readers rarely open, which is a widget that does not
 * update. The card whose staleness shows most is exactly that one, because the
 * posts on it are the reader's own people.
 *
 * The cost is bounded by the two gates rather than by hope: no request at all
 * unless a following widget is placed (almost nobody), and at most one per
 * `FETCH_INTERVAL_MS` of app usage after that, because the native side declines
 * while the stored batch is still fresh.
 *
 * It fetches through the caller's own feed path and does nothing with the
 * result: the response goes through {@link syncFeedWidget} inside that call like
 * any other following load, so the projection, the account check and the store
 * write happen in exactly one place.
 *
 * Fire-and-forget. Nothing the app renders depends on it, and a failure is a
 * home screen that stays a batch behind — worth a diagnostic line, not a
 * surfaced error.
 */
export function prefetchFollowingWidgetFeed({
  descriptor,
  cursor,
  viewerId,
  fetchFollowingPage,
}: {
  descriptor: FeedDescriptor;
  cursor: string | undefined;
  viewerId: string | null;
  /** The caller's own `following` fetch. Its response feeds the widget on the way through. */
  fetchFollowingPage: () => Promise<unknown>;
}): void {
  if (!shouldOfferFollowingPrefetch({ descriptor, cursor, viewerId, prefetchInFlight })) {
    return;
  }

  prefetchInFlight = true;
  void (async () => {
    try {
      if (await followingWidgetNeedsFeed()) {
        await fetchFollowingPage();
      }
    } catch (error: unknown) {
      logger.debug('Could not refill the following widget', { error });
    } finally {
      prefetchInFlight = false;
    }
  })();
}
