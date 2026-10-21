/**
 * One-shot admin backfill: turn the remote `@user@host` handles typed into
 * ALREADY-STORED native posts into real mentions.
 *
 * The typed-handle lookup only knew an actor by its transport `acct`, so
 * `@Cloudflare@x.com` (stored as `cloudflare@bird.makeup`, network acct
 * `cloudflare@x.com`) stayed plain text and never reached the profile's
 * mentions tab. Lookup is fixed at the write boundary; this repairs the history
 * with the SAME function that boundary uses (`foldProfileLinkMentions`), so the
 * backfill and the live path cannot disagree. A handle that still resolves to no
 * stored identity stays text, and a re-run is a no-op for every folded post.
 *
 * Rewrites the bodies it folds and records the mention. It never notifies:
 * telling someone about a post written weeks ago is not a repair.
 *
 *   DRY_RUN                 default true; only `false` writes
 *   CONFIRM_ADMIN_MUTATION  must be `foldTypedHandleMentions` to write
 *   BACKFILL_MAX            posts per run (default 5000)
 */

import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  mentionTextsFromContent,
  reconcileMentionIdsDetailed,
} from '@mention/shared-types/mentions';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { postContentVariants, postMentions } from '../db/schema/postContent';
import { posts } from '../db/schema/posts';
import { foldProfileLinkMentions } from '../services/profileLinkMentions';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'foldTypedHandleMentions';

/** A remote handle: `@name@host.tld`. Wider than the scanner on purpose; the fold decides. */
const TYPED_REMOTE_HANDLE = '@[A-Za-z0-9_.]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+';

export interface FoldTypedHandlesResult {
  scanned: number;
  folded: number;
  mentionsAdded: number;
}

export async function foldTypedHandleMentions(
  opts: { dryRun?: boolean; max?: number; postIds?: readonly string[] } = {},
): Promise<FoldTypedHandlesResult> {
  const dryRun = opts.dryRun ?? true;
  const max = opts.max ?? 5000;
  const db = getDb();

  const candidates = await db
    .selectDistinct({ postId: postContentVariants.postId })
    .from(postContentVariants)
    .innerJoin(posts, eq(posts.id, postContentVariants.postId))
    .where(
      and(
        isNull(posts.federationActorUri),
        eq(posts.status, 'published'),
        ne(postContentVariants.source, 'machine'),
        sql`${postContentVariants.body} ~ ${TYPED_REMOTE_HANDLE}`,
        opts.postIds ? inArray(posts.id, [...opts.postIds]) : undefined,
      ),
    )
    .limit(max);

  const result: FoldTypedHandlesResult = { scanned: 0, folded: 0, mentionsAdded: 0 };
  for (const { postId } of candidates) {
    result.scanned += 1;
    const variants = await db
      .select({
        id: postContentVariants.id,
        body: postContentVariants.body,
        source: postContentVariants.source,
      })
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, postId));
    const existing = (
      await db
        .select({ oxyUserId: postMentions.oxyUserId })
        .from(postMentions)
        .where(eq(postMentions.postId, postId))
    ).map((row) => row.oxyUserId);

    const content = {
      variants: variants.map((variant) => ({
        id: variant.id,
        text: variant.body,
        source: variant.source,
      })),
    };
    const fold = await foldProfileLinkMentions(content, existing);
    if (!fold.rewritten) continue;

    const { ids } = reconcileMentionIdsDetailed(mentionTextsFromContent(content), fold.mentions);
    const added = ids.filter((id) => !existing.includes(id));
    result.folded += 1;
    result.mentionsAdded += added.length;
    if (dryRun) continue;

    await db.transaction(async (tx) => {
      for (const variant of content.variants) {
        await tx
          .update(postContentVariants)
          .set({ body: variant.text })
          .where(eq(postContentVariants.id, variant.id));
      }
      if (added.length > 0) {
        await tx
          .insert(postMentions)
          .values(added.map((oxyUserId) => ({ postId, oxyUserId })))
          .onConflictDoNothing();
      }
    });
  }
  logger.info(`[${SCRIPT_NAME}] complete`, { dryRun, ...result });
  return result;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  try {
    await foldTypedHandleMentions({ dryRun, max: Number(process.env.BACKFILL_MAX ?? 5000) });
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      process.exit(1);
    });
}
