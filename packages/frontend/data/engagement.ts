import { action } from '@oxy.so/bloom-data';
import { queryClient } from '@/lib/queryClient';
import { markLocalAction } from '@/services/echoGuard';
import { feedService } from '@/services/feedService';
import { invalidateEngagementLists } from '@/stores/engagementInvalidation';
import { invalidateProfileCounts } from '@/stores/profileCountsInvalidation';
import { Post } from './posts';

/**
 * The viewer's engagement with a post: like, downvote, boost and save, each an
 * optimistic action (`@oxy.so/bloom-data`). The change shows at once as a
 * layer over the server's copy; a realtime echo or a feed refresh landing
 * meanwhile cannot move it. On success the server's counts settle it; on
 * failure the layer goes, leaving the server's copy as it now stands.
 *
 * A like and its undo share one key, as do a save and its undo: while one is
 * in flight, a second tap is ignored.
 */

interface Answer {
  success: boolean;
  data?: unknown;
}

/** A call the server did not confirm is a failure, rolled back like a thrown one. */
function confirmed<T extends Answer>(answer: T, what: string): T {
  if (!answer.success) throw new Error(`Failed to ${what}`);
  return answer;
}

/**
 * Replace the optimistic ±1 with what the server holds. Counts are the
 * server's (a ±1 applied to a stale base moves by the right amount from the
 * wrong number and never converges); the like and downvote flags come with them.
 */
function settleVote(postId: string, data: unknown): void {
  const body = data as Record<string, unknown> | undefined;
  const likes = body?.likesCount;
  if (typeof likes !== 'number') return;
  const downvotes = body?.downvotesCount;
  Post.merge(postId, {
    viewerState: { isLiked: body?.liked === true, isDownvoted: body?.downvoted === true },
    engagement: { likes, ...(typeof downvotes === 'number' ? { downvotes } : {}) },
  });
}

/**
 * The save counterpart: the count is the number of bookmark rows, which both
 * `POST` and `DELETE /posts/:id/save` return. `isSaved` comes from the call: a
 * 200 means the post is in the requested state whether or not this request
 * changed it.
 */
function settleSave(postId: string, data: unknown, isSaved: boolean): void {
  const saves = (data as Record<string, unknown> | undefined)?.savesCount;
  if (typeof saves !== 'number') return;
  Post.merge(postId, { viewerState: { isSaved }, engagement: { saves } });
}

export const likePost = action<[postId: string, source?: string], Answer>({
  key: (postId) => `${postId}:like`,
  optimistic: (postId) => {
    markLocalAction(postId, 'like');
    Post.patch(postId, (post) =>
      post.viewerState.isLiked
        ? undefined
        : {
            viewerState: { isLiked: true },
            engagement: { likes: (post.engagement.likes ?? 0) + 1 },
          },
    );
  },
  run: async (postId, source) => confirmed(await feedService.voteItem(postId, 1, source), 'like'),
  settle: (answer, postId) => {
    settleVote(postId, answer.data);
    invalidateEngagementLists('like');
  },
});

export const unlikePost = action<[postId: string], Answer>({
  key: (postId) => `${postId}:like`,
  optimistic: (postId) => {
    markLocalAction(postId, 'unlike');
    Post.patch(postId, (post) =>
      post.viewerState.isLiked
        ? {
            viewerState: { isLiked: false },
            engagement: { likes: Math.max(0, (post.engagement.likes ?? 0) - 1) },
          }
        : undefined,
    );
  },
  run: async (postId) => confirmed(await feedService.removeVote(postId), 'unlike'),
  settle: (answer, postId) => {
    settleVote(postId, answer.data);
    invalidateEngagementLists('like');
  },
});

export const downvotePost = action<[postId: string], Answer>({
  key: (postId) => `${postId}:downvote`,
  optimistic: (postId) => {
    markLocalAction(postId, 'downvote');
    Post.patch(postId, (post) =>
      post.viewerState.isDownvoted
        ? undefined
        : {
            viewerState: { isLiked: false, isDownvoted: true },
            engagement: {
              likes: post.viewerState.isLiked
                ? Math.max(0, (post.engagement.likes ?? 0) - 1)
                : post.engagement.likes,
              downvotes: (post.engagement.downvotes ?? 0) + 1,
            },
          },
    );
  },
  run: async (postId) => confirmed(await feedService.voteItem(postId, -1), 'downvote'),
  settle: (answer, postId) => {
    settleVote(postId, answer.data);
    // A downvote clears any like, so it changes the likes list as an unlike does.
    invalidateEngagementLists('like');
  },
});

export const boostPost = action<[postId: string, source?: string], Answer>({
  optimistic: (postId) => {
    markLocalAction(postId, 'boost');
    Post.patch(postId, (post) => ({
      viewerState: { isBoosted: true },
      engagement: { boosts: (post.engagement.boosts ?? 0) + 1 },
    }));
  },
  run: async (postId, source) =>
    confirmed(
      await feedService.createBoost({ originalPostId: postId, mentions: [], hashtags: [] }, source),
      'boost',
    ),
  settle: () => {
    invalidateEngagementLists('boost');
    invalidateProfileCounts(queryClient);
  },
});

export const unboostPost = action<[postId: string], Answer>({
  optimistic: (postId) => {
    markLocalAction(postId, 'unboost');
    Post.patch(postId, (post) => ({
      viewerState: { isBoosted: false },
      engagement: { boosts: Math.max(0, (post.engagement.boosts ?? 0) - 1) },
    }));
  },
  run: async (postId) => confirmed(await feedService.unboostItem({ postId }), 'unboost'),
  settle: () => {
    invalidateEngagementLists('boost');
    invalidateProfileCounts(queryClient);
  },
});

export const savePost = action<[postId: string, source?: string], Answer>({
  key: (postId) => `${postId}:save`,
  optimistic: (postId) => {
    markLocalAction(postId, 'save');
    Post.patch(postId, (post) =>
      post.viewerState.isSaved
        ? undefined
        : {
            viewerState: { isSaved: true },
            // A count that was never a number is left for the server to fill.
            engagement:
              typeof post.engagement.saves === 'number' ? { saves: post.engagement.saves + 1 } : {},
          },
    );
  },
  run: async (postId, source) => confirmed(await feedService.saveItem({ postId }, source), 'save'),
  settle: (answer, postId) => {
    settleSave(postId, answer.data, true);
    invalidateEngagementLists('save');
  },
});

export const unsavePost = action<[postId: string], Answer>({
  key: (postId) => `${postId}:save`,
  optimistic: (postId) => {
    markLocalAction(postId, 'unsave');
    Post.patch(postId, (post) =>
      post.viewerState.isSaved
        ? {
            viewerState: { isSaved: false },
            engagement:
              typeof post.engagement.saves === 'number'
                ? { saves: Math.max(0, post.engagement.saves - 1) }
                : {},
          }
        : undefined,
    );
  },
  run: async (postId) => confirmed(await feedService.unsaveItem({ postId }), 'unsave'),
  settle: (answer, postId) => {
    settleSave(postId, answer.data, false);
    invalidateEngagementLists('save');
  },
});
