/**
 * Sweep an author's public post pages off the edge when Mention stops showing
 * the author: suspended, archived or restricted in Oxy, or a profile made
 * private or followers-only on Mention. The post rows do not change, so no
 * per-post write purges them; the page hides them because of the AUTHOR
 * (`postPageAuthorPolicy.authorSeoPolicy`), and this asks the same question.
 *
 * Re-checked here rather than trusted from the trigger. An Oxy invalidation
 * says only "this account changed" (`@oxy.so/contracts` `userInvalidation`), and
 * nearly every change is a name or an avatar: sweeping on each would purge a
 * public author's pages for nothing. A trigger that has already been undone by
 * the time the job runs (private, then public again) sweeps nothing either.
 *
 * In keyset batches over the author's public, published posts, each batch with
 * the public boosts of those posts (a boost's page shows the original, so it is
 * hidden with the original's author). Every batch goes to the purge queue at
 * sweep priority, which the rate limiter spreads out.
 */
import { and, eq, gt, inArray, type SQL } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { authorSeoPolicy } from './postPageAuthorPolicy';
import { purgePostPages } from './postPageEdgePurge';

/** Posts read per batch; each batch becomes ceil(n / 15) purge jobs. */
export const AUTHOR_SWEEP_BATCH = 500;

function publicPages(where: SQL): SQL | undefined {
  return and(where, eq(posts.visibility, 'public'), eq(posts.status, 'published'));
}

/**
 * Purge every public page of `oxyUserId`'s if the page would no longer show
 * them. Returns how many posts were queued. Throws on a failed read (the job
 * retries); the purges themselves never throw.
 */
export async function runAuthorPostPagePurge(oxyUserId: string): Promise<{ swept: number }> {
  const db = getDb();
  const own = (after: string | null): SQL | undefined =>
    publicPages(
      after === null
        ? eq(posts.oxyUserId, oxyUserId)
        : (and(eq(posts.oxyUserId, oxyUserId), gt(posts.id, after)) as SQL),
    );

  // Nothing of theirs can be on the edge: no reason to ask Oxy anything.
  const [any] = await db.select({ id: posts.id }).from(posts).where(own(null)).limit(1);
  if (!any) return { swept: 0 };

  const policy = await authorSeoPolicy(oxyUserId);
  if (policy.visible) return { swept: 0 };

  let swept = 0;
  let after: string | null = null;
  for (;;) {
    const rows: Array<{ id: string }> = await db
      .select({ id: posts.id })
      .from(posts)
      .where(own(after))
      .orderBy(posts.id)
      .limit(AUTHOR_SWEEP_BATCH);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    const ids = rows.map((row) => row.id);
    const boosts = await db
      .select({ id: posts.id })
      .from(posts)
      .where(publicPages(inArray(posts.repostOf, ids) as SQL));
    const batch = [...ids, ...boosts.map((row) => row.id)];
    await purgePostPages(batch, 'author_hidden', { priority: 'sweep' });
    swept += batch.length;
    if (rows.length < AUTHOR_SWEEP_BATCH) break;
  }
  return { swept };
}
