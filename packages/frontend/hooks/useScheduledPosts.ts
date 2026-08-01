import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services/ui/client';
import type { StoredPostContent } from '@mention/shared-types';
import { api } from '@/utils/api';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

const SCHEDULED_STALE_TIME = 30_000;

/**
 * ONE document as `GET /posts/scheduled` actually serves it.
 *
 * Unlike every other post read in the app, this endpoint returns RAW lean Mongo
 * documents — `res.json(scheduledPosts)` straight out of `Post.find(...).lean()`
 * — so it is deliberately NOT the hydrated post DTO the rest of the API serves:
 *
 * - the id is `_id` (lean bypasses the schema's `id` virtual),
 * - the body lives in `content.variants[0].text`; there is no resolved
 *   `content.text`, because resolving a variant per reader is something
 *   `PostHydrationService` does and this route does not call it,
 * - there is no `user` / author object, no counts, and no viewer state.
 *
 * That is fine for this surface: the author is by definition the viewer, and the
 * list only needs a preview plus the time. Anything richer (a real post card,
 * media thumbnails, the poll) would need the route to hydrate first.
 */
interface ScheduledPostDocument {
  _id?: string;
  content?: StoredPostContent;
  scheduledFor?: string;
  createdAt?: string;
}

/** A scheduled post as this app renders it. */
export interface ScheduledPost {
  id: string;
  /** The primary variant's body, empty when the post is media/poll-only. */
  text: string;
  /** `null` when the stored document carries no usable `scheduledFor`. */
  scheduledFor: Date | null;
  mediaCount: number;
  hasPoll: boolean;
  /** The article headline, when the post is long-form. */
  articleTitle: string | null;
}

function parseScheduledFor(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Projects one raw document onto {@link ScheduledPost}.
 *
 * `variants[0]` is the primary rendition (see `StoredPostContent`), read here
 * directly because there is no resolver on this path — the viewer IS the author,
 * so the primary is the body they wrote.
 */
function normalizeScheduledPost(document: ScheduledPostDocument): ScheduledPost {
  const content = document.content;
  const articleTitle = content?.article?.title?.trim();

  return {
    id: document._id ?? '',
    text: content?.variants?.[0]?.text?.trim() ?? '',
    scheduledFor: parseScheduledFor(document.scheduledFor),
    mediaCount: content?.media?.length ?? 0,
    hasPoll: Boolean(content?.poll ?? content?.pollId),
    articleTitle: articleTitle ? articleTitle : null,
  };
}

export interface UseScheduledPostsResult {
  /** The viewer's pending scheduled posts, soonest first (the server's order). */
  scheduledPosts: ScheduledPost[];
  /** True only while the first authenticated fetch is in flight. */
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  /** Cancel one scheduled post — it is deleted, never published. */
  cancelScheduledPost: (postId: string) => Promise<void>;
}

/**
 * The viewer's scheduled posts, plus the cancel command.
 *
 * Cancelling reuses `DELETE /posts/:id`, which already owner-scopes its query
 * (`{ _id, oxyUserId }`) and is status-agnostic — a scheduled post is simply
 * removed before `ScheduledPostPublisher` ever reaches it. Nothing federates,
 * because that path only broadcasts for `status: 'published'` posts.
 *
 * The read is gated on `canUsePrivateApi` (never bare `isAuthenticated`) so no
 * request fires before a usable bearer exists, and the key is viewer-scoped so
 * an account switch can never serve A's queue to B.
 */
export function useScheduledPosts(): UseScheduledPostsResult {
  const { user, isAuthenticated, canUsePrivateApi } = useAuth();
  const viewerId = user?.id;
  const queryClient = useQueryClient();
  const queryKey = viewerQueryKeys.scheduledPosts(viewerId);

  const enabled = isAuthenticated && Boolean(viewerId) && canUsePrivateApi;

  const query = useQuery<ScheduledPost[]>({
    queryKey,
    queryFn: async () => {
      const { data } = await api.get<ScheduledPostDocument[]>('/posts/scheduled');
      return Array.isArray(data) ? data.map(normalizeScheduledPost) : [];
    },
    enabled,
    staleTime: SCHEDULED_STALE_TIME,
  });

  const cancelMutation = useMutation<void, unknown, string>({
    mutationFn: async (postId: string) => {
      await api.delete(`/posts/${postId}`);
    },
    onSuccess: (_result, postId) => {
      queryClient.setQueryData<ScheduledPost[]>(queryKey, (previous) =>
        previous?.filter((post) => post.id !== postId),
      );
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const { mutateAsync: cancel } = cancelMutation;
  const cancelScheduledPost = useCallback(async (postId: string) => {
    await cancel(postId);
  }, [cancel]);

  return {
    scheduledPosts: enabled ? query.data ?? [] : [],
    isLoading: enabled && query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    cancelScheduledPost,
  };
}
