/**
 * Every index on `posts` is classified, exists, and is declared exactly as
 * written here.
 *
 * ## Why an index needs a test of its own
 *
 * An index is the one thing a functional test can never detect the absence of.
 * Drop `post_authorships_author_chrono_idx` and every profile-feed test in this
 * repository still passes: the same rows come back in the same order, and the
 * only difference is that the planner walks a chronological index over the whole
 * of `posts` probing `post_authorships` per candidate row — 84–99 ms and 42,394
 * probes for a page of 21 on an ordinary account, versus under a millisecond
 * (measured on 624k posts; `drizzle/0021_faithful_bloodstrike.sql` carries the
 * numbers). Nothing errors, nothing is wrong, the feed is just slow, and nobody
 * attributes it to the index that went missing three months earlier.
 *
 * Two realistic ways one goes missing, neither of them a deletion anybody
 * reviewed as such:
 *
 *   * a GENERATED column's expression changes, and `drizzle-kit generate` emits
 *     `DROP COLUMN` + `ADD COLUMN` — which takes every index over that column
 *     with it and re-emits none of them. `posts.geo` and `posts.content_geo` are
 *     generated and carry two of the indexes below;
 *   * an index is regenerated with drizzle's query-side default spelling, so it
 *     declares `DESC NULLS FIRST`. It exists, it is the right columns, and
 *     Postgres will not use it for the order the code asks for. That is the
 *     failure `chronoOrderPlan.test.ts` exists for, and this file is the half of
 *     it that names the index rather than iterating whatever happens to match.
 *
 * ## Why the map is EXHAUSTIVE over `posts`
 *
 * A gate that skips what is missing from a hand-maintained map is not a gate.
 * `everyPostsIndexIsClassified` asserts the catalogue's set of `posts` indexes
 * EQUALS this file's, so a new index that nobody classified fails the build and
 * a dropped one fails it too. That is the whole output of the #753 audit: not a
 * verdict frozen in a document, but a list that stops being true out loud.
 *
 * Each entry states what pays when it is gone, so a failure reads as an
 * instruction rather than a name — and, for the four indexes the audit narrowed
 * to partial, what makes the narrowing safe.
 *
 * ## Why the whole `indexdef`, and why by NAME
 *
 * The definition, because "an index called X exists" is satisfied by an index on
 * the wrong columns in the wrong order with the wrong NULLS placement — and,
 * since the audit, by one whose partial predicate has quietly widened or
 * narrowed. By name, because `chronoOrderPlan.test.ts` asserts a PROPERTY over
 * every `posts` index matching a pattern (`created_at desc`), and its vacuity
 * floor is a count: an index that disappears leaves that loop iterating nine
 * instead of ten and green either way. A property over a set and the membership
 * of that set are two claims.
 *
 * ## What this file deliberately does not do
 *
 * It runs no `EXPLAIN` against `posts`. Asserting a plan over that table asserts
 * the planner's CHOICE among two dozen candidate indexes, which moves with the
 * statistics every other file in a parallel run changes —
 * `chronoOrderPlan.test.ts` shipped that and it was flaky twice in eight runs.
 * The property asserted above is what the DDL DECLARES.
 *
 * The one plan assertion here is the last block, and it is the other shape: a
 * private single-index temp table, `on commit drop` inside one transaction,
 * where the planner has no choice to make and no other file can be writing rows.
 * It exists because migration 0026 made this file's `posts_classification_queue_idx`
 * entry a claim a declaration cannot carry — that a PARTIAL index is still
 * reachable by the queries it was cut for — and a declaration test alone would
 * pin the predicate while saying nothing about whether anything can still use it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';

/**
 * One index, its exact definition, and what pays when it is gone.
 *
 * The definition is the `pg_indexes.indexdef` a migrated database reports, minus
 * nothing — schema qualification, `USING btree`, and the normalised partial
 * predicate included, because a change to any of them is a change worth reading.
 */
interface ClassifiedIndex {
  name: string;
  table: string;
  /** What breaks — slowly, silently — if this index stops existing. */
  serves: string;
  definition: string;
}

/**
 * Every index on `posts`, classified. Order follows `db/schema/posts.ts`.
 *
 * Measured on 2026-08-15 against a private PostGIS 17 container seeded to 300k
 * posts (200k roots / 100k replies, 12k authors, production-shaped
 * distributions) — NOT production, and not the shared dev database. Sizes quoted
 * in `serves` are from that corpus and are proportional, not absolute.
 */
const POSTS_INDEXES: readonly ClassifiedIndex[] = [
  {
    name: 'posts_pkey',
    table: 'posts',
    serves: 'the primary key — every id lookup, and the target of five self-referencing foreign keys',
    definition: 'CREATE UNIQUE INDEX posts_pkey ON public.posts USING btree (id)',
  },
  {
    name: 'posts_federation_activity_id_key',
    table: 'posts',
    serves:
      'federation dedup — a CONSTRAINT, not a performance index: it is the only identity a remote ' +
      'instance guarantees for an activity, and dropping it duplicates every redelivered Announce',
    definition:
      'CREATE UNIQUE INDEX posts_federation_activity_id_key ON public.posts ' +
      'USING btree (federation_activity_id) WHERE (federation_activity_id IS NOT NULL)',
  },
  {
    name: 'post_public_chrono_v1',
    table: 'posts',
    serves:
      "every public chronological scan that does NOT fix `is_reply` — post search with no operators, " +
      "and the feed engine's `fetchChrono`. Reachability is not assumed: the negative control in this " +
      'file drives a query onto it and reads it back out of the plan',
    definition:
      'CREATE INDEX post_public_chrono_v1 ON public.posts ' +
      'USING btree (visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST)',
  },
  {
    name: 'posts_roots_chrono_idx',
    table: 'posts',
    serves:
      'the root feeds, which all fix `is_reply = false`. Its key columns are IDENTICAL to ' +
      '`post_public_chrono_v1` and it is still not redundant with it, in either direction: this one is ' +
      'the size of the root set and applies the filter the planner would otherwise re-check per row, ' +
      'and the full one serves the queries that carry no `is_reply` term at all',
    definition:
      'CREATE INDEX posts_roots_chrono_idx ON public.posts ' +
      'USING btree (visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST) ' +
      'WHERE (is_reply = false)',
  },
  {
    name: 'post_replies_chrono_v1',
    table: 'posts',
    serves: "a post's replies, newest- or oldest-first (the index is read backwards for ascending)",
    definition:
      'CREATE INDEX post_replies_chrono_v1 ON public.posts ' +
      'USING btree (parent_post_id, visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST)',
  },
  {
    name: 'post_links_chrono_v1',
    table: 'posts',
    serves:
      'search `has:links` (`routes/search.ts`) — the only query this index exists for, and the one that ' +
      'made it pure write amplification for as long as the query was spelled `desc()`',
    definition:
      'CREATE INDEX post_links_chrono_v1 ON public.posts ' +
      'USING btree (has_links, visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST)',
  },
  {
    name: 'posts_owner_chrono_idx',
    table: 'posts',
    serves:
      "the profile feed's owner branch (`fetchAuthored`, mtn/feed/engine/sources/userSources.ts) — the " +
      'denormalized owner reached chronologically, the cheaper of the two routes the `union` merges',
    definition:
      'CREATE INDEX posts_owner_chrono_idx ON public.posts ' +
      'USING btree (oxy_user_id, visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST)',
  },
  {
    name: 'posts_type_chrono_idx',
    table: 'posts',
    serves:
      'the GLOBAL media and videos feeds — `inArray(posts.type, [IMAGE, VIDEO])` in ' +
      '`utils/feedQueryBuilder.ts`, which is the one place a `type` predicate leads with no author term ' +
      'to send the planner somewhere cheaper',
    definition:
      'CREATE INDEX posts_type_chrono_idx ON public.posts ' +
      'USING btree (type, visibility, status, created_at DESC NULLS LAST)',
  },
  {
    name: 'posts_created_at_idx',
    table: 'posts',
    serves:
      'a chronological scan carrying no visibility/status term. It is the ONLY index on this table whose ' +
      'leading column is `created_at`, so nothing else can serve that shape — which is also why the ' +
      "audit's left-prefix rule does not condemn it despite being one column wide",
    definition: 'CREATE INDEX posts_created_at_idx ON public.posts USING btree (created_at DESC NULLS LAST)',
  },
  {
    name: 'posts_thread_idx',
    table: 'posts',
    serves:
      'the self-thread spine — `feed.controller.getSelfThreadContinuations` and `ThreadSlicingService`, ' +
      'both `eq(thread_id, X)`. NARROWED to partial by the #753 audit (23 MB → 2992 kB): ~90% of its ' +
      'entries were rows with a NULL `thread_id` that no query reaching it can return, and no predicate ' +
      'anywhere in the tree asks for that side',
    definition:
      'CREATE INDEX posts_thread_idx ON public.posts ' +
      'USING btree (thread_id, oxy_user_id, parent_post_id, created_at) WHERE (thread_id IS NOT NULL)',
  },
  {
    name: 'posts_boost_of_idx',
    table: 'posts',
    serves:
      '"who boosted this post" — `inArray(posts.boostOf, ids)` in the deletion cascade, engagement ' +
      'recompute and the AP inbox. KEPT FULL although `boost_of` is NULL on ~95% of rows: ' +
      '`notABoostSql()` is `isNull(posts.boostOf)` and runs on hot feed paths, so a partial index ' +
      'excluding NULLs would silently stop being available to them',
    definition:
      'CREATE INDEX posts_boost_of_idx ON public.posts USING btree (boost_of, created_at DESC NULLS LAST)',
  },
  {
    name: 'posts_one_boost_per_account_key',
    table: 'posts',
    serves:
      'one NATIVE boost per account per post — a CONSTRAINT. `federation_activity_id is null` in the ' +
      'predicate is load-bearing: widen it and a re-Announced remote boost 23505s inside the inbox ' +
      'worker, which retries forever',
    definition:
      'CREATE UNIQUE INDEX posts_one_boost_per_account_key ON public.posts USING btree (oxy_user_id, boost_of) ' +
      "WHERE ((type = 'boost'::text) AND (boost_of IS NOT NULL) AND (federation_activity_id IS NULL))",
  },
  {
    name: 'posts_quote_of_idx',
    table: 'posts',
    serves:
      'quotes of a given post. KEPT FULL for the same reason as `posts_boost_of_idx` — ' +
      '`scripts/backfillQuotedPosts.ts` spells `isNull(posts.quoteOf)`',
    definition:
      'CREATE INDEX posts_quote_of_idx ON public.posts USING btree (quote_of, created_at DESC NULLS LAST)',
  },
  {
    name: 'posts_scheduled_idx',
    table: 'posts',
    serves:
      'the site-wide scheduled SWEEP, which wants every due post regardless of owner. Partial, so it ' +
      'indexes a set that drains every 60 seconds rather than the table',
    definition:
      "CREATE INDEX posts_scheduled_idx ON public.posts USING btree (scheduled_for) WHERE (status = 'scheduled'::text)",
  },
  {
    name: 'post_owner_scheduled_v1',
    table: 'posts',
    serves:
      "ONE account's queue — `GET /posts/scheduled`. `posts_scheduled_idx` cannot serve it (wrong leading " +
      "column), which is why both exist: without this one a member's queue read costs a scan " +
      'proportional to how much everybody else has scheduled',
    definition:
      'CREATE INDEX post_owner_scheduled_v1 ON public.posts USING btree (oxy_user_id, scheduled_for) ' +
      "WHERE (status = 'scheduled'::text)",
  },
  {
    name: 'post_lane_chrono_v1',
    table: 'posts',
    serves: "the lane tab's keyset — `laneSource` pages ONE lane on `(created_at, id)`",
    definition:
      'CREATE INDEX post_lane_chrono_v1 ON public.posts ' +
      'USING btree (lane_id, visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST) ' +
      'WHERE (lane_id IS NOT NULL)',
  },
  {
    name: 'posts_hashtags_gin',
    table: 'posts',
    serves: 'hashtag feeds and `trendTermMatchSql` — an array overlap a btree cannot serve at all',
    definition: 'CREATE INDEX posts_hashtags_gin ON public.posts USING gin (hashtags)',
  },
  {
    name: 'posts_classification_topics_gin',
    table: 'posts',
    serves: 'topic-matched feed candidates and the trend term space',
    definition:
      'CREATE INDEX posts_classification_topics_gin ON public.posts USING gin (classification_topics)',
  },
  {
    name: 'posts_classification_languages_gin',
    table: 'posts',
    serves: "language-matched feed candidates and search's `language=` filter",
    definition:
      'CREATE INDEX posts_classification_languages_gin ON public.posts USING gin (classification_languages)',
  },
  {
    name: 'posts_classification_trend_terms_gin',
    table: 'posts',
    serves: '`trendTermMatchSql` — trend detection, trend feeds and excerpt lookup',
    definition:
      'CREATE INDEX posts_classification_trend_terms_gin ON public.posts USING gin (classification_trend_terms)',
  },
  {
    name: 'posts_classification_region_idx',
    table: 'posts',
    serves:
      'region-matched feed candidates (`forYouCandidateSources`, `relatedSources`). NARROWED to partial ' +
      'by the #753 audit (9264 kB → 2080 kB); the only predicates are `eq(classification_region, X)` and ' +
      'nothing asks for the unclassified side',
    definition:
      'CREATE INDEX posts_classification_region_idx ON public.posts ' +
      'USING btree (classification_region, created_at DESC NULLS LAST) WHERE (classification_region IS NOT NULL)',
  },
  {
    name: 'posts_classification_queue_idx',
    table: 'posts',
    serves:
      'the Stage-B classification queue, which drains oldest-first within one status. Ascending ' +
      '`created_at` on purpose — this is the one chronological index here that is not a feed keyset. ' +
      'NARROWED to the pending set by migration 0026 (11 MB → 296 kB on the seeded corpus, the queue ' +
      'drained), on the census below rather than on a recollection: every predicate on ' +
      "`classification_status` in this package selects `'pending'`, through ONE constant, and the #753 " +
      'audit had left this index full for want of exactly that evidence. The predicate is what makes ' +
      'it small and is also the whole risk — a predicate on any OTHER status falls off it silently, ' +
      'onto a sequential scan — so the census is what keeps the narrowing licensed, and the plan ' +
      'assertions below are what show the pending side still reaches it',
    definition:
      'CREATE INDEX posts_classification_queue_idx ON public.posts USING btree (classification_status, created_at) ' +
      "WHERE (classification_status = 'pending'::text)",
  },
  {
    name: 'posts_curated_idx',
    table: 'posts',
    serves:
      'curated posts, newest first. Partial, and NOT redundant with `posts_created_at_idx` despite the ' +
      'identical key: the total index is what a naive left-prefix rule would keep, and it is the one ' +
      'that cannot apply the `curated` filter',
    definition:
      'CREATE INDEX posts_curated_idx ON public.posts USING btree (created_at DESC NULLS LAST) WHERE (curated IS TRUE)',
  },
  {
    name: 'posts_geo_gist',
    table: 'posts',
    serves:
      '`ST_DWithin` on the post location — the `nearby` controller. NARROWED to partial by the #753 ' +
      'audit (20 MB → 488 kB, the single largest win): a GiST index indexes NULLs too, so the full form ' +
      'paid an insert on every ordinary post for an entry no proximity query can match',
    definition: 'CREATE INDEX posts_geo_gist ON public.posts USING gist (geo) WHERE (geo IS NOT NULL)',
  },
  {
    name: 'posts_content_geo_gist',
    table: 'posts',
    serves:
      '`ST_DWithin` on the content location. NARROWED with `posts_geo_gist` (19 MB → 264 kB); the ' +
      'controller ORs the two, which still plans as a `BitmapOr` over both partial indexes',
    definition:
      'CREATE INDEX posts_content_geo_gist ON public.posts USING gist (content_geo) WHERE (content_geo IS NOT NULL)',
  },
];

/**
 * Indexes on OTHER tables that a measured hot path depends on.
 *
 * Deliberately not exhaustive over their tables — the #753 audit's subject was
 * `posts`, and a map claiming completeness it has not measured would be worse
 * than one that says where its edge is. Widen it by auditing a table, not by
 * appending to this list.
 */
const OTHER_TABLE_INDEXES: readonly ClassifiedIndex[] = [
  {
    name: 'post_authorships_author_chrono_idx',
    table: 'post_authorships',
    serves:
      "the profile feed's authorship branch (`fetchAuthored`) — author, accepted, newest first, in one " +
      'index, which is why `post_created_at` is copied onto that table at all',
    definition:
      'CREATE INDEX post_authorships_author_chrono_idx ON public.post_authorships ' +
      'USING btree (oxy_user_id, status, post_created_at DESC NULLS LAST, post_id DESC NULLS LAST)',
  },
];

const ALL_INDEXES: readonly ClassifiedIndex[] = [...POSTS_INDEXES, ...OTHER_TABLE_INDEXES];

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** `pg_indexes.indexdef` for `name`, or null when no such index exists. */
async function indexDefinition(name: string): Promise<string | null> {
  const rows = await db.execute<{ indexdef: string }>(
    sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = ${name}`
  );
  return [...rows][0]?.indexdef ?? null;
}

/** Every index the catalogue holds for `table`. */
async function catalogueIndexNames(table: string): Promise<string[]> {
  const rows = await db.execute<{ indexname: string }>(
    sql`select indexname from pg_indexes where schemaname = 'public' and tablename = ${table} order by indexname`
  );
  return [...rows].map((row) => row.indexname);
}

describe('the indexes the measured hot paths are built on', () => {
  it('can read index definitions at all — the vacuity floor', async () => {
    /**
     * Every assertion below compares against a value read out of `pg_indexes`,
     * and a query that matched nothing would report every index missing — which
     * is a legible failure — but a query that matched nothing while the SET was
     * also empty is how a renamed catalogue view reads. So: the tables carry
     * indexes, plainly, before any of them is named.
     */
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_indexes
      where schemaname = 'public' and tablename in ('posts', 'post_authorships')
    `);
    expect([...rows][0]?.n ?? 0).toBeGreaterThanOrEqual(20);
  });

  it('reports an index that does not exist as absent — the negative control', async () => {
    // Without this, "the definition matched" is the only outcome the helper has
    // ever been observed to produce, and a helper that returned a definition for
    // every name would satisfy the whole file.
    await expect(indexDefinition('post_authorships_no_such_index')).resolves.toBeNull();
  });

  it.each(ALL_INDEXES)('$name exists, on $table', async ({ name, table, serves }) => {
    const definition = await indexDefinition(name);
    expect(definition, `${name} is missing — it serves ${serves}`).not.toBeNull();
    expect(definition).toContain(`ON public.${table} `);
  });

  it.each(ALL_INDEXES)('$name is declared exactly as the query reads it', async ({ name, definition }) => {
    /**
     * Three things ride on the exact text, and none has a functional symptom:
     * the NULLS placement (Postgres matches an index to an ORDER BY on it, so
     * drizzle's query-side default `DESC NULLS FIRST` is present, correct and
     * unusable), the column order, and — since the #753 audit — the partial
     * predicate. A predicate that widens costs the disk the audit recovered; one
     * that narrows makes the index unusable by the query it was cut for.
     */
    await expect(indexDefinition(name)).resolves.toBe(definition);
  });
});

describe('the classification of `posts` indexes is exhaustive', () => {
  it('classifies every index the catalogue holds, and holds every index it classifies', async () => {
    /**
     * The output of the #753 audit, expressed so it can stop being true.
     *
     * An equality, not two inclusions, because the two directions catch
     * different mistakes and both matter: an index in the catalogue and not here
     * is one nobody decided about — the exact state the audit found and resolved
     * — and one here but not in the catalogue is a migration that took a live
     * index with it. A `toContain` loop would pass in the first case, which is
     * the case the audit exists to prevent recurring.
     */
    const catalogued = await catalogueIndexNames('posts');
    const classified = POSTS_INDEXES.map((index) => index.name).sort();

    expect(catalogued.length, 'no indexes read back for `posts` — the catalogue query is broken')
      .toBeGreaterThanOrEqual(20);
    expect(
      catalogued,
      'An index on `posts` is unclassified, or one classified here is gone.\n' +
      'Add it to POSTS_INDEXES with its exact `pg_indexes.indexdef` and what pays when it is missing — ' +
      'or, if a migration removed it, delete its entry in the SAME change.\n' +
      'Do NOT relax this to a subset check: an index nobody decided about is what the #753 audit found.'
    ).toEqual(classified);
  });

  it('names each index exactly once', () => {
    // A duplicate entry would make the equality above pass while the count of
    // distinct classifications silently disagreed with the list's length.
    const names = ALL_INDEXES.map((index) => index.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 * `posts_classification_queue_idx`, settled — the census the #753 audit could
 * not perform to its own satisfaction.
 *
 * The audit narrowed four indexes to partial and recovered 65 MB. It left this
 * one (15 MB) full and said why: a partial index on
 * `classification_status = 'pending'` would make it tiny, but it could not rule
 * out a reader of the OTHER three statuses, and the failure mode of getting that
 * wrong is silent — a missing index has no functional symptom, it just gets slow
 * at a row count nobody can reproduce locally.
 *
 * Measured 2026-08-16, this is the whole surface of that column in this package:
 *
 *   PREDICATE  `services/PostClassificationService.ts` — ONE constant,
 *              `UNCLASSIFIED`, comparing the column to `'pending'`, used by
 *              `markEmptyPosts` (an UPDATE) and `classifyBatch` (the SELECT this
 *              index exists for, `order by created_at asc, id asc limit 25`).
 *   WRITE      `db/posts/postRepository.ts` (insert + patch values) and
 *              `PostClassificationService`'s `.set({ classificationStatus })`.
 *   PROJECTION `db/posts/postRepository.ts` (row → record) and
 *              `scripts/inspectTrendTerms.ts`.
 *
 * `'baseline'`, `'classified'` and `'failed'` are read ONLY from an
 * already-hydrated record — `services/contentClassification/trustedScores.ts`
 * and `services/ranking/signals/optIn.ts` both compare
 * `classification.status === 'classified'` in memory. Neither is a query and
 * neither can reach an index.
 *
 * Migration 0026 performed the narrowing on that evidence, and this census is
 * what keeps it safe rather than what justified it once: an occurrence of the
 * column that this file cannot MAP fails the build, so a second predicate cannot
 * arrive unnoticed and quietly find the index it needs no longer covers its
 * status. Read the failure that way — a new predicate on `'failed'` is not a
 * lint to be silenced here, it is a query that will silently sequential-scan
 * `posts` until this index is widened again. This lives beside the index's own
 * classification on purpose — they are two halves of one claim, and separating
 * them is how one goes stale while the other keeps passing.
 */
describe('the classification queue index is settled by a census, not by a memory', () => {
  /**
   * `src`, minus the two places an occurrence means nothing about queries.
   *
   * `__tests__` writes fixtures. `db/schema/` DECLARES the column and its CHECK
   * constraint — the constraint names every status by construction, which is
   * what a whole-table declaration does and is not a query. Everything else,
   * `scripts/` included, is in scope.
   */
  const SOURCE_ROOT = path.resolve(__dirname, '../..');
  const EXCLUDED_DIRS = new Set(['__tests__', 'node_modules', 'schema']);

  /** The column, as a query builder names it and as raw SQL would. */
  const OCCURRENCE = /classificationStatus|classification_status/;

  /** A comparison against the column — `eq(posts.classificationStatus, 'pending')` and every other shape. */
  const PREDICATE = /\b(\w+)\(\s*posts\.classificationStatus\s*,\s*([^)]*)\)/;
  /** `status: posts.classificationStatus` / `status: row.classificationStatus`. */
  const PROJECTION = /:\s*(?:posts|row)\.classificationStatus\b/;
  /** `classificationStatus: <value>` — an object key being ASSIGNED, never compared. */
  const WRITE = /\bclassificationStatus\s*:/;

  interface Occurrence {
    file: string;
    line: number;
    text: string;
  }

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (EXCLUDED_DIRS.has(name)) continue;
        out.push(...sourceFiles(full));
        continue;
      }
      if (name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  /**
   * Strip comments before counting.
   *
   * A comment quoting a predicate verbatim inflates a census, most dangerously
   * when it is written to CORRECT someone — and the prose above spells one out.
   */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  /** Every line of in-scope source naming the column, comments removed. */
  function occurrences(): Occurrence[] {
    const found: Occurrence[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((text, index) => {
        if (OCCURRENCE.test(text)) {
          found.push({ file: path.relative(SOURCE_ROOT, file), line: index + 1, text: text.trim() });
        }
      });
    }
    return found;
  }

  it('sees the column at all, in more than one file — the vacuity floor', () => {
    const found = occurrences();

    // A traversal that broke, or a pattern that stopped matching, reports the
    // same clean zero as an absent column — and a zero here would make every
    // assertion below vacuously true.
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(new Set(found.map((entry) => entry.file)).size).toBeGreaterThanOrEqual(2);
    expect(found.some((entry) => entry.file === 'services/PostClassificationService.ts')).toBe(true);
  });

  it('can tell a predicate on ANOTHER status apart — the positive control', () => {
    // The measurement below is "no predicate selects anything but 'pending'",
    // and that is also what a matcher which recognises nothing reports. So the
    // matcher is shown a predicate of exactly the shape it must catch.
    const synthetic = "const STUCK = eq(posts.classificationStatus, 'failed');";

    const match = PREDICATE.exec(synthetic);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('eq');
    expect(match?.[2]).toBe("'failed'");
    // And the same string must NOT be swallowed by the two benign classifiers.
    expect(PROJECTION.test(synthetic)).toBe(false);
    expect(WRITE.test(synthetic)).toBe(false);
  });

  it('maps every occurrence — an unmapped one is a shape nobody decided about', () => {
    const unmapped = occurrences().filter(
      (entry) =>
        !PREDICATE.test(entry.text) && !PROJECTION.test(entry.text) && !WRITE.test(entry.text),
    );

    expect(
      unmapped,
      'A `classification_status` reference this census cannot classify as a predicate, a projection '
      + 'or a write.\nIf it is a new PREDICATE, say which status it selects and re-decide '
      + '`posts_classification_queue_idx` above — a partial index on the pending set would not serve '
      + 'it.\nDo NOT widen the patterns to make it disappear.',
    ).toEqual([]);
  });

  it("compares the column only against 'pending', and only with `eq`", () => {
    const predicates = occurrences()
      .map((entry) => ({ entry, match: PREDICATE.exec(entry.text) }))
      .filter((row): row is { entry: Occurrence; match: RegExpExecArray } => row.match !== null);

    // Floor: the queue's own predicate exists. Without it, "every predicate
    // selects 'pending'" is true of a list with no predicates in it.
    expect(predicates.length).toBeGreaterThanOrEqual(1);

    expect(
      predicates.map(({ entry, match }) => `${entry.file}: ${match[1]}(…, ${match[2]})`),
      "Every predicate on `classification_status` must be `eq(…, 'pending')`.\n"
      + 'One that is not means the classification queue index cannot be narrowed to the pending set, '
      + 'and the entry for `posts_classification_queue_idx` above says the opposite.',
    ).toEqual(predicates.map(({ entry }) => `${entry.file}: eq(…, 'pending')`));
  });
});

/**
 * The pending queue still REACHES its index — and nothing else does.
 *
 * `WHERE classification_status = 'pending'` is a promise about what the index
 * contains, not about what the planner will do with it, and the two come apart
 * in the direction that has no symptom: a partial index the queries can no
 * longer use is a correct index nobody reads. `eq` is strict, so Postgres can
 * prove `classification_status = 'pending'` implies the predicate — which is a
 * reason to expect this to work, not a measurement that it does.
 *
 * Measured here on a probe table rather than on `posts`, for the reason the
 * header gives: with one index there is no CHOICE to attribute a result to, and
 * `on commit drop` inside a transaction keeps the whole thing invisible to the
 * files running in parallel. The probe carries no primary key on purpose — a
 * `posts_pkey` analogue would be a second index, and then "it used the partial
 * one" would be a preference rather than the only thing available.
 *
 * Both shapes are the ones `PostClassificationService` really issues, taken from
 * the statements postgres logged while the service ran, with the projection cut
 * to the columns the probe has: `classifyBatch`'s semi-join SELECT and
 * `markEmptyPosts`' anti-join UPDATE. On the seeded corpus (300k posts, 3%
 * pending) both stayed on the index — an Index Scan and a Bitmap Index Scan
 * respectively — while the negative control fell to a parallel sequential scan.
 */
describe('the narrowed queue index is still reachable by the queue, and only by it', () => {
  /** 3% of the probe's rows, matching the drained queue the seeded corpus modelled. */
  const PROBE_ROWS = 60_000;

  /** `classifyBatch`: the pending set, joined to its bodies, oldest first. */
  const PENDING_SELECT = `
    select id from queue_probe
    where classification_status = 'pending'
      and exists (select 1 from queue_probe_bodies where queue_probe_bodies.post_id = queue_probe.id)
      and status = 'published'
      and boost_of is null
    order by created_at asc, id asc
    limit 25`;

  /** `markEmptyPosts`: the pending rows with no body at all, flipped in one statement. */
  const PENDING_UPDATE = `
    update queue_probe set classification_status = 'classified'
    where classification_status = 'pending'
      and not exists (select 1 from queue_probe_bodies where queue_probe_bodies.post_id = queue_probe.id)`;

  /**
   * The negative control: `PENDING_SELECT` with the status changed to `'failed'`.
   *
   * `'failed'`, not `'classified'`, and that is the whole control rather than a
   * detail of it. Measured: with the probe's index widened back to TOTAL, a
   * `'classified'` predicate STILL plans as a sequential scan — `'classified'`
   * is 97% of the rows, so the planner would not use an index over it either
   * way, and the control passed against a total index. It measured selectivity
   * and reported it as coverage.
   *
   * `'failed'` is seeded at the same 3% as `'pending'`, so selectivity is held
   * constant and the only difference left between the two queries is whether
   * this index covers the status. Against a total index the control plans as a
   * Bitmap Index Scan and this test fails; against the partial one it falls to a
   * sequential scan, which is the cost the narrowing accepts and the census
   * upstream is what keeps nothing from paying it.
   */
  const FAILED_SELECT = PENDING_SELECT.replace("'pending'", "'failed'");

  /**
   * Plan every query against a private table carrying exactly ONE index, shaped
   * like `posts_classification_queue_idx` after migration 0026.
   */
  async function probePlans(queries: readonly string[]): Promise<string[]> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        create temp table queue_probe (
          id text not null,
          created_at timestamptz not null,
          classification_status text not null,
          status text not null,
          boost_of text
        ) on commit drop
      `);
      await tx.execute(sql`
        create temp table queue_probe_bodies (post_id text not null) on commit drop
      `);
      await tx.execute(sql`
        create index queue_probe_idx on queue_probe (classification_status, created_at)
        where classification_status = 'pending'
      `);
      await tx.execute(sql`
        insert into queue_probe
        select lpad(g::text, 24, '0'),
               now() - (g || ' seconds')::interval,
               case
                 when g % 100 < 3 then 'pending'
                 when g % 100 < 6 then 'failed'
                 else 'classified'
               end,
               'published',
               null
        from generate_series(1, ${sql.raw(String(PROBE_ROWS))}) g
      `);
      await tx.execute(sql`
        insert into queue_probe_bodies
        select lpad(g::text, 24, '0') from generate_series(1, ${sql.raw(String(PROBE_ROWS))}) g
        where g % 25 <> 0
      `);
      await tx.execute(sql`analyze queue_probe`);
      await tx.execute(sql`analyze queue_probe_bodies`);

      const plans: string[] = [];
      for (const query of queries) {
        const rows = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`explain (costs off) ${sql.raw(query)}`,
        );
        plans.push([...rows].map((row) => row['QUERY PLAN']).join('\n'));
      }
      return plans;
    });
  }

  it('plans the queue on the partial index, and an equally rare non-pending status off it', async () => {
    const [pendingSelect, pendingUpdate, failedSelect] = await probePlans([
      PENDING_SELECT,
      PENDING_UPDATE,
      FAILED_SELECT,
    ]);

    // `classifyBatch` — the query the index exists for.
    expect(pendingSelect, 'the pending SELECT no longer reaches the partial index').toContain(
      'queue_probe_idx',
    );
    // Anchored, and the anchor is the assertion: `queue_probe_bodies` is
    // sequentially scanned in every plan here, so a substring test for
    // `Seq Scan on queue_probe` matches whatever happens and a test for it with
    // a trailing space matches nothing at all — the plan ends that line.
    expect(pendingSelect).not.toMatch(/Seq Scan on queue_probe$/m);

    // `markEmptyPosts` — an UPDATE, which is the half a SELECT-only proof would
    // miss: it reaches the same rows through a different scan node.
    expect(pendingUpdate, 'the pending UPDATE no longer reaches the partial index').toContain(
      'queue_probe_idx',
    );

    // The control. A total index serves this one — measured — so its FALLING
    // OFF is the only observation in this file that distinguishes the narrowed
    // index from the index it replaced.
    expect(
      failedSelect,
      "a predicate on 'failed' reached the partial index — which an index restricted to the pending " +
      'set cannot serve, so this plan is measuring a WIDER index than the one 0026 created',
    ).not.toContain('queue_probe_idx');
    expect(failedSelect).toMatch(/Seq Scan on queue_probe$/m);
  });
});
