import {
  PostVisibility,
  type HydratedPost,
  type MediaItem,
  type PollData,
  type PostUser,
} from '@mention/shared-types';
import type { Draft } from '@/hooks/useDrafts';

/**
 * What a local draft can and cannot show in a preview.
 *
 * A scheduled post is a stored server document that has been through
 * `PostHydrationService`; a DRAFT has never been near the server. There is no
 * author DTO, no resolved media URL, no poll document — so a faithful preview
 * has to be BUILT here, from the draft plus the viewer's own identity, and some
 * of it genuinely cannot be built:
 *
 * - **Faithful:** body text, media (URLs resolved through the canonical
 *   `getFileDownloadUrl` chokepoint), poll, article, location, and the author —
 *   the viewer IS the author, so their real profile is the right one to show.
 * - **Indicated, not rendered:** a THREAD. The surface renders one post; a
 *   multi-post draft previews its first post and reports how many follow, rather
 *   than showing a fragment as if it were the whole thing.
 * - **Absent by construction:** quoted posts, events and rooms. The composer
 *   holds those in its own state and `Draft` has no field for them, so a draft
 *   simply does not carry them — nothing is being dropped here.
 *
 * Engagement, viewer state and permissions are all zero/false because the post
 * does not exist yet; that is honest rather than a placeholder.
 */
export interface DraftPreviewResult {
  post: HydratedPost;
  /** Posts that follow the previewed one in a thread draft; 0 for a single post. */
  remainingThreadItems: number;
}

/** The parts of a poll a not-yet-created poll can honestly claim. */
function buildPoll(draft: Draft): PollData | undefined {
  const options = draft.pollOptions.filter((option) => option.trim().length > 0);
  if (!draft.showPollCreator || options.length === 0) return undefined;
  return {
    question: draft.pollTitle?.trim() ?? '',
    options,
    // A poll nobody has seen has no votes and no end time yet. Zeros are the
    // truth here, not a placeholder.
    endTime: '',
    votes: {},
    userVotes: {},
  };
}

/**
 * Project a local draft onto the DTO the feed renderer consumes.
 *
 * `resolveMediaUrl` is injected rather than imported so this stays a pure
 * function — and so the caller passes the app's ONE media chokepoint
 * (`oxyServices.getFileDownloadUrl`) instead of this file inventing a URL shape.
 */
export function draftToPreviewPost(params: {
  draft: Draft;
  author: PostUser;
  resolveMediaUrl: (fileId: string) => string;
}): DraftPreviewResult {
  const { draft, author, resolveMediaUrl } = params;

  const media: MediaItem[] = draft.mediaIds.map((item) => ({
    id: item.id,
    type: item.type,
    url: resolveMediaUrl(item.id),
  }));

  const poll = buildPoll(draft);
  const articleTitle = draft.article?.title?.trim();
  const articleBody = draft.article?.body?.trim();
  const hasArticle = Boolean(articleTitle || articleBody);

  const post: HydratedPost = {
    // The draft's own id. It is not a post id and never reaches a URL — the
    // preview renders inert precisely so nothing tries to navigate to it.
    id: `draft:${draft.id}`,
    content: {
      text: draft.postContent,
      ...(media.length > 0 ? { media } : {}),
      ...(poll ? { poll } : {}),
      ...(hasArticle
        ? { article: { title: articleTitle, body: articleBody, excerpt: articleBody?.slice(0, 280) } }
        : {}),
      ...(draft.location
        ? {
            location: {
              type: 'Point' as const,
              coordinates: [draft.location.longitude, draft.location.latitude] as [number, number],
              address: draft.location.address,
            },
          }
        : {}),
    },
    attachments: {},
    user: author,
    authors: [],
    engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0 },
    viewerState: {
      isOwner: true,
      isCollaborator: false,
      isLiked: false,
      isDownvoted: false,
      isBoosted: false,
      isSaved: false,
    },
    permissions: { canReply: false, canDelete: true, canPin: false, canViewSources: true },
    metadata: {
      visibility: PostVisibility.PUBLIC,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'draft',
    },
  };

  return { post, remainingThreadItems: draft.threadItems.length };
}
