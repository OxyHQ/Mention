/**
 * One-shot corpus backfill: derive `postClassification.languages` (+ the
 * top-level primary `post.language`) for posts that predate multi-language
 * classification.
 *
 * Language-based feed filtering/recommendation reads the canonical
 * `postClassification.languages` array. Posts created before v4 of the Stage-A
 * baseline (or before the multi-language field existed) either lack that array or
 * carry a stale `postClassification.version`, so they never match a viewer's
 * language preference. This re-runs the deterministic {@link baselineContentClassifier}
 * over those posts and writes the derived array + primary.
 *
 * It re-derives from the post's own primary rendition and `hashtags` (NOT the
 * stored `post.language`, which used to be defaulted to `'en'` — reusing it would
 * propagate that bad default). What the post DECLARES is its author renditions'
 * tags, read exactly as the create path reads them, so the classifier applies the
 * same declared-versus-detected policy it applied at ingest. Posts whose text is
 * too short/undetectable are explicitly stamped as unknown rather than retaining
 * a stale, false language.
 *
 * It also repairs the primary rendition's TAG: an untagged primary takes the
 * resolved language, and a declared tag the classifier contradicted (a Mastodon
 * account's default `de` on English prose) is replaced — see
 * {@link applyDetectedPrimaryTag}. Rows whose primary tag disagrees with their
 * classification are therefore selected too.
 *
 * Stamping the CURRENT version on a row that carried an older one (or none) also
 * writes that version's deterministic scores, topics, region, canonical hashtags
 * and sensitivity: ranking trusts a row's scores BY its version
 * (`trustedScores.ts`), and an unclassified row's scores are the all-zero column
 * defaults, which a current stamp would otherwise turn into "quality 0". A row the
 * AI batch classified keeps its AI fields — it is trusted by status, not version.
 *
 * A row whose result is unchanged is not written, so a re-run over posts that are
 * honestly undetectable rewrites nothing. A row with no body at all (a boost, a
 * media-only post) is never written.
 *
 * Idempotent (writing the array + current version removes a post from the
 * selection filter, so a re-run only fills gaps) and batched via a stable
 * ascending `_id` page cursor. A single post's classify failure is isolated so
 * the scan can finish, but the completed run exits non-zero rather than reporting
 * a partial backfill as successful. Supports `--dry-run` or `DRY_RUN=true` (report what it would
 * update, write nothing).
 *
 * Runnable as a Fargate one-shot post-deploy (the live run also needs
 * `CONFIRM_ADMIN_MUTATION=backfillPostLanguages`):
 *   bun packages/backend/dist/src/scripts/backfillPostLanguages.js --dry-run
 *   bun packages/backend/dist/src/scripts/backfillPostLanguages.js
 */

import { and, asc, gt, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  applyDetectedPrimaryTag,
  declaredBaseLanguages,
  resolveVariant,
} from '../services/postVariants';
import { connectPostgres } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { findPostRecords, replacePostContent, updatePostRecord } from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import {
  baselineContentClassifier,
  BASELINE_CLASSIFIER_VERSION,
} from '../services/BaselineContentClassifier';
import { logger } from '../utils/logger';
import { assertAdminRunComplete, closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

/** Posts scanned per page (stable ascending `id` cursor pagination). */
const DEFAULT_PAGE_SIZE = 500;

export interface BackfillPostLanguagesResult {
  scanned: number;
  updated: number;
  /** Of `updated`, the rows whose primary rendition was (or would be) re-tagged. */
  retagged: number;
  failed: number;
}

/**
 * The primary AUTHOR rendition is tagged with a base language other than the
 * row's own primary classification language (including a tagged primary on a row
 * with no classification language at all).
 *
 * The outer row is spelled `"posts"."id"` by hand: drizzle renders a column of a
 * single-table select UNQUALIFIED, and an unqualified `id` inside this subquery
 * would bind to the rendition's own `id`, matching nothing.
 */
const primaryTagDisagrees = sql`exists (
  select 1 from post_content_variants v
  where v.post_id = "posts"."id"
    and v.position = 0
    and v.source = 'author'
    and v.tag is not null
    and split_part(lower(v.tag), '-', 1) is distinct from "posts"."classification_languages"[1]
)`;

/** The federated author's instance host — the classifier's region/bot input. */
function instanceDomainOf(post: PostRecord): string | undefined {
  const actorUri = post.federation?.actorUri;
  if (!actorUri) return undefined;
  try {
    return new URL(actorUri).hostname;
  } catch {
    return undefined;
  }
}

const sameList = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  (a ?? []).length === b.length && b.every((value, index) => a?.[index] === value);

/**
 * Re-classify and backfill languages over the qualifying corpus. The caller owns
 * the connection lifecycle, so this is reusable from an in-process caller.
 */
export async function backfillPostLanguages(
  opts: { batchSize?: number; dryRun?: boolean } = {},
): Promise<BackfillPostLanguagesResult> {
  const pageSize = opts.batchSize ?? DEFAULT_PAGE_SIZE;
  const dryRun = opts.dryRun ?? false;

  // Posts whose canonical multi-language array is absent/empty, or that were
  // classified before the current baseline version. Setting the array + version
  // removes a post from this filter, so the ascending `_id` cursor never revisits
  // a completed post and a re-run only fills remaining gaps.
  // A NULL `classification_version` is one of the qualifying states and must be
  // spelled out: `version < N` is NULL for an unstamped row, and a NULL predicate
  // excludes the row — so the literal translation would silently skip exactly the
  // posts that were never classified at all.
  const baseFilter = or(
    isNull(posts.classificationLanguages),
    sql`cardinality(${posts.classificationLanguages}) = 0`,
    isNull(posts.classificationVersion),
    lt(posts.classificationVersion, BASELINE_CLASSIFIER_VERSION),
    primaryTagDisagrees,
  ) as SQL;

  let scanned = 0;
  let updated = 0;
  let retagged = 0;
  let failed = 0;
  let lastId: string | null = null;

  for (;;) {
    const page = await findPostRecords(
      lastId ? and(baseFilter, gt(posts.id, lastId)) : baseFilter,
      { orderBy: [asc(posts.id)], limit: pageSize },
    );

    if (page.length === 0) break;

    for (const post of page) {
      scanned += 1;
      try {
        const classification = post.postClassification;
        // The PRIMARY rendition — the author's own words. Detecting a language
        // from a machine translation would just re-derive the language we asked
        // the translator for.
        const text = resolveVariant(post.content).text;
        // A boost or a media-only post has no words to derive a language from,
        // and stamping a version on it would only make its column-default scores
        // look computed. Left exactly as it is.
        if (text.trim().length === 0) continue;
        const signals = baselineContentClassifier.classify({
          text,
          hashtags: post.hashtags,
          languages: declaredBaseLanguages(post.content),
          sensitive: post.federation?.sensitive ?? post.metadata.isSensitive,
          isFederated: post.federation != null,
          instanceDomain: instanceDomainOf(post),
        });
        const primaryLanguage = signals.languages[0];
        const restamp = classification?.version !== BASELINE_CLASSIFIER_VERSION;
        const variants = post.content.variants ?? [];
        const reconciled = applyDetectedPrimaryTag(variants, primaryLanguage);
        const retag = reconciled !== variants;

        const unchanged =
          !restamp &&
          !retag &&
          sameList(classification?.languages, signals.languages) &&
          sameList(classification?.trendTerms, signals.trendTerms) &&
          (post.language ?? null) === (primaryLanguage ?? null);
        if (unchanged) continue;

        updated += 1;
        if (retag) retagged += 1;
        if (dryRun) continue;

        // A per-post PARTIAL patch rather than a batched bulkWrite: the
        // classification fields are a MERGE onto the existing columns, which is
        // what `updatePostRecord` expresses and what a whole-column write would
        // destroy. The page size still bounds the work per round.
        await updatePostRecord(post.id, {
          postClassification: {
            languages: signals.languages,
            // Written alongside the languages because this update also stamps
            // `version`: a row claiming the current baseline version while
            // missing a field that version defines is worse than an
            // un-backfilled row, since the version is exactly what readers use
            // to decide whether to trust the classification.
            trendTerms: signals.trendTerms,
            version: signals.version,
            ...(restamp && classification?.status !== 'classified'
              ? {
                  topics: signals.topics,
                  region: signals.region,
                  hashtagsNorm: signals.hashtagsNorm,
                  sensitive: signals.sensitive,
                  scores: signals.scores,
                }
              : {}),
          },
          language: primaryLanguage ?? null,
        });
        if (retag) {
          await replacePostContent(
            post.id,
            { ...post.content, variants: reconciled },
            post.mentions,
          );
        }
      } catch (error) {
        failed += 1;
        logger.warn('[backfillPostLanguages] classify failed for post; skipping', {
          id: post.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    lastId = page[page.length - 1].id;
    logger.info(
      `[backfillPostLanguages] progress: scanned ${scanned}, updated ${updated} (retagged ${retagged}), failed ${failed}`,
    );
  }

  return { scanned, updated, retagged, failed };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  // `DRY_RUN=true` is how the ECS one-shot runner asks for a preview.
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

  try {
    assertAdminMutationAllowed({
      scriptName: 'backfillPostLanguages',
      dryRun,
    });
    await connectPostgres();
    logger.info('[backfillPostLanguages] connected to PostgreSQL', { dryRun });

    const result = await backfillPostLanguages({ dryRun });

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillPostLanguages] done${dryRun ? ' (DRY_RUN — no writes)' : ''}: scanned ${result.scanned}, updated ${result.updated} (retagged ${result.retagged}), failed ${result.failed} (${elapsedSeconds}s)`,
    );

    assertAdminRunComplete('backfillPostLanguages', {
      failed: result.failed,
    });
  } catch (error) {
    logger.error('[backfillPostLanguages] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillPostLanguages] unhandled failure', error);
      process.exit(1);
    });
}
