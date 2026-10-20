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
 * `--all` (`ALL_POSTS=true`) re-derives every post rather than the gaps: needed
 * once after a detector change that the version does not record.
 *
 * ## The dry run is a review, not a count
 *
 * Every cross-language pair (one language replaced by another) of at least
 * {@link REPORT_CROSS_PAIR_MIN_COUNT} rows is also logged, as `cross-language
 * change` with its samples, and `language fills by source` counts how empty rows
 * would be filled: from a declaration, from detection, or from script evidence.
 *
 * A row classified under the CURRENT ruleset passes its languages to the
 * classifier as `previousLanguages`, so they are replaced only on strong
 * evidence (`BaselineContentClassifier`'s overrule rule), never by a different
 * detector's verdict on a sentence too short to judge.
 *
 * A dry run logs `[backfillPostLanguages] language change` once per
 * (old primary → new primary) pair, for the {@link REPORT_TOP_PAIRS} largest
 * pairs, and `[backfillPostLanguages] language change sample` for the first
 * {@link REPORT_SAMPLES_PER_PAIR} posts (lowest ids, so the same corpus always
 * yields the same sample) of the {@link REPORT_SAMPLED_PAIRS} largest. A sample
 * carries the first {@link EXCERPT_LENGTH} characters of the primary body; post
 * ids go through the logger's redaction like everywhere else, so a sample is
 * found again by its excerpt. `∅` stands for "no language".
 *
 * ## The live run is paced for a SHARED database
 *
 * `oxy-postgres` serves every Oxy app, and an unpaced bulk write has stalled all
 * of them before. Writes are grouped into transactions of {@link
 * DEFAULT_WRITE_BATCH_SIZE} rows (one commit per group rather than per post),
 * each under `lock_timeout` / `statement_timeout`, so a write that would queue
 * behind a lock gives up instead of piling up. The rate is held at or below
 * `BACKFILL_ROWS_PER_SECOND` (default {@link DEFAULT_ROWS_PER_SECOND}) with at
 * least `BACKFILL_PAUSE_MS` between groups; a group that hits a timeout is
 * retried with exponential backoff, and a group that keeps failing stops the run
 * (exit non-zero) rather than pressing on against a struggling database.
 *
 * Rows are written one statement each inside the group's transaction rather
 * than as one multi-row `UPDATE … FROM (VALUES …)`: rows differ in which
 * columns they carry (a restamp writes scores, a language-only change does not)
 * and `updatePostRecord` is the one place that maps a classification patch onto
 * columns. The rate bound, not the statement count, is what protects the
 * instance.
 *
 * ## Resuming
 *
 * A live run records its position in `admin_script_cursors` after every page
 * whose writes have all committed (scope `all` or `gaps`), and the next live run
 * resumes after it. The position cannot be logged — the logger redacts post ids
 * under every key — so it is read back with
 * `select cursor, scanned, completed_at from admin_script_cursors where script = 'backfillPostLanguages'`.
 * `START_AFTER_ID=<id>` overrides it; `RESET_CURSOR=true` starts over. A resume
 * re-scans at most one page, whose already-written rows are unchanged and skipped.
 *
 * Runnable as a Fargate one-shot post-deploy (the live run also needs
 * `CONFIRM_ADMIN_MUTATION=backfillPostLanguages`):
 *   bun packages/backend/dist/src/scripts/backfillPostLanguages.js --dry-run [--all]
 *   bun packages/backend/dist/src/scripts/backfillPostLanguages.js [--all]
 * Pacing env (all optional): BACKFILL_ROWS_PER_SECOND, BACKFILL_WRITE_BATCH_SIZE,
 * BACKFILL_PAUSE_MS, BACKFILL_LOCK_TIMEOUT_MS, BACKFILL_STATEMENT_TIMEOUT_MS;
 * cursor env: START_AFTER_ID, RESET_CURSOR.
 */

import { isLiveEntityId } from '@oxy.so/db';
import { and, asc, gt, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { getRemoteHost } from '../connectors/shared/url';
import { connectPostgres, getDb, type Transaction } from '../db/postgres';
import type { PostRecord } from '../db/posts/postRecord';
import {
  findPostRecords,
  replacePostContent,
  updatePostRecord,
  type PostRecordPatch,
} from '../db/posts/postRepository';
import { posts } from '../db/schema/posts';
import {
  baselineContentClassifier,
  BASELINE_CLASSIFIER_VERSION,
  type LanguageSource,
} from '../services/BaselineContentClassifier';
import { invalidate as invalidatePostDetailCache } from '../services/postDetailCache';
import {
  applyDetectedPrimaryTag,
  declaredBaseLanguages,
  resolveVariant,
} from '../services/postVariants';
import { logger } from '../utils/logger';
import { assertAdminRunComplete, closeAdminScriptResources } from './lib/adminScriptLifecycle';
import {
  clearAdminScriptCursor,
  readAdminScriptCursor,
  recordAdminScriptCursor,
} from './lib/adminScriptCursor';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'backfillPostLanguages';

/** Posts scanned per page (stable ascending `id` cursor pagination). */
const DEFAULT_PAGE_SIZE = 500;
/** Rows per write transaction. */
export const DEFAULT_WRITE_BATCH_SIZE = 100;
/** Upper bound on rows written per second across the run. */
export const DEFAULT_ROWS_PER_SECOND = 200;
/** Minimum pause between write transactions, whatever the rate allows. */
export const DEFAULT_PAUSE_MS = 100;
/** A write that would wait longer than this for a row lock gives up. */
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
/** No single statement of a write transaction may run longer than this. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
/** Attempts per write transaction before the run stops. */
const MAX_WRITE_ATTEMPTS = 5;
/** First backoff after a timed-out write; doubles per attempt. */
const BACKOFF_BASE_MS = 1_000;

/** Pairs listed in the dry-run report. */
export const REPORT_TOP_PAIRS = 30;
/** Pairs, largest first, that get samples. */
export const REPORT_SAMPLED_PAIRS = 10;
/** Samples kept per pair. */
export const REPORT_SAMPLES_PER_PAIR = 5;
/** Characters of the primary body shown in a sample. */
export const EXCERPT_LENGTH = 80;
/** How "no language" is spelled in a pair. */
export const NO_LANGUAGE = '∅';
/**
 * Every cross-language pair (a language replaced by ANOTHER language) at least
 * this large is sampled, whatever its rank: those are the rows where a wrong
 * rule does the most damage per row.
 */
export const REPORT_CROSS_PAIR_MIN_COUNT = 500;

export interface LanguageChangeSample {
  postId: string;
  excerpt: string;
}

export interface LanguageChangePair {
  from: string;
  to: string;
  count: number;
  /** Of `count`, rows whose primary rendition tag changes too. */
  retagged: number;
  /** Lowest-id rows of the pair, up to {@link REPORT_SAMPLES_PER_PAIR}. */
  samples: LanguageChangeSample[];
}

/** How empty rows would be filled, by where the new language came from. */
export type LanguageFillSources = Record<LanguageSource, number>;

export interface BackfillPostLanguagesResult {
  scanned: number;
  updated: number;
  /** Of `updated`, the rows whose primary rendition was (or would be) re-tagged. */
  retagged: number;
  failed: number;
  /** Pages whose resume cursor could not be recorded (live runs with a scope). */
  cursorWriteFailures: number;
  /** The last id whose page was fully processed (and, live, committed). */
  lastId: string | null;
  /**
   * The (old → new primary language) pairs, largest first, capped at
   * {@link REPORT_TOP_PAIRS}; only the {@link REPORT_SAMPLED_PAIRS} largest keep
   * their samples.
   */
  pairs: LanguageChangePair[];
  /**
   * Every pair replacing one language with ANOTHER (both non-empty) of at least
   * {@link REPORT_CROSS_PAIR_MIN_COUNT} rows, largest first, with samples.
   */
  crossPairs: LanguageChangePair[];
  /** Rows going from no language to one, by the source of the new language. */
  fills: LanguageFillSources;
}

export interface BackfillPacing {
  rowsPerSecond: number;
  writeBatchSize: number;
  pauseMs: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  /** Injectable for tests; real time otherwise. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface BackfillPostLanguagesOptions {
  batchSize?: number;
  dryRun?: boolean;
  all?: boolean;
  /** Resume strictly after this id (exclusive). Wins over a stored cursor. */
  startAfterId?: string;
  /**
   * Read and record progress in `admin_script_cursors` under this scope (live
   * runs only). Off unless given, so an in-process caller never resumes by
   * accident from a cursor somebody else's run left.
   */
  cursorScope?: string;
  /** Forget the stored cursor first. */
  resetCursor?: boolean;
  pacing?: Partial<BackfillPacing>;
}

/**
 * How long to wait after a write transaction so the run stays at or below
 * `rowsPerSecond`, and never less than `pauseMs`.
 */
export function paceDelayMs(
  rowsWritten: number,
  elapsedMs: number,
  pacing: Pick<BackfillPacing, 'rowsPerSecond' | 'pauseMs'>,
): number {
  const budgetMs = pacing.rowsPerSecond > 0 ? (rowsWritten * 1000) / pacing.rowsPerSecond : 0;
  return Math.max(pacing.pauseMs, Math.ceil(budgetMs - elapsedMs));
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

const sameList = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  (a ?? []).length === b.length && b.every((value, index) => a?.[index] === value);

/** One row's re-derived state, decided before anything is written. */
interface PostLanguagePlan {
  post: PostRecord;
  text: string;
  from: string;
  to: string;
  source: LanguageSource;
  patch: PostRecordPatch;
  /** The re-tagged renditions, or `null` when the tag already agrees. */
  retagged: PostRecord['content']['variants'] | null;
}

/** Re-derive one post. `null` when there is nothing to write. */
async function planPost(post: PostRecord): Promise<PostLanguagePlan | null> {
  const classification = post.postClassification;
  // The PRIMARY rendition — the author's own words. Detecting a language from a
  // machine translation would just re-derive the language we asked the
  // translator for.
  const text = resolveVariant(post.content).text;
  // A boost or a media-only post has no words to derive a language from, and
  // stamping a version on it would only make its column-default scores look
  // computed. Left exactly as it is.
  if (text.trim().length === 0) return null;
  const signals = await baselineContentClassifier.classify({
    text,
    hashtags: post.hashtags,
    languages: declaredBaseLanguages(post.content),
    // A row already classified under the CURRENT ruleset carries its languages
    // like a declaration: a different detector replaces them only on strong
    // evidence. An older stamp is not trusted that far (see the docblock).
    previousLanguages:
      classification?.version === BASELINE_CLASSIFIER_VERSION
        ? classification.languages
        : undefined,
    sensitive: post.federation?.sensitive ?? post.metadata.isSensitive,
    isFederated: post.federation != null,
    // The author's instance host, read exactly as ingest reads it.
    instanceDomain: post.federation?.actorUri ? getRemoteHost(post.federation.actorUri) : undefined,
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
  if (unchanged) return null;

  return {
    post,
    text,
    from: classification?.languages?.[0] ?? NO_LANGUAGE,
    to: primaryLanguage ?? NO_LANGUAGE,
    source: signals.languageSource,
    patch: {
      postClassification: {
        languages: signals.languages,
        // Written alongside the languages because this update also stamps
        // `version`: a row claiming the current baseline version while missing
        // a field that version defines is worse than an un-backfilled row, since
        // the version is exactly what readers use to decide whether to trust the
        // classification.
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
    },
    retagged: retag ? reconciled : null,
  };
}

/**
 * Tallies (old → new primary) pairs and keeps the first samples of each.
 * Pages arrive in ascending id order, so "first" is "lowest id" and the sample
 * is the same on every run over the same corpus.
 */
export class LanguageChangeReport {
  private readonly pairs = new Map<string, LanguageChangePair>();
  private readonly fillSources: LanguageFillSources = {
    declared: 0,
    detected: 0,
    script: 0,
    previous: 0,
    none: 0,
  };

  add(plan: {
    postId: string;
    text: string;
    from: string;
    to: string;
    source: LanguageSource;
    retagged: boolean;
  }): void {
    const key = `${plan.from}→${plan.to}`;
    let pair = this.pairs.get(key);
    if (!pair) {
      pair = { from: plan.from, to: plan.to, count: 0, retagged: 0, samples: [] };
      this.pairs.set(key, pair);
    }
    pair.count += 1;
    if (plan.retagged) pair.retagged += 1;
    if (plan.from === NO_LANGUAGE && plan.to !== NO_LANGUAGE) this.fillSources[plan.source] += 1;
    if (pair.samples.length < REPORT_SAMPLES_PER_PAIR) {
      pair.samples.push({
        postId: plan.postId,
        excerpt: plan.text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_LENGTH),
      });
    }
  }

  private sorted(): LanguageChangePair[] {
    return [...this.pairs.values()].sort(
      (a, b) => b.count - a.count || `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`),
    );
  }

  /** Largest first (ties by pair name, so the order is stable), capped. */
  top(): LanguageChangePair[] {
    return this.sorted()
      .slice(0, REPORT_TOP_PAIRS)
      .map((pair, index) => (index < REPORT_SAMPLED_PAIRS ? pair : { ...pair, samples: [] }));
  }

  /** Every large pair that replaces one language with another, with samples. */
  crossPairs(): LanguageChangePair[] {
    return this.sorted().filter(
      (pair) =>
        pair.from !== NO_LANGUAGE &&
        pair.to !== NO_LANGUAGE &&
        pair.from !== pair.to &&
        pair.count >= REPORT_CROSS_PAIR_MIN_COUNT,
    );
  }

  fills(): LanguageFillSources {
    return { ...this.fillSources };
  }
}

function logSamples(pair: LanguageChangePair): void {
  for (const sample of pair.samples) {
    logger.info(`[${SCRIPT_NAME}] language change sample`, {
      from: pair.from,
      to: pair.to,
      // Redacted by the logger's id policy; the excerpt is what finds the post.
      postId: sample.postId,
      excerpt: sample.excerpt,
    });
  }
}

function logReport(
  pairs: readonly LanguageChangePair[],
  crossPairs: readonly LanguageChangePair[],
  fills: LanguageFillSources,
): void {
  for (const [rank, pair] of pairs.entries()) {
    logger.info(`[${SCRIPT_NAME}] language change`, {
      rank: rank + 1,
      from: pair.from,
      to: pair.to,
      count: pair.count,
      retagged: pair.retagged,
    });
    logSamples(pair);
  }
  const sampledAbove = new Set(
    pairs.filter((pair) => pair.samples.length > 0).map((pair) => `${pair.from}→${pair.to}`),
  );
  for (const pair of crossPairs) {
    logger.info(`[${SCRIPT_NAME}] cross-language change`, {
      from: pair.from,
      to: pair.to,
      count: pair.count,
      retagged: pair.retagged,
    });
    if (!sampledAbove.has(`${pair.from}→${pair.to}`)) logSamples(pair);
  }
  // `counts` keeps its numbers through the logger's redaction (a count map).
  logger.info(`[${SCRIPT_NAME}] language fills by source`, { counts: fills });
}

/** Lock or statement timeout: the database asked us to back off. */
function isBackoffError(error: unknown): boolean {
  const codeOf = (value: unknown): unknown =>
    value && typeof value === 'object' ? (value as { code?: unknown }).code : undefined;
  const cause =
    error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
  return [codeOf(error), codeOf(cause)].some(
    (code) => code === '55P03' || code === '57014' || code === '40001' || code === '40P01',
  );
}

/** Write one group of plans in ONE transaction under the pacing timeouts. */
async function writeGroup(
  plans: readonly PostLanguagePlan[],
  pacing: BackfillPacing,
): Promise<void> {
  await getDb().transaction(async (tx: Transaction) => {
    await tx.execute(
      sql`select set_config('lock_timeout', ${String(pacing.lockTimeoutMs)}, true),
                 set_config('statement_timeout', ${String(pacing.statementTimeoutMs)}, true)`,
    );
    for (const plan of plans) {
      await updatePostRecord(plan.post.id, plan.patch, tx);
      if (plan.retagged) {
        await replacePostContent(
          plan.post.id,
          { ...plan.post.content, variants: plan.retagged },
          plan.post.mentions,
          tx,
        );
      }
    }
  });
  // The repository invalidated inside the transaction; a reader in between
  // could have re-cached the old row, so invalidate again now it is committed.
  await Promise.all(plans.map((plan) => invalidatePostDetailCache(plan.post.id)));
}

function parseStartAfter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  if (!isLiveEntityId(trimmed)) {
    // Never degrade a malformed bound into a full rescan that looks like success.
    throw new Error('START_AFTER_ID must be a 24-character hex ObjectId or a uuid v7');
  }
  return trimmed;
}

/**
 * Re-classify and backfill languages over the qualifying corpus. The caller owns
 * the connection lifecycle, so this is reusable from an in-process caller.
 */
export async function backfillPostLanguages(
  opts: BackfillPostLanguagesOptions = {},
): Promise<BackfillPostLanguagesResult> {
  const pageSize = opts.batchSize ?? DEFAULT_PAGE_SIZE;
  const dryRun = opts.dryRun ?? false;
  const pacing: BackfillPacing = {
    rowsPerSecond: DEFAULT_ROWS_PER_SECOND,
    writeBatchSize: DEFAULT_WRITE_BATCH_SIZE,
    pauseMs: DEFAULT_PAUSE_MS,
    lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
    ...opts.pacing,
  };
  const sleep =
    pacing.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = pacing.now ?? Date.now;

  // Posts whose canonical multi-language array is absent/empty, or that were
  // classified before the current baseline version. Setting the array + version
  // removes a post from this filter, so the ascending `_id` cursor never revisits
  // a completed post and a re-run only fills remaining gaps.
  // A NULL `classification_version` is one of the qualifying states and must be
  // spelled out: `version < N` is NULL for an unstamped row, and a NULL predicate
  // excludes the row — so the literal translation would silently skip exactly the
  // posts that were never classified at all.
  //
  // `all` re-derives EVERY post instead: the detector changed within v11 (see
  // `BASELINE_CLASSIFIER_VERSION`), so a post it once labelled wrongly — Catalan
  // read as `fr` — carries a non-empty array no version filter can find. Only
  // the rows whose result actually changes are written.
  const baseFilter = opts.all
    ? undefined
    : (or(
        isNull(posts.classificationLanguages),
        sql`cardinality(${posts.classificationLanguages}) = 0`,
        isNull(posts.classificationVersion),
        lt(posts.classificationVersion, BASELINE_CLASSIFIER_VERSION),
        primaryTagDisagrees,
      ) as SQL);

  // Where to start: an explicit id wins, then (live only) the stored cursor.
  const cursorScope = dryRun ? undefined : opts.cursorScope;
  if (cursorScope && opts.resetCursor) await clearAdminScriptCursor(SCRIPT_NAME, cursorScope);
  const stored =
    cursorScope && !opts.resetCursor ? await readAdminScriptCursor(SCRIPT_NAME, cursorScope) : null;
  const explicitStart = parseStartAfter(opts.startAfterId);
  let lastId: string | null = explicitStart ?? stored?.cursor ?? null;
  const scannedBefore = explicitStart ? 0 : (stored?.scanned ?? 0);
  logger.info(`[${SCRIPT_NAME}] starting`, {
    dryRun,
    all: Boolean(opts.all),
    resumed: lastId !== null,
    resumedFrom: explicitStart ? 'START_AFTER_ID' : stored ? 'stored cursor' : 'beginning',
    scopeCompletedEarlier: Boolean(stored?.completedAt),
    rowsPerSecond: pacing.rowsPerSecond,
    writeBatchSize: pacing.writeBatchSize,
  });

  const report = new LanguageChangeReport();
  let scanned = 0;
  let updated = 0;
  let retagged = 0;
  let failed = 0;
  let cursorWriteFailures = 0;

  for (;;) {
    const page = await findPostRecords(
      lastId ? and(baseFilter, gt(posts.id, lastId)) : baseFilter,
      { orderBy: [asc(posts.id)], limit: pageSize },
    );

    if (page.length === 0) break;

    const plans: PostLanguagePlan[] = [];
    for (const post of page) {
      scanned += 1;
      try {
        const plan = await planPost(post);
        if (!plan) continue;
        plans.push(plan);
        report.add({
          postId: post.id,
          text: plan.text,
          from: plan.from,
          to: plan.to,
          source: plan.source,
          retagged: plan.retagged !== null,
        });
        updated += 1;
        if (plan.retagged) retagged += 1;
      } catch (error) {
        failed += 1;
        logger.warn(`[${SCRIPT_NAME}] classify failed for post; skipping`, {
          id: post.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    if (!dryRun) {
      for (let start = 0; start < plans.length; start += pacing.writeBatchSize) {
        const group = plans.slice(start, start + pacing.writeBatchSize);
        const startedAt = now();
        for (let attempt = 1; ; attempt += 1) {
          try {
            await writeGroup(group, pacing);
            break;
          } catch (error) {
            if (!isBackoffError(error) || attempt >= MAX_WRITE_ATTEMPTS) throw error;
            const backoffMs = BACKOFF_BASE_MS * 2 ** (attempt - 1);
            logger.warn(`[${SCRIPT_NAME}] write timed out; backing off`, { attempt, backoffMs });
            await sleep(backoffMs);
          }
        }
        await sleep(paceDelayMs(group.length, now() - startedAt, pacing));
      }
    }

    // Every write of this page has committed, so this is a safe resume point.
    lastId = page[page.length - 1].id;
    if (cursorScope) {
      const recorded = await recordAdminScriptCursor(SCRIPT_NAME, cursorScope, {
        cursor: lastId,
        scanned: scannedBefore + scanned,
      });
      // A miss is logged by the helper and fails the run at the end, so a run
      // whose position never persisted cannot report itself resumable.
      if (!recorded) cursorWriteFailures += 1;
    }
    logger.info(
      `[${SCRIPT_NAME}] progress: scanned ${scanned}, updated ${updated} (retagged ${retagged}), failed ${failed}`,
    );
  }

  if (cursorScope && lastId) {
    const recorded = await recordAdminScriptCursor(SCRIPT_NAME, cursorScope, {
      cursor: lastId,
      scanned: scannedBefore + scanned,
      completed: true,
    });
    if (!recorded) cursorWriteFailures += 1;
  }

  const pairs = report.top();
  const crossPairs = report.crossPairs();
  const fills = report.fills();
  if (dryRun) logReport(pairs, crossPairs, fills);
  return {
    scanned,
    updated,
    retagged,
    failed,
    cursorWriteFailures,
    lastId,
    pairs,
    crossPairs,
    fills,
  };
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  // `DRY_RUN=true` is how the ECS one-shot runner asks for a preview.
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
  // `--all` (or `ALL_POSTS=true` from the one-shot runner): re-derive every post.
  const all = process.argv.includes('--all') || process.env.ALL_POSTS === 'true';

  try {
    assertAdminMutationAllowed({
      scriptName: SCRIPT_NAME,
      dryRun,
    });
    const pacing: Partial<BackfillPacing> = {};
    const rowsPerSecond = envNumber('BACKFILL_ROWS_PER_SECOND');
    const writeBatchSize = envNumber('BACKFILL_WRITE_BATCH_SIZE');
    const pauseMs = envNumber('BACKFILL_PAUSE_MS');
    const lockTimeoutMs = envNumber('BACKFILL_LOCK_TIMEOUT_MS');
    const statementTimeoutMs = envNumber('BACKFILL_STATEMENT_TIMEOUT_MS');
    if (rowsPerSecond !== undefined) pacing.rowsPerSecond = rowsPerSecond;
    if (writeBatchSize !== undefined)
      pacing.writeBatchSize = Math.max(1, Math.floor(writeBatchSize));
    if (pauseMs !== undefined) pacing.pauseMs = pauseMs;
    if (lockTimeoutMs !== undefined) pacing.lockTimeoutMs = lockTimeoutMs;
    if (statementTimeoutMs !== undefined) pacing.statementTimeoutMs = statementTimeoutMs;

    await connectPostgres();

    const result = await backfillPostLanguages({
      dryRun,
      all,
      startAfterId: process.env.START_AFTER_ID,
      cursorScope: all ? 'all' : 'gaps',
      resetCursor: process.env.RESET_CURSOR === 'true',
      pacing,
    });

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[${SCRIPT_NAME}] done${dryRun ? ' (DRY_RUN — no writes)' : ''}: scanned ${result.scanned}, updated ${result.updated} (retagged ${result.retagged}), failed ${result.failed} (${elapsedSeconds}s)`,
    );

    assertAdminRunComplete(SCRIPT_NAME, {
      failed: result.failed,
      cursorWriteFailures: result.cursorWriteFailures,
    });
  } catch (error) {
    logger.error(`[${SCRIPT_NAME}] failed`, error);
    throw error;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error(`[${SCRIPT_NAME}] unhandled failure`, error);
      process.exit(1);
    });
}
