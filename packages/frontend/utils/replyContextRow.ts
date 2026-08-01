import { getNormalizedUserHandle } from '@oxyhq/core';
import type { HydratedPost, HydratedPostSummary } from '@mention/shared-types';

/**
 * The single definition of "does this row need to say what it is answering, and
 * whom does it name" — the client-side counterpart of the server's `isReplyPost`
 * (`packages/backend/src/utils/postReply.ts`).
 *
 * It reads the POST. Reply context used to be plumbed in as props derived from
 * `FeedSliceReason`, which meant only rows that came through the feed-slice
 * renderer could show it — so a reply rendered in search, in saved posts, in
 * insights, in the scheduled-post preview, or on any feed the server returned
 * without slices was indistinguishable from a top-level post. Reading the post
 * means every caller gets it right without knowing this rule exists.
 */

export interface ReplyContextRowInput {
  post: HydratedPost | HydratedPostSummary | null | undefined;
  /** This row is a quote card inside another post. */
  isNested: boolean;
}

export interface ReplyContextRow {
  /**
   * The parent author's real handle — what the hover card resolves. Absent when
   * the server could not name the parent, or named it with a display name only.
   * A display name is NOT a handle and must never be fetched as one.
   */
  authorHandle?: string;
  /**
   * What follows "Replying to @". Absent means the parent is unknown and the row
   * falls back to generic copy ("Replying to a post") rather than disappearing —
   * an unnamed reply is still a reply, and hiding the row is precisely what made
   * one read as an ordinary post.
   */
  label?: string;
}

/**
 * `null` when no row should render.
 *
 * The SELF-THREAD case is not decided here: the server omits `replyContext`
 * entirely for a reply to its own author's post, because only the server holds
 * both authoritative author ids (a post's DTO `user.id` is a degraded, post-id
 * based placeholder for orphan federated posts, so comparing here would silently
 * never match on exactly those). A continuation therefore arrives with nothing to
 * render, and its thread connector plus "Show this thread" carry the meaning.
 *
 * The one suppression left is `isNested`: a quote card is context for the post
 * around it, and a reply header inside one describes a relationship the reader
 * did not ask about.
 *
 * Note what is deliberately NOT suppressed: a reply whose parent is prepended
 * directly above it still renders the header. It names a DIFFERENT author, and
 * naming them is the entire point — redundant context is cheap, missing context
 * is the bug.
 */
export function resolveReplyContextRow({
  post,
  isNested,
}: ReplyContextRowInput): ReplyContextRow | null {
  if (isNested) return null;

  const replyContext = post?.replyContext;
  if (!replyContext) return null;

  const parentAuthor = replyContext.parentAuthor;
  const authorHandle = getNormalizedUserHandle(parentAuthor) ?? undefined;

  return {
    authorHandle,
    label: authorHandle || parentAuthor?.name?.displayName || undefined,
  };
}
