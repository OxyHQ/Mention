/**
 * One-shot cleanup for ActivityPub posts that stored remote custom-emoji
 * shortcodes as visible text. The source object is re-fetched only to prove
 * which exact names were declared as `Emoji`; unavailable sources are left
 * untouched. `DRY_RUN=true` is read-only and a live run requires
 * `CONFIRM_ADMIN_MUTATION=cleanFederatedCustomEmoji`.
 */
import { MtnConfig, type PostContentVariant } from '@mention/shared-types';
import { and, asc, gt, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { getDb, connectPostgres } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postContentVariants } from '../db/schema/postContent';
import { findPostRecords, replacePostContent, updatePostRecord } from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import {
  extractDeclaredCustomEmojiNames,
  removeDeclaredCustomEmoji,
} from '../connectors/activitypub/apPostContent';
import { fetchVerifiedAnnouncedNote } from '../connectors/activitypub/helpers';
import { baselineContentClassifier } from '../services/BaselineContentClassifier';
import { deleteFederatedPostSubtree } from '../services/FederatedPostDeletionService';
import { getRemoteHost } from '../connectors/shared/url';
import { logger } from '../utils/logger';
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from '../utils/concurrency';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';

const SCRIPT_NAME = 'cleanFederatedCustomEmoji';
const PAGE_SIZE = 200;

export type HistoricalEmojiCleanupDecision =
  | { kind: 'unchanged' }
  | { kind: 'update'; variants: PostContentVariant[]; spoilerText?: string }
  | { kind: 'delete' };

/** Pure stored-row decision, fed only names verified against the source object. */
export function planHistoricalEmojiCleanup(
  post: PostRecord,
  names: readonly string[],
): HistoricalEmojiCleanupDecision {
  if (names.length === 0) return { kind: 'unchanged' };

  let changed = false;
  const variants = (post.content.variants ?? []).flatMap((variant) => {
    const text = removeDeclaredCustomEmoji(variant.text, names);
    if (text !== variant.text) changed = true;
    return text.length > 0 ? [{ ...variant, text }] : [];
  });
  const priorSpoiler = post.federation?.spoilerText;
  const cleanedSpoiler = priorSpoiler === undefined
    ? undefined
    : removeDeclaredCustomEmoji(priorSpoiler, names).replace(/\s+/g, ' ').trim() || undefined;
  if (cleanedSpoiler !== priorSpoiler) changed = true;
  if (!changed) return { kind: 'unchanged' };

  const hasRescue = (post.content.media?.length ?? 0) > 0
    || (post.content.attachments?.length ?? 0) > 0
    || post.content.poll != null
    || cleanedSpoiler !== undefined;
  if (variants.length === 0 && !hasRescue) return { kind: 'delete' };
  return { kind: 'update', variants, spoilerText: cleanedSpoiler };
}

function candidateFilter(lastId: string | null): SQL {
  const shortcodeCandidate = or(
    sql`exists (
      select 1 from ${postContentVariants}
      where ${postContentVariants.postId} = ${posts.id}
        and ${postContentVariants.body} ~ ':[^[:space:]:<>]{1,126}:'
    )`,
    sql`${posts.federationSpoilerText} ~ ':[^[:space:]:<>]{1,126}:'`,
  ) as SQL;
  const base = and(
    isNotNull(posts.federationActivityId),
    isNotNull(posts.federationActorUri),
    shortcodeCandidate,
  ) as SQL;
  return lastId ? and(base, gt(posts.id, lastId)) as SQL : base;
}

async function applyUpdate(post: PostRecord, decision: Extract<HistoricalEmojiCleanupDecision, { kind: 'update' }>): Promise<void> {
  const text = decision.variants[0]?.text ?? '';
  const survivingLanguages = decision.variants
    .map((variant) => variant.tag)
    .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
  const signals = baselineContentClassifier.classify({
    text,
    hashtags: post.hashtags,
    language: survivingLanguages[0],
    languages: survivingLanguages,
    sensitive: post.metadata.isSensitive,
    isFederated: true,
    instanceDomain: post.federation?.actorUri ? getRemoteHost(post.federation.actorUri) : undefined,
  });
  await getDb().transaction(async (tx) => {
    await updatePostRecord(post.id, {
      language: signals.language ?? null,
      postClassification: {
        status: 'pending',
        attempts: 0,
        topics: signals.topics,
        topicRefs: [],
        languages: signals.languages,
        region: signals.region,
        hashtagsNorm: signals.hashtagsNorm,
        trendTerms: signals.trendTerms,
        sensitive: signals.sensitive,
        scores: signals.scores,
        version: signals.version,
        sentiment: 'neutral',
        intent: 'other',
        confidence: 0,
        classifiedAt: new Date(signals.classifiedAt),
      },
    }, tx);
    await tx
      .update(posts)
      .set({ federationSpoilerText: decision.spoilerText ?? null })
      .where(sql`${posts.id} = ${post.id}`);
    await replacePostContent(
      post.id,
      {
        ...post.content,
        variants: decision.variants.length > 0 ? decision.variants : undefined,
      },
      post.mentions,
      tx,
    );
  });
}

async function run(): Promise<void> {
  const dryRun = process.env.DRY_RUN === 'true';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();

  const counts = {
    scanned: 0,
    unchanged: 0,
    cleaned: 0,
    deleted: 0,
    sourceUnavailable: 0,
    tooLarge: 0,
    failed: 0,
  };
  let lastId: string | null = null;

  try {
    for (;;) {
      const page = await findPostRecords(candidateFilter(lastId), {
        orderBy: [asc(posts.id)],
        limit: PAGE_SIZE,
      });
      if (page.length === 0) break;

      const settled = await mapWithConcurrency(page, DEFAULT_CONCURRENCY, async (post) => {
        counts.scanned += 1;
        const sourceUrl = post.federation?.activityId;
        const actorUri = post.federation?.actorUri;
        if (!sourceUrl || !actorUri) {
          counts.sourceUnavailable += 1;
          return;
        }
        const fetched = await fetchVerifiedAnnouncedNote(sourceUrl);
        if (!fetched) {
          counts.sourceUnavailable += 1;
          return;
        }
        const names = extractDeclaredCustomEmojiNames(fetched.note);
        const decision = planHistoricalEmojiCleanup(post, names);
        if (decision.kind === 'unchanged') {
          counts.unchanged += 1;
          return;
        }
        if (decision.kind === 'update') {
          if (!dryRun) await applyUpdate(post, decision);
          counts.cleaned += 1;
          return;
        }
        if (!dryRun) {
          const result = await deleteFederatedPostSubtree(post.id, actorUri);
          if (result === 'too-large') {
            counts.tooLarge += 1;
            return;
          }
          if (result !== 'deleted') throw new Error('federated cleanup deletion claim failed');
        }
        counts.deleted += 1;
      });
      counts.failed += settled.filter((result) => result.status === 'rejected').length;
      lastId = page[page.length - 1]?.id ?? lastId;
      logger.info('[cleanFederatedCustomEmoji] progress', { dryRun, ...counts });
    }

    logger.info('[cleanFederatedCustomEmoji] complete', {
      dryRun,
      thresholds: {
        spam: MtnConfig.feed.discoveryGate.spamRejectThreshold,
        quality: MtnConfig.feed.discoveryGate.qualityRejectThreshold,
      },
      ...counts,
    });
    if (counts.failed > 0 || counts.tooLarge > 0) {
      throw new Error(`cleanup incomplete: failed=${counts.failed}, tooLarge=${counts.tooLarge}`);
    }
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[cleanFederatedCustomEmoji] failed', error);
      process.exit(1);
    });
}

export default run;
