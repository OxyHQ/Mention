import type {
  HydratedPost,
  HydratedPostSummary,
} from '@mention/shared-types';
import type { FeedItem } from './schema';

type TransformOptions = {
  skipRelated?: boolean;
};

/**
 * Add the small set of local rendering/cache fields to the canonical hydrated
 * post contract.
 *
 * This is deliberately not a wire-format normalizer. Every active post endpoint
 * returns HydratedPost/HydratedPostSummary, so accepting `_id`, flat identity
 * fields, top-level viewer flags, or legacy stats here would hide a backend
 * contract regression and could retain another viewer's state.
 */
export function toFeedItem(
  post: HydratedPost | HydratedPostSummary,
  options: TransformOptions = {},
): FeedItem {
  const hydrated: HydratedPost = post;
  const mediaIds = post.attachments.media?.map((item) => item.id) ?? [];

  const originalPost = !options.skipRelated && hydrated.originalPost
    ? toFeedItem(hydrated.originalPost, { skipRelated: true })
    : null;
  const quotedPost = !options.skipRelated && hydrated.quotedPost
    ? toFeedItem(hydrated.quotedPost, { skipRelated: true })
    : null;
  const boost = hydrated.boost
    ? {
        ...hydrated.boost,
        originalPost: hydrated.boost.originalPost
          ? toFeedItem(hydrated.boost.originalPost, { skipRelated: true })
          : null,
      }
    : null;

  return {
    id: post.id,
    content: post.content,
    attachments: post.attachments,
    linkPreviews: post.linkPreviews,
    user: post.user,
    authors: post.authors,
    authorship: post.authorship,
    engagement: post.engagement,
    viewerState: post.viewerState,
    permissions: post.permissions,
    metadata: post.metadata,
    // Carried through explicitly, for the same reason as `replyContext` below.
    // A channel post's DTO keeps the channel in its OWN field precisely so
    // nothing collapses it into `user`, which means dropping it here loses the
    // whole signature: `PostItem` reads `storePost ?? post`, so a post that came
    // off this converter would render under its author's face instead of the
    // channel's, and would report "Replies are off" — the persisted
    // `replyPermission: ['nobody']` survives in `metadata` while the channel
    // that explains it does not.
    channel: post.channel,
    parentPostId: post.parentPostId,
    // Carried through explicitly, like every other field here. Drop it and a post
    // that came off this converter renders as a top-level post while the same
    // post rendered straight from the API shows "Replying to @…" — the local
    // cache would be the only surface silently missing its reply context.
    replyContext: post.replyContext,
    originalPost,
    quotedPost,
    boost,
    context: hydrated.context,
    date: post.metadata.createdAt,
    mediaIds,
    allMediaIds: mediaIds,
  };
}
