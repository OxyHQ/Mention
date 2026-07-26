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
    parentPostId: post.parentPostId,
    originalPost,
    quotedPost,
    boost,
    context: hydrated.context,
    date: post.metadata.createdAt,
    mediaIds,
    allMediaIds: mediaIds,
  };
}
