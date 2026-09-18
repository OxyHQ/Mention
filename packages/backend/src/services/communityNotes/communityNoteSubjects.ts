import type { HydratedPost } from '@mention/shared-types';
import { PostVisibility } from '@mention/shared-types';
import { loadPostRecords } from '../../db/posts/postRepository';
import { postHydrationService } from '../PostHydrationService';
import { getOwnerId, normalizeAuthorship } from '../../utils/postAuthorship';
import type { createScopedOxyClient } from '../../utils/oxyHelpers';
import type { CommunityNoteWithSubject } from './CommunityNotesService';
import type { CommunityNoteSummary } from '@mention/shared-types';

/**
 * The Mention half of a community note: the post a note is about.
 *
 * Separate from `CommunityNotesService`, which knows only CrowdSource. This
 * module knows only posts — what one has to BE for a note to attach to it, and
 * how a list of notes becomes a list of rows the hub can render. Keeping the
 * two apart is also what keeps the routes honest: a route reaches neither the
 * repository nor hydration itself, it asks here and maps the answer to a status
 * code.
 */

/** Why a post cannot take a community note. */
export type NoteSubjectRefusal =
  /** No such post, or none this viewer is allowed to see. */
  | 'not_found'
  /** Not published, or not public — see {@link resolveNoteSubject}. */
  | 'not_public'
  /** No resolvable Oxy author, so CrowdSource could not exclude them from rating. */
  | 'no_author'
  /** The viewer wrote the post. Context is written by READERS. */
  | 'own_post';

export type NoteSubject =
  | { ok: true; authorPrincipalId: string }
  | { ok: false; refusal: NoteSubjectRefusal };

/** The per-request Oxy client a route builds from the caller's bearer. */
type ScopedOxyClient = ReturnType<typeof createScopedOxyClient>;

/**
 * Whether this viewer may write a note about this post, and who wrote the post.
 *
 * Three tests, in the order that spends the least to refuse:
 *
 * 1. **Published and public.** Not a policy preference — it follows from what a
 *    note is. CrowdSource shows a note to every reader of its subject and draws
 *    raters from the whole application, so a note on a followers-only post
 *    would be judged by people who cannot read what they are judging, and then
 *    shown beside it. A draft or a scheduled post has no readers at all.
 * 2. **Visible to this viewer.** `loadPostRecords` applies no ACL, so without
 *    this the write would accept any post id somebody could guess — including
 *    from a reader the author has blocked, who would be annotating a post they
 *    are not allowed to read. Hydration is this codebase's one answer to "may
 *    this viewer see it", and a note is a rare write, so asking it here costs
 *    nothing that matters.
 * 3. **Not their own post.** An author annotating their own post is writing the
 *    post, and they can edit it.
 */
export async function resolveNoteSubject(
  viewerId: string,
  postId: string,
  oxyClient: ScopedOxyClient,
): Promise<NoteSubject> {
  const [post] = await loadPostRecords([postId]);
  if (!post) return { ok: false, refusal: 'not_found' };

  if (post.status !== 'published' || post.visibility !== PostVisibility.PUBLIC) {
    return { ok: false, refusal: 'not_public' };
  }

  const [visible] = await postHydrationService.hydratePosts([post], {
    viewerId,
    oxyClient,
    maxDepth: 0,
    includeLinkMetadata: false,
    includeCommunityNotes: false,
  });
  if (!visible) return { ok: false, refusal: 'not_found' };

  const authorPrincipalId = getOwnerId(normalizeAuthorship(post.authorship));
  if (!authorPrincipalId) return { ok: false, refusal: 'no_author' };
  if (authorPrincipalId === viewerId) return { ok: false, refusal: 'own_post' };

  return { ok: true, authorPrincipalId };
}

/**
 * The posts a list of notes is about, hydrated for this viewer.
 *
 * ONE load and ONE hydration for the whole list — the hub renders a real post
 * row under each note, and a per-note hydration would be a page of feed requests
 * pretending to be one. A note whose post this viewer cannot see (deleted,
 * blocked, restricted) is dropped with it: the note is context ABOUT that post
 * and means nothing without it.
 */
export async function withSubjectPosts(
  viewerId: string,
  oxyClient: ScopedOxyClient,
  entries: CommunityNoteWithSubject[],
): Promise<{ post: HydratedPost; note: CommunityNoteSummary }[]> {
  if (entries.length === 0) return [];
  const postIds = [...new Set(entries.map((entry) => entry.postId))];
  const posts = await loadPostRecords(postIds);
  const hydrated = await postHydrationService.hydratePosts(posts, {
    viewerId,
    oxyClient,
    maxDepth: 1,
    includeLinkMetadata: true,
  });
  const byId = new Map(hydrated.map((post) => [post.id, post]));
  return entries.flatMap((entry) => {
    const post = byId.get(entry.postId);
    return post ? [{ post, note: entry.note }] : [];
  });
}
