import { asc, eq, inArray } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { postLinkPreviews } from '../schema/postContent';

/**
 * `post_link_previews` — see the table's docblock. The federated ingest writes a
 * post's cards; hydration reads them as the fallback for a link Clarity has no
 * document for.
 */

export interface StoredLinkPreview {
  url: string;
  title?: string;
  description?: string;
}

/**
 * Replace every card of one post with `previews`, in order. An empty list clears
 * them: an edit that dropped the link, or its card, takes the card with it.
 */
export async function replacePostLinkPreviews(
  postId: string,
  previews: readonly StoredLinkPreview[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const write = async (tx: DatabaseOrTransaction) => {
    await tx.delete(postLinkPreviews).where(eq(postLinkPreviews.postId, postId));
    if (previews.length === 0) return;
    await tx.insert(postLinkPreviews).values(previews.map((preview, position) => ({
      postId,
      position,
      url: preview.url,
      title: preview.title ?? null,
      description: preview.description ?? null,
    })));
  };
  if ('transaction' in db) await db.transaction(write);
  else await write(db);
}

/** The stored cards of each post in `postIds`, in order. Posts with none are absent. */
export async function findPostLinkPreviews(
  postIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, StoredLinkPreview[]>> {
  const byPost = new Map<string, StoredLinkPreview[]>();
  if (postIds.length === 0) return byPost;
  const rows = await db
    .select({
      postId: postLinkPreviews.postId,
      url: postLinkPreviews.url,
      title: postLinkPreviews.title,
      description: postLinkPreviews.description,
    })
    .from(postLinkPreviews)
    .where(inArray(postLinkPreviews.postId, [...postIds]))
    .orderBy(asc(postLinkPreviews.postId), asc(postLinkPreviews.position));
  for (const row of rows) {
    const list = byPost.get(row.postId) ?? [];
    list.push({
      url: row.url,
      ...(row.title !== null ? { title: row.title } : {}),
      ...(row.description !== null ? { description: row.description } : {}),
    });
    byPost.set(row.postId, list);
  }
  return byPost;
}
