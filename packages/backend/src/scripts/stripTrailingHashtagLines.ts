/**
 * One-shot backfill: take the trailing hashtag lines out of bodies already
 * stored, now that `normalizePostHashtags` removes them on every write.
 *
 * Hashtags at the END of a post are filing, not prose: the reader never sees
 * them and the `hashtags` column carries them. Creation, edits and the federated
 * ingest apply that rule from now on, but a body is written once and nothing
 * revisits it. Measured on https://mention.earth/p/01a1a420-71b0-70c0-857e-1af23f3cd948,
 * stored as `…do this instead https://www.engadget.com/…\n\n#Apple`: the `#Apple`
 * line kept the link from being the last thing in the text, so the post showed
 * the link card AND the raw link.
 *
 * THE RULE IS NOT RESTATED HERE. Every rendition goes through
 * `stripHiddenHashtags` — the very function the native create/edit paths call,
 * which calls `normalizePostHashtags` — so this script and a fresh write cannot
 * disagree — including on the guard that never empties a post (a body of
 * nothing but hashtags stays as it is) and on leaving any line with a word,
 * emoji, mention or punctuation on it alone.
 *
 * SELECTION: every AUTHOR rendition, native and federated alike (the ingest
 * cleaned both with the older rule), whose body contains a `#`. A MACHINE
 * rendition is never read: a translation is regenerated from the primary.
 *
 * IT ALSO DROPS TRUNCATED TAG FRAGMENTS from the `hashtags` column. Before
 * 6329ab340 (2026-08-03) the extractor accepted only `[A-Za-z0-9_]`, so a tag
 * was cut at its first non-ASCII letter: `#Göttingen` stored a stray `g` next to
 * the `gottingen` the Note's `tag` array supplied (measured on
 * https://mention.earth/p/6a3a324868a43bdaaff95eb1). The extractor is fixed;
 * the rows are not. {@link truncatedHashtagFragments} names a stored tag a
 * fragment only when it is the ASCII prefix the old extractor cut from a tag the
 * post's own author text holds whole, and the current extractor does not find
 * it as a tag of its own anywhere in that text. It runs in the same pass because
 * the trailing-line strip removes exactly the text that proves a fragment.
 *
 * WHAT IT DOES NOT TOUCH, deliberately:
 *  - any other tag in the `hashtags` column — it already holds every tag the
 *    strip removes, since both writers derived it from the raw body;
 *  - `is_edited` / `edit_history` — the author did not edit anything;
 *  - federation — nothing is re-sent; remote copies already carry the tags in
 *    the Note's `tag` array, and a later author edit federates the clean body.
 * Only `post_content_variants.body` and the fragments in `posts.hashtags`
 * change, and each post's detail cache entry is evicted after the write commits,
 * as every content write does.
 *
 * PACE: `oxy-postgres` serves every Oxy app. Pages of {@link DEFAULT_PAGE_SIZE}
 * renditions by the variant id cursor; a page's writes go in ONE transaction
 * under `lock_timeout` / `statement_timeout` (a timed-out write backs off and is
 * retried, then stops the run), and at least `BACKFILL_PAUSE_MS` separates
 * pages, longer when needed to stay under `BACKFILL_ROWS_PER_SECOND`.
 *
 * RESUMING: a live run records its position in `admin_script_cursors`
 * (script `stripTrailingHashtagLines`, scope `all`) after every page whose writes
 * committed, and the next live run resumes after it — an ECS task killed by its
 * timeout or a Spot interruption simply runs again. `START_AFTER_ID=<id>`
 * overrides the stored cursor; `RESET_CURSOR=true` starts over. Every write is
 * guarded on the body it READ, so a concurrent edit is never overwritten and a
 * re-run over a cleaned body changes nothing.
 *
 * Runnable as a Fargate one-shot (dry run first):
 *   DRY_RUN=true bun packages/backend/dist/src/scripts/stripTrailingHashtagLines.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=stripTrailingHashtagLines \
 *     bun packages/backend/dist/src/scripts/stripTrailingHashtagLines.js
 *
 * Env:
 *   DATABASE_URL     the Postgres database (injected by ECS from SSM)
 *   DRY_RUN          defaults to `true`; only `=false` writes
 *   CONFIRM_ADMIN_MUTATION=stripTrailingHashtagLines  required for a real apply
 *   START_AFTER_ID, RESET_CURSOR  cursor control (live runs)
 *   SAMPLE_POST_IDS  comma-separated post ids always sampled (the measured posts)
 *   BACKFILL_PAGE_SIZE, BACKFILL_PAUSE_MS, BACKFILL_ROWS_PER_SECOND  pacing
 */

import { isLiveEntityId } from '@oxy.so/db';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { connectPostgres, getDb, type Transaction } from '../db/postgres';
import { postContentVariants } from '../db/schema/postContent';
import { posts } from '../db/schema/posts';
import { invalidate as invalidatePostDetailCache } from '../services/postDetailCache';
import { stripHiddenHashtags } from '../services/postVariants';
import { logger } from '../utils/logger';
import { extractHashtags, mergeHashtags } from '../utils/textProcessing';
import { assertAdminRunComplete, closeAdminScriptResources } from './lib/adminScriptLifecycle';
import {
  clearAdminScriptCursor,
  readAdminScriptCursor,
  recordAdminScriptCursor,
} from './lib/adminScriptCursor';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'stripTrailingHashtagLines';
const CURSOR_SCOPE = 'all';

export const DEFAULT_PAGE_SIZE = 500;
export const DEFAULT_PAUSE_MS = 250;
export const DEFAULT_ROWS_PER_SECOND = 200;
const LOCK_TIMEOUT_MS = 2_000;
const STATEMENT_TIMEOUT_MS = 10_000;
const MAX_WRITE_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;
/** Samples kept per kind, so the dry-run review sees each population. */
const SAMPLES_PER_KIND = 8;
const SAMPLE_LENGTH = 200;
/** Any letter outside Latin: the non-English sample the review must include. */
const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

export type SampleKind = 'named' | 'native' | 'federated' | 'non-latin';

/** What the pre-6329ab340 extractor kept of a tag: its leading ASCII run. */
const OLD_EXTRACTOR_PREFIX = /^[a-z0-9_]+/;

/**
 * The stored tags in `hashtags` that are fragments the pre-6329ab340 extractor
 * cut from a tag `text` holds whole: `g` for `#Göttingen`. A stored tag is one
 * only when BOTH hold —
 *  - it is the leading ASCII run of a tag the current extractor finds in `text`,
 *    and shorter than that tag (the old extractor stopped there);
 *  - the current extractor does not find it as a tag of its own in `text`.
 * Anything else — a tag the remote's `tag` array supplied, an ASCII-folded
 * spelling like `gottingen` — is not a prefix cut and is never named.
 */
export function truncatedHashtagFragments(text: string, hashtags: readonly string[]): string[] {
  const whole = new Set(mergeHashtags(text));
  const cut = new Set<string>();
  for (const tag of extractHashtags(text)) {
    const prefix = OLD_EXTRACTOR_PREFIX.exec(tag)?.[0];
    if (prefix && prefix !== tag && !whole.has(prefix)) cut.add(prefix);
  }
  return hashtags.filter((tag) => cut.has(tag));
}

export interface StripTrailingHashtagLinesOptions {
  dryRun?: boolean;
  /** Resume strictly after this variant id. Wins over a stored cursor. */
  startAfterId?: string;
  /**
   * Read and record progress in `admin_script_cursors` (live runs only). Off
   * unless asked, so an in-process caller never resumes from somebody else's run.
   */
  useCursor?: boolean;
  resetCursor?: boolean;
  pageSize?: number;
  pauseMs?: number;
  rowsPerSecond?: number;
  /** Posts always sampled, whatever the per-kind caps. */
  samplePostIds?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
}

export interface StripTrailingHashtagLinesResult {
  /** Author renditions containing a `#` that were read. */
  scanned: number;
  /** Of those, the bodies the rule changes. */
  changed: number;
  /** Rows Postgres REPORTED updating. Always 0 on a dry run. */
  written: number;
  /** Posts whose `hashtags` hold truncated fragments. */
  fragmentPosts: number;
  /** Of those, the posts Postgres REPORTED updating. Always 0 on a dry run. */
  fragmentPostsWritten: number;
  /** Pages whose resume cursor could not be recorded. */
  cursorWriteFailures: number;
  /**
   * Before/after samples, up to {@link SAMPLES_PER_KIND} per kind, each the
   * LAST {@link SAMPLE_LENGTH} characters (where the change is), `⏎` for a
   * line break.
   */
  samples: Array<{ kind: SampleKind; postId: string; before: string; after: string }>;
  /** Fragment removals, the first {@link SAMPLES_PER_KIND} plus every named post. */
  fragmentSamples: Array<{ postId: string; removed: string[]; kept: string[] }>;
}

interface PlannedWrite {
  id: string;
  postId: string;
  before: string;
  after: string;
}

interface PlannedTagWrite {
  postId: string;
  before: string[];
  after: string[];
}

/** Lock or statement timeout, serialization or deadlock: the database asked us to back off. */
function isBackoffError(error: unknown): boolean {
  const codeOf = (value: unknown): unknown =>
    value && typeof value === 'object' ? (value as { code?: unknown }).code : undefined;
  const cause =
    error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
  return [codeOf(error), codeOf(cause)].some(
    (code) => code === '55P03' || code === '57014' || code === '40001' || code === '40P01',
  );
}

/** One page's writes, in one transaction under the pacing timeouts. */
async function writePage(
  plans: readonly PlannedWrite[],
  tagPlans: readonly PlannedTagWrite[],
): Promise<{ written: number; tagsWritten: number }> {
  let written = 0;
  let tagsWritten = 0;
  await getDb().transaction(async (tx: Transaction) => {
    await tx.execute(
      sql`select set_config('lock_timeout', ${String(LOCK_TIMEOUT_MS)}, true),
                 set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`,
    );
    for (const plan of plans) {
      // Guarded on the body READ: a concurrent edit is not overwritten, and a
      // cleaned body matches nothing on a second run.
      const updated = await tx
        .update(postContentVariants)
        .set({ body: plan.after })
        .where(and(eq(postContentVariants.id, plan.id), eq(postContentVariants.body, plan.before)))
        .returning({ id: postContentVariants.id });
      written += updated.length;
    }
    for (const plan of tagPlans) {
      // Guarded on the column READ, for the same two reasons.
      const updated = await tx
        .update(posts)
        .set({ hashtags: plan.after })
        .where(
          and(
            eq(posts.id, plan.postId),
            sql`${posts.hashtags} = ${sql.param(plan.before)}::text[]`,
          ),
        )
        .returning({ id: posts.id });
      tagsWritten += updated.length;
    }
  });
  // Evicted after COMMIT, so a reader in between cannot re-cache the old row.
  const touched = new Set([...plans, ...tagPlans].map((plan) => plan.postId));
  await Promise.all([...touched].map(invalidatePostDetailCache));
  return { written, tagsWritten };
}

/** The end of a body, where the change is, with line breaks shown as `⏎`. */
function excerpt(body: string): string {
  return body.slice(-SAMPLE_LENGTH).replace(/\r?\n/g, ' ⏎ ');
}

function parseStartAfter(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (!isLiveEntityId(trimmed)) {
    // Never degrade a malformed bound into a full rescan that looks like success.
    throw new Error('START_AFTER_ID must be a 24-character hex ObjectId or a uuid v7');
  }
  return trimmed;
}

/** The sweep itself. The caller owns the connection lifecycle. */
export async function stripTrailingHashtagLines(
  opts: StripTrailingHashtagLinesOptions = {},
): Promise<StripTrailingHashtagLinesResult> {
  const dryRun = opts.dryRun ?? true;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS;
  const rowsPerSecond = opts.rowsPerSecond ?? DEFAULT_ROWS_PER_SECOND;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const db = getDb();

  const useCursor = !dryRun && opts.useCursor === true;
  if (useCursor && opts.resetCursor) await clearAdminScriptCursor(SCRIPT_NAME, CURSOR_SCOPE);
  const stored =
    useCursor && !opts.resetCursor ? await readAdminScriptCursor(SCRIPT_NAME, CURSOR_SCOPE) : null;
  const explicitStart = parseStartAfter(opts.startAfterId);
  let lastId: string | null = explicitStart ?? stored?.cursor ?? null;
  const scannedBefore = explicitStart ? 0 : (stored?.scanned ?? 0);
  logger.info(`[${SCRIPT_NAME}] starting`, {
    dryRun,
    resumedFrom: explicitStart ? 'START_AFTER_ID' : stored ? 'stored cursor' : 'beginning',
    pageSize,
    pauseMs,
    rowsPerSecond,
  });

  const result: StripTrailingHashtagLinesResult = {
    scanned: 0,
    changed: 0,
    written: 0,
    fragmentPosts: 0,
    fragmentPostsWritten: 0,
    cursorWriteFailures: 0,
    samples: [],
    fragmentSamples: [],
  };
  const named = new Set(opts.samplePostIds ?? []);

  for (;;) {
    const startedAt = Date.now();
    const rows = await db
      .select({
        id: postContentVariants.id,
        postId: postContentVariants.postId,
        body: postContentVariants.body,
        hashtags: posts.hashtags,
        isFederated: sql<boolean>`${posts.federationActorUri} is not null`,
        // Every author rendition of the post: a fragment is judged against all
        // of the author's words, never one rendition alone.
        authorText: sql<string>`(select string_agg(v.body, E'\n') from post_content_variants v
          where v.post_id = ${postContentVariants.postId} and v.source = 'author')`,
      })
      .from(postContentVariants)
      .innerJoin(posts, eq(posts.id, postContentVariants.postId))
      .where(
        and(
          eq(postContentVariants.source, 'author'),
          sql`strpos(${postContentVariants.body}, '#') > 0`,
          lastId ? gt(postContentVariants.id, lastId) : undefined,
        ),
      )
      .orderBy(asc(postContentVariants.id))
      .limit(pageSize);
    if (rows.length === 0) break;

    const plans: PlannedWrite[] = [];
    const tagPlans: PlannedTagWrite[] = [];
    // A post with several author renditions is read once per rendition; its
    // column is planned once per page (a later page reads the repaired column).
    const tagPlanned = new Set<string>();
    for (const row of rows) {
      const stored = row.hashtags ?? [];
      if (!tagPlanned.has(row.postId)) {
        tagPlanned.add(row.postId);
        const fragments = truncatedHashtagFragments(row.authorText ?? row.body, stored);
        if (fragments.length > 0) {
          const after = stored.filter((tag) => !fragments.includes(tag));
          tagPlans.push({ postId: row.postId, before: stored, after });
          if (result.fragmentSamples.length < SAMPLES_PER_KIND || named.has(row.postId)) {
            result.fragmentSamples.push({ postId: row.postId, removed: fragments, kept: after });
          }
        }
      }

      const [cleaned] = stripHiddenHashtags([{ source: 'author', text: row.body }]);
      const after = cleaned?.text ?? row.body;
      if (after === row.body) continue;
      plans.push({ id: row.id, postId: row.postId, before: row.body, after });
      const kind: SampleKind = named.has(row.postId)
        ? 'named'
        : NON_LATIN.test(row.body)
          ? 'non-latin'
          : row.isFederated
            ? 'federated'
            : 'native';
      if (
        kind === 'named' ||
        result.samples.filter((sample) => sample.kind === kind).length < SAMPLES_PER_KIND
      ) {
        result.samples.push({
          kind,
          postId: row.postId,
          before: excerpt(row.body),
          after: excerpt(after),
        });
      }
    }
    result.scanned += rows.length;
    result.changed += plans.length;
    result.fragmentPosts += tagPlans.length;

    if (!dryRun && plans.length + tagPlans.length > 0) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const page = await writePage(plans, tagPlans);
          result.written += page.written;
          result.fragmentPostsWritten += page.tagsWritten;
          break;
        } catch (error) {
          if (!isBackoffError(error) || attempt >= MAX_WRITE_ATTEMPTS) throw error;
          const backoffMs = BACKOFF_BASE_MS * 2 ** (attempt - 1);
          logger.warn(`[${SCRIPT_NAME}] write timed out; backing off`, { attempt, backoffMs });
          await sleep(backoffMs);
        }
      }
    }

    // Every write of this page has committed, so this is a safe resume point.
    lastId = rows[rows.length - 1].id;
    if (useCursor) {
      const recorded = await recordAdminScriptCursor(SCRIPT_NAME, CURSOR_SCOPE, {
        cursor: lastId,
        scanned: scannedBefore + result.scanned,
      });
      if (!recorded) result.cursorWriteFailures += 1;
    }
    logger.info(
      `[${SCRIPT_NAME}] progress: scanned ${result.scanned}, ${dryRun ? 'would change' : 'changed'} ${result.changed}, written ${result.written}, fragment posts ${result.fragmentPosts}`,
    );

    const writes = plans.length + tagPlans.length;
    const budgetMs = !dryRun && rowsPerSecond > 0 ? (writes * 1000) / rowsPerSecond : 0;
    await sleep(Math.max(pauseMs, Math.ceil(budgetMs - (Date.now() - startedAt))));
  }

  if (useCursor && lastId) {
    const recorded = await recordAdminScriptCursor(SCRIPT_NAME, CURSOR_SCOPE, {
      cursor: lastId,
      scanned: scannedBefore + result.scanned,
      completed: true,
    });
    if (!recorded) result.cursorWriteFailures += 1;
  }

  return result;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a non-negative number`);
  return value;
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN !== 'false';
  try {
    assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
    const pageSize = envNumber('BACKFILL_PAGE_SIZE');
    const pauseMs = envNumber('BACKFILL_PAUSE_MS');
    const rowsPerSecond = envNumber('BACKFILL_ROWS_PER_SECOND');
    await connectPostgres();

    const result = await stripTrailingHashtagLines({
      dryRun,
      useCursor: true,
      startAfterId: process.env.START_AFTER_ID,
      resetCursor: process.env.RESET_CURSOR === 'true',
      samplePostIds: (process.env.SAMPLE_POST_IDS ?? '')
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter((id) => id.length > 0),
      ...(pageSize !== undefined ? { pageSize: Math.max(1, Math.floor(pageSize)) } : {}),
      ...(pauseMs !== undefined ? { pauseMs } : {}),
      ...(rowsPerSecond !== undefined ? { rowsPerSecond } : {}),
    });

    for (const sample of result.samples) {
      // The post id goes through the logger's redaction like everywhere else;
      // the excerpt is what finds the post again.
      logger.info(`[${SCRIPT_NAME}] sample`, {
        kind: sample.kind,
        postId: sample.postId,
        before: sample.before,
        after: sample.after,
      });
    }
    for (const sample of result.fragmentSamples) {
      logger.info(`[${SCRIPT_NAME}] fragment sample`, {
        postId: sample.postId,
        removed: sample.removed,
        kept: sample.kept,
      });
    }
    logger.info(
      `[${SCRIPT_NAME}] done${dryRun ? ' (DRY_RUN — no writes)' : ''}: scanned ${result.scanned}, ${dryRun ? 'would change' : 'changed'} ${result.changed}, written ${result.written}, fragment posts ${result.fragmentPosts}, fragment posts written ${result.fragmentPostsWritten}`,
    );

    assertAdminRunComplete(SCRIPT_NAME, {
      cursorWriteFailures: result.cursorWriteFailures,
      // A body changed by the rule but not written was edited concurrently, or
      // the write path is broken; either way the run did not finish its work.
      unwritten: dryRun ? 0 : result.changed - result.written,
      unwrittenFragments: dryRun ? 0 : result.fragmentPosts - result.fragmentPostsWritten,
    });
  } finally {
    await closeAdminScriptResources();
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
