/**
 * Feed Generator Feed
 *
 * Serves a third-party / algorithmic feed addressed by the `feedgen|<uri>`
 * descriptor. Today the only producer is the atproto connector: a Bluesky feed
 * generator (`app.bsky.feed.generator`) mirrored into a native {@link FeedGenerator}
 * record (`source.network === 'atproto'`). Mention cannot execute the remote
 * ranking algorithm, so it pulls the algorithm's OUTPUT live
 * (`app.bsky.feed.getFeed`) and imports each returned post as a NATIVE `Post`
 * authored by the already-synced federated Oxy user, then hydrates + returns them
 * in the generator's ranking order.
 *
 * The remote feed is the source of truth for ORDER (it is the algorithm's ranking),
 * so posts are served as flat ordered items — no re-ranking, no thread slicing —
 * mirroring the engine's `finalizeOrdered` path. Pagination rides the atproto
 * cursor. Bounded (page limit + the XRPC per-call deadline) and fail-soft: any
 * failure resolves to an empty page and never throws out of the feed engine.
 */

import type { HydratedPost } from '@mention/shared-types';
import { FeedAPI, FeedAPIResponse, FeedFetchOptions, FeedContext, FEED_FIELDS } from '../FeedAPI';
import { FeedGenerator } from '../../../models/FeedGenerator';
import { Post } from '../../../models/Post';
import { getFeed, importPostViews, type AtprotoPostView } from '../../../connectors/atproto/post.mapper';
import { postHydrationService } from '../../../services/PostHydrationService';
import { logger } from '../../../utils/logger';

/** Boosts/quote embeds hydrate their original only at depth ≥ 1. */
const HYDRATE_MAX_DEPTH = 1;

const EMPTY_RESPONSE: FeedAPIResponse = {
  slices: [],
  items: [],
  hasMore: false,
  nextCursor: undefined,
  totalCount: 0,
};

/** A lean `Post` document ordered by the remote generator's ranking. */
type OrderedPostDoc = { federation?: { activityId?: string } } & Record<string, unknown>;

export class FeedGeneratorFeed implements FeedAPI {
  readonly descriptor;
  private readonly generatorUri: string;

  constructor(generatorUri: string) {
    this.generatorUri = generatorUri;
    this.descriptor = `feedgen|${generatorUri}` as const;
  }

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    try {
      if (!(await this.isAtprotoBacked())) return undefined;

      const { posts } = await getFeed(this.generatorUri, { limit: 1 });
      const ordered = await this.importAndLoad(posts.slice(0, 1));
      if (ordered.length === 0) return undefined;

      const [hydrated] = await postHydrationService.hydratePosts([ordered[0]], {
        viewerId: context.currentUserId,
        oxyClient: context.oxyClient,
        maxDepth: HYDRATE_MAX_DEPTH,
        viewerGraph: this.viewerGraph(context),
      });
      return hydrated;
    } catch (err) {
      logger.warn('[FeedGeneratorFeed] peekLatest failed', { uri: this.generatorUri, err });
      return undefined;
    }
  }

  async fetch(options: FeedFetchOptions, context: FeedContext): Promise<FeedAPIResponse> {
    try {
      if (!(await this.isAtprotoBacked())) return { ...EMPTY_RESPONSE };

      const { posts, cursor } = await getFeed(this.generatorUri, {
        cursor: options.cursor,
        limit: options.limit,
      });
      const ordered = await this.importAndLoad(posts);

      // The atproto cursor is the authoritative "more pages" signal; it is opaque
      // and advances every page, so paging can never loop even on an empty page.
      const hasMore = Boolean(cursor);
      if (ordered.length === 0) {
        return { ...EMPTY_RESPONSE, hasMore, nextCursor: hasMore ? cursor : undefined };
      }

      const items = await postHydrationService.hydratePosts(ordered, {
        viewerId: context.currentUserId,
        oxyClient: context.oxyClient,
        maxDepth: HYDRATE_MAX_DEPTH,
        includeLinkMetadata: true,
        viewerGraph: this.viewerGraph(context),
      });

      return {
        slices: [],
        items,
        hasMore,
        nextCursor: hasMore ? cursor : undefined,
        totalCount: items.length,
      };
    } catch (err) {
      logger.warn('[FeedGeneratorFeed] fetch failed', { uri: this.generatorUri, err });
      return { ...EMPTY_RESPONSE };
    }
  }

  /**
   * Whether this descriptor resolves to a KNOWN atproto-backed generator. A missing
   * record or a non-atproto one has no remote content path, so the feed is empty
   * rather than an error (a stale `feedgen|<uri>` link can never break the engine).
   */
  private async isAtprotoBacked(): Promise<boolean> {
    const generator = await FeedGenerator.findOne({ uri: this.generatorUri })
      .select('source.network')
      .lean<{ source?: { network?: string } } | null>();
    if (generator?.source?.network === 'atproto') return true;
    logger.info('[FeedGeneratorFeed] no atproto-backed generator for descriptor', { uri: this.generatorUri });
    return false;
  }

  /**
   * Import a page of remote `PostView`s as native posts and load the resulting
   * `Post` documents back in the generator's ranking order. A URI whose import
   * genuinely failed has no document and is dropped (never rendered blank).
   */
  private async importAndLoad(postViews: ReadonlyArray<AtprotoPostView>): Promise<OrderedPostDoc[]> {
    const uris = await importPostViews(postViews);
    if (uris.length === 0) return [];

    const docs = await Post.find({ 'federation.activityId': { $in: uris } })
      .select(FEED_FIELDS)
      .lean<OrderedPostDoc[]>();

    const byUri = new Map<string, OrderedPostDoc>();
    for (const doc of docs) {
      const uri = doc.federation?.activityId;
      if (uri) byUri.set(uri, doc);
    }

    const ordered: OrderedPostDoc[] = [];
    for (const uri of uris) {
      const doc = byUri.get(uri);
      if (doc) ordered.push(doc);
    }
    return ordered;
  }

  /**
   * The viewer's social graph, threaded into hydration so it does NOT re-fetch the
   * follow graph from Oxy. Returns `undefined` (live-fetch fallback) unless BOTH id
   * lists are present, matching `FeedEngine`'s own `viewerGraphOption`.
   */
  private viewerGraph(context: FeedContext): { followingIds: string[]; followerIds: string[] } | undefined {
    if (!context.currentUserId) return undefined;
    if (context.followingIds === undefined || context.followerIds === undefined) return undefined;
    return { followingIds: context.followingIds, followerIds: context.followerIds };
  }
}
