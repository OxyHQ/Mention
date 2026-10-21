import { PostType } from '@mention/shared-types';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { postContentVariants } from '../../db/schema';
import { loadPostRecords } from '../../db/posts/postRepository';
import { authorVariants, resolveVariant } from '../../services/postVariants';
import type { CandidatePost } from './engine/types';

/** The owner's calibrated example: a bare number with no independently useful context. */
export function isStandaloneNumber(post: CandidatePost): boolean {
  if (
    post.type !== PostType.TEXT ||
    post.isReply ||
    post.hasLinks ||
    post.parentPostId ||
    post.quoteOf ||
    post.boostOf ||
    post.threadId
  )
    return false;
  const content = post.content;
  const variants = authorVariants(content);
  if (
    content.media?.length ||
    content.attachments?.length ||
    content.sources?.length ||
    content.pollId ||
    content.article ||
    content.event ||
    content.room ||
    content.location ||
    content.podcast ||
    variants.some(
      (variant) =>
        variant.media?.length ||
        variant.article ||
        (variant.text.trim() && !/^\d+$/.test(variant.text.trim())),
    )
  )
    return false;
  return /^\d+$/.test(resolveVariant(content).text.trim());
}

/**
 * Shells omit rendition/attachment rows. Probe only primary numeric bodies in
 * one indexed batch, then fully assemble those few candidates before deciding.
 * This rule never touches ingestion, profiles, or subscription timelines.
 */
export async function standaloneNumberIds(candidates: CandidatePost[]): Promise<Set<string>> {
  const rejected = new Set(
    candidates
      .filter((post) => !post._unassembled && isStandaloneNumber(post))
      .map((post) => post.id),
  );
  const shellIds = candidates
    .filter(
      (post) =>
        post._unassembled &&
        post.type === PostType.TEXT &&
        !post.isReply &&
        !post.threadId &&
        !post.quoteOf &&
        !post.parentPostId,
    )
    .map((post) => post.id);
  if (!shellIds.length) return rejected;
  const rows = await getDb()
    .select({ id: postContentVariants.postId })
    .from(postContentVariants)
    .where(
      and(
        inArray(postContentVariants.postId, shellIds),
        eq(postContentVariants.position, 0),
        sql`btrim(${postContentVariants.body}) ~ '^[0-9]+$'`,
      ),
    );
  if (!rows.length) return rejected;
  for (const post of await loadPostRecords(rows.map((row) => row.id)))
    if (isStandaloneNumber(post)) rejected.add(post.id);
  return rejected;
}
